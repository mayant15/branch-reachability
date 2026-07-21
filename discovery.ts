import {createRequire} from "node:module"
import path from "node:path"
import ts from "typescript"
import {
  analyzeFile,
  type AnalysisResult,
} from "./index.ts"

export interface AnalyzePackageExportOptions {
  packageName: string
  exportName: string
  typeText?: string
  compilerOptions?: ts.CompilerOptions
  maxDepth?: number
  maxFunctions?: number
}

export interface ExportResolutionStep {
  fileName: string
  exportName: string
  line: number
  character: number
  expression: string
}

export interface DiscoveredFunctionResult {
  id: string
  fileName: string
  functionName: string
  line: number
  character: number
  depth: number
  discoveredFrom?: string
  analysis: AnalysisResult
}

export interface UnresolvedCall {
  callerId: string
  fileName: string
  line: number
  character: number
  callee: string
  reason: string
}

export interface TruncatedFunction {
  callerId?: string
  fileName: string
  functionName: string
  line: number
  character: number
  reason: string
}

export interface PackageAnalysisResult {
  packageName: string
  exportName: string
  condition: "require"
  entryFile: string
  exportPath: ExportResolutionStep[]
  functions: DiscoveredFunctionResult[]
  unresolvedCalls: UnresolvedCall[]
  truncated: TruncatedFunction[]
}

interface FunctionTarget {
  declaration: ts.FunctionDeclaration
  sourceFile: ts.SourceFile
}

interface QueuedFunction extends FunctionTarget {
  depth: number
  discoveredFrom?: string
}

interface DirectCalls {
  targets: FunctionTarget[]
  unresolved: UnresolvedCall[]
}

export function analyzePackageExport(
  options: AnalyzePackageExportOptions,
): PackageAnalysisResult {
  const maxDepth = options.maxDepth ?? 3
  const maxFunctions = options.maxFunctions ?? 50
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error("maxDepth must be a non-negative integer")
  }
  if (!Number.isInteger(maxFunctions) || maxFunctions < 1) {
    throw new Error("maxFunctions must be a positive integer")
  }

  const packageRequire = createRequire(path.join(process.cwd(), "__branch_reachability__.cjs"))
  const entryFile = path.resolve(packageRequire.resolve(options.packageName))
  const program = ts.createProgram([entryFile], {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    maxNodeModuleJsDepth: 100,
  })
  const checker = program.getTypeChecker()
  const exportPath: ExportResolutionStep[] = []
  const target = resolveCommonJsExport(
    program,
    checker,
    entryFile,
    options.exportName,
    exportPath,
    new Set(),
  )
  const functions: DiscoveredFunctionResult[] = []
  const unresolvedCalls: UnresolvedCall[] = []
  const truncated: TruncatedFunction[] = []
  const visited = new Set<string>()
  const queued = new Set<string>([functionId(target)])
  const queue: QueuedFunction[] = [{...target, depth: 0}]

  while (queue.length > 0) {
    const current = queue.shift()!
    const id = functionId(current)
    queued.delete(id)
    if (visited.has(id)) {
      continue
    }
    if (functions.length >= maxFunctions) {
      truncated.push(describeTruncation(current, "maximum function count reached"))
      continue
    }
    visited.add(id)

    const functionName = current.declaration.name?.text
    if (!functionName) {
      truncated.push(describeTruncation(current, "anonymous functions are unsupported"))
      continue
    }
    const location = locationOf(current.sourceFile, current.declaration)
    const analysis = analyzeFile({
      fileName: current.sourceFile.fileName,
      functionName,
      functionPosition: current.declaration.getStart(current.sourceFile),
      typeText: options.typeText,
      compilerOptions: options.compilerOptions,
      tsconfig: false,
    })
    functions.push({
      id,
      fileName: current.sourceFile.fileName,
      functionName,
      ...location,
      depth: current.depth,
      discoveredFrom: current.discoveredFrom,
      analysis,
    })

    const directCalls = findDirectCalls(checker, current, id)
    unresolvedCalls.push(...directCalls.unresolved)
    for (const called of directCalls.targets) {
      const calledId = functionId(called)
      if (visited.has(calledId) || queued.has(calledId)) {
        continue
      }
      if (current.depth >= maxDepth) {
        truncated.push(describeTruncation(
          {...called, depth: current.depth + 1, discoveredFrom: id},
          "maximum traversal depth reached",
        ))
        continue
      }
      queued.add(calledId)
      queue.push({...called, depth: current.depth + 1, discoveredFrom: id})
    }
  }

  return {
    packageName: options.packageName,
    exportName: options.exportName,
    condition: "require",
    entryFile,
    exportPath,
    functions,
    unresolvedCalls,
    truncated,
  }
}

export function formatPackageAnalysisResult(result: PackageAnalysisResult): string {
  const lines = [
    `${result.packageName}.${result.exportName} (${result.condition})`,
    `Entry: ${result.entryFile}`,
    "Export resolution:",
  ]
  for (const step of result.exportPath) {
    lines.push(
      `  ${step.fileName}:${step.line}:${step.character} ${step.exportName} = ${step.expression}`,
    )
  }

  lines.push("", `Functions (${result.functions.length}):`)
  for (const discovered of result.functions) {
    const edges = discovered.analysis.branches.flatMap(branch => branch.edges)
    const unreachable = edges.filter(edge => edge.classification !== "reachable").length
    lines.push(
      `  depth ${discovered.depth} ${discovered.fileName}:${discovered.line}:${discovered.character}`
      + ` ${discovered.functionName} — ${discovered.analysis.branches.length} branches,`
      + ` ${unreachable}/${edges.length} unreachable edges,`
      + ` ${discovered.analysis.diagnostics.length} diagnostics,`
      + ` ${discovered.analysis.unsupported.length} unsupported`,
    )
  }
  lines.push(
    "",
    `Unresolved calls: ${result.unresolvedCalls.length}`,
    `Truncated functions: ${result.truncated.length}`,
  )
  return lines.join("\n")
}

function resolveCommonJsExport(
  program: ts.Program,
  checker: ts.TypeChecker,
  fileName: string,
  exportName: string,
  pathSteps: ExportResolutionStep[],
  visited: Set<string>,
): FunctionTarget {
  const canonicalFile = path.resolve(fileName)
  const key = `${canonicalFile}#${exportName}`
  if (visited.has(key)) {
    throw new Error(`CommonJS export cycle while resolving ${key}`)
  }
  visited.add(key)

  const sourceFile = program.getSourceFile(canonicalFile)
  if (!sourceFile) {
    throw new Error(`TypeScript program does not contain ${canonicalFile}`)
  }
  const requireBindings = collectRequireBindings(sourceFile)
  for (let index = sourceFile.statements.length - 1; index >= 0; index--) {
    const statement = sourceFile.statements[index]
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
      continue
    }
    const assignment = statement.expression
    if (
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
      || commonJsExportName(assignment.left) !== exportName
    ) {
      continue
    }
    const location = locationOf(sourceFile, statement)
    pathSteps.push({
      fileName: canonicalFile,
      exportName,
      ...location,
      expression: assignment.right.getText(sourceFile),
    })

    if (ts.isIdentifier(assignment.right)) {
      const target = functionTargetForSymbol(checker.getSymbolAtLocation(assignment.right))
      if (target) {
        return target
      }
    }
    if (
      ts.isPropertyAccessExpression(assignment.right)
      && ts.isIdentifier(assignment.right.expression)
    ) {
      const requiredModule = requireBindings.get(assignment.right.expression.text)
      if (requiredModule) {
        const resolved = createRequire(canonicalFile).resolve(requiredModule)
        return resolveCommonJsExport(
          program,
          checker,
          resolved,
          assignment.right.name.text,
          pathSteps,
          visited,
        )
      }
    }
    throw new Error(
      `Unsupported CommonJS export value ${assignment.right.getText(sourceFile)} in ${canonicalFile}`,
    )
  }
  throw new Error(`Could not find CommonJS export ${exportName} in ${canonicalFile}`)
}

function collectRequireBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.initializer
        && ts.isCallExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.expression)
        && declaration.initializer.expression.text === "require"
        && declaration.initializer.arguments.length === 1
        && ts.isStringLiteral(declaration.initializer.arguments[0])
      ) {
        bindings.set(declaration.name.text, declaration.initializer.arguments[0].text)
      }
    }
  }
  return bindings
}

function commonJsExportName(node: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(node)) {
    return undefined
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "exports") {
    return node.name.text
  }
  if (
    ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "module"
    && node.expression.name.text === "exports"
  ) {
    return node.name.text
  }
  return undefined
}

function findDirectCalls(
  checker: ts.TypeChecker,
  target: FunctionTarget,
  callerId: string,
): DirectCalls {
  const targets: FunctionTarget[] = []
  const unresolved: UnresolvedCall[] = []
  const targetIds = new Set<string>()

  function visit(node: ts.Node): void {
    if (node !== target.declaration && ts.isFunctionLike(node)) {
      return
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const called = functionTargetForSymbol(checker.getSymbolAtLocation(node.expression))
        if (called && called.sourceFile === target.sourceFile) {
          const id = functionId(called)
          if (!targetIds.has(id)) {
            targetIds.add(id)
            targets.push(called)
          }
        } else {
          unresolved.push(unresolvedCall(
            callerId,
            target.sourceFile,
            node.expression,
            called ? "call target is not a local function declaration" : "unresolved call target",
          ))
        }
      } else {
        unresolved.push(unresolvedCall(
          callerId,
          target.sourceFile,
          node.expression,
          "non-identifier call target",
        ))
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(target.declaration.body!)
  return {targets, unresolved}
}

function functionTargetForSymbol(symbol: ts.Symbol | undefined): FunctionTarget | undefined {
  if (!symbol) {
    return undefined
  }
  const declarations = symbol.declarations
  if (!declarations) {
    return undefined
  }
  for (let index = declarations.length - 1; index >= 0; index--) {
    const declaration = declarations[index]
    if (ts.isFunctionDeclaration(declaration) && declaration.body) {
      return {declaration, sourceFile: declaration.getSourceFile()}
    }
  }
  return undefined
}

function functionId(target: FunctionTarget): string {
  return `${path.resolve(target.sourceFile.fileName)}:${target.declaration.getStart(target.sourceFile)}`
}

function unresolvedCall(
  callerId: string,
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  reason: string,
): UnresolvedCall {
  return {
    callerId,
    fileName: sourceFile.fileName,
    ...locationOf(sourceFile, expression),
    callee: expression.getText(sourceFile),
    reason,
  }
}

function describeTruncation(target: QueuedFunction, reason: string): TruncatedFunction {
  return {
    callerId: target.discoveredFrom,
    fileName: target.sourceFile.fileName,
    functionName: target.declaration.name?.text ?? "<anonymous>",
    ...locationOf(target.sourceFile, target.declaration),
    reason,
  }
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): {line: number; character: number} {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {line: location.line + 1, character: location.character + 1}
}
