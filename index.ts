import path from "node:path"
import ts from "typescript"

export interface AnalyzeSourceOptions {
  fileName: string
  sourceText: string
  functionName: string
  functionPosition?: number
  typeText?: string
  compilerOptions?: ts.CompilerOptions
}

export interface AnalyzeFileOptions extends Omit<AnalyzeSourceOptions, "sourceText"> {
  tsconfig?: string | false
}

export type ParameterClassification =
  | "newly-unreachable"
  | "inherited-unreachable"
  | "reachable"

export interface ParameterResult {
  name: string
  baselineType: string
  edgeType: string
  classification: ParameterClassification
}

export interface EdgeResult {
  edge: "true" | "false"
  classification: ParameterClassification
  parameters: ParameterResult[]
}

export interface BranchResult {
  line: number
  character: number
  condition: string
  edges: EdgeResult[]
}

export interface AnalysisDiagnostic {
  category: string
  code: number
  message: string
  line?: number
  character?: number
  generated?: boolean
}

export interface UnsupportedConstruct {
  line: number
  character: number
  reason: string
}

export interface AnalysisResult {
  fileName: string
  functionName: string
  typeText: string
  branches: BranchResult[]
  diagnostics: AnalysisDiagnostic[]
  unsupported: UnsupportedConstruct[]
}

interface TextEdit {
  start: number
  end: number
  text: string
  order: number
}

interface ProbeMetadata {
  id: string
  parameterNames: string[]
}

interface PlannedEdge {
  edge: "true" | "false"
  probe: ProbeMetadata
}

interface PlannedBranch {
  line: number
  character: number
  condition: string
  baseline: ProbeMetadata
  edges: PlannedEdge[]
}

interface ProbeTypes {
  types: Map<string, ts.Type>
  strings: Map<string, string>
}

interface ReadProbesResult {
  probes: Map<string, ProbeTypes>
  invalidProbeIds: Set<string>
}

export function analyzeFile(options: AnalyzeFileOptions): AnalysisResult {
  const fileName = path.resolve(options.fileName)
  const sourceText = ts.sys.readFile(fileName)
  if (sourceText === undefined) {
    throw new Error(`Could not read ${fileName}`)
  }

  const configured = loadCompilerOptions(fileName, options.tsconfig)
  const result = analyzeSource({
    fileName,
    sourceText,
    functionName: options.functionName,
    functionPosition: options.functionPosition,
    typeText: options.typeText,
    compilerOptions: {
      ...configured.options,
      ...options.compilerOptions,
    },
  })
  result.diagnostics.unshift(...configured.diagnostics)
  return result
}

export function formatAnalysisResult(result: AnalysisResult): string {
  const lines = [
    `${result.fileName}:${result.functionName} (T = ${result.typeText})`,
  ]

  if (result.branches.length === 0) {
    lines.push("No supported branches analyzed.")
  } else {
    for (const branch of result.branches) {
      lines.push("", `${branch.line}:${branch.character} if (${branch.condition})`)
      for (const edge of branch.edges) {
        lines.push(`  ${edge.edge}: ${formatClassification(edge.classification)}`)
        for (const parameter of edge.parameters) {
          lines.push(
            `    ${parameter.name}: ${parameter.baselineType} -> ${parameter.edgeType}`
            + ` [${parameter.classification}]`,
          )
        }
      }
    }
  }

  if (result.unsupported.length > 0) {
    lines.push("", `Unsupported (${result.unsupported.length}):`)
    for (const unsupported of result.unsupported) {
      lines.push(`  ${unsupported.line}:${unsupported.character} ${unsupported.reason}`)
    }
  }

  if (result.diagnostics.length > 0) {
    lines.push("", `Diagnostics (${result.diagnostics.length}):`)
    for (const diagnostic of result.diagnostics) {
      const location = diagnostic.line === undefined
        ? ""
        : `${diagnostic.line}:${diagnostic.character ?? 1} `
      const generated = diagnostic.generated ? " [generated]" : ""
      lines.push(
        `  ${location}${diagnostic.category} TS${diagnostic.code}: ${diagnostic.message}${generated}`,
      )
    }
  }

  return lines.join("\n")
}

function formatClassification(classification: ParameterClassification): string {
  return classification.replaceAll("-", " ").toUpperCase()
}

function loadCompilerOptions(
  fileName: string,
  tsconfig: string | false | undefined,
): {options: ts.CompilerOptions; diagnostics: AnalysisDiagnostic[]} {
  if (tsconfig === false) {
    return {options: {}, diagnostics: []}
  }

  const configFileName = typeof tsconfig === "string"
    ? path.resolve(tsconfig)
    : ts.findConfigFile(path.dirname(fileName), ts.sys.fileExists)
  if (configFileName === undefined) {
    return {options: {}, diagnostics: []}
  }

  const readResult = ts.readConfigFile(configFileName, ts.sys.readFile)
  if (readResult.error) {
    return {options: {}, diagnostics: [formatUnmappedDiagnostic(readResult.error)]}
  }
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(configFileName),
    undefined,
    configFileName,
  )
  return {
    options: parsed.options,
    diagnostics: parsed.errors.map(formatUnmappedDiagnostic),
  }
}

export function analyzeSource(options: AnalyzeSourceOptions): AnalysisResult {
  const fileName = path.resolve(options.fileName)
  const typeText = options.typeText ?? "string"
  const scriptKind = scriptKindForFile(fileName)
  const isJavaScript = scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX
  const compilerOptions: ts.CompilerOptions = {
    strict: !isJavaScript,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    skipLibCheck: true,
    ...(scriptKind === ts.ScriptKind.JSX ? {jsx: ts.JsxEmit.Preserve} : {}),
    ...options.compilerOptions,
    ...(isJavaScript ? {allowJs: true, checkJs: true, noEmit: true} : {}),
  }
  const originalSource = ts.createSourceFile(
    fileName,
    options.sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const target = findFunction(originalSource, options.functionName, options.functionPosition)
  const unsupported: UnsupportedConstruct[] = []
  const edits: TextEdit[] = []
  const parameterNames = planParameterEdits(
    target,
    originalSource,
    typeText,
    isJavaScript,
    unsupported,
    edits,
  )

  if (parameterNames === undefined) {
    const originalProgram = createVirtualProgram(fileName, options.sourceText, compilerOptions)
    const programSource = originalProgram.getSourceFile(fileName)
    const diagnostics = programSource
      ? ts.getPreEmitDiagnostics(originalProgram, programSource).map(diagnostic =>
          formatDiagnostic(diagnostic, originalSource, [])
        )
      : []
    return {
      fileName,
      functionName: options.functionName,
      typeText,
      branches: [],
      diagnostics,
      unsupported,
    }
  }

  let probeMarkerPrefix = "__branch_reachability_probe_"
  while (options.sourceText.includes(probeMarkerPrefix)) {
    probeMarkerPrefix = `_${probeMarkerPrefix}`
  }
  const branches = planBranches(
    target,
    originalSource,
    parameterNames,
    probeMarkerPrefix,
    unsupported,
    edits,
  )
  const instrumentedText = applyEdits(options.sourceText, edits)
  const program = createVirtualProgram(fileName, instrumentedText, compilerOptions)
  const sourceFile = program.getSourceFile(fileName)
  if (sourceFile === undefined) {
    throw new Error(`TypeScript did not include virtual source ${fileName}`)
  }

  const checker = program.getTypeChecker()
  const instrumentedTarget = findFunction(
    sourceFile,
    options.functionName,
    options.functionPosition,
  )
  const parameterSymbols = new Map<string, ts.Symbol>()
  for (const parameter of instrumentedTarget.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      const symbol = checker.getSymbolAtLocation(parameter.name)
      if (symbol) {
        parameterSymbols.set(parameter.name.text, symbol)
      }
    }
  }
  const expectedProbeIds = new Set(
    branches.flatMap(branch => [branch.baseline.id, ...branch.edges.map(edge => edge.probe.id)]),
  )
  const {probes, invalidProbeIds} = readProbeTypes(
    sourceFile,
    checker,
    parameterNames,
    parameterSymbols,
    expectedProbeIds,
  )
  const branchResults: BranchResult[] = []
  for (const branch of branches) {
    const probeIds = [branch.baseline.id, ...branch.edges.map(edge => edge.probe.id)]
    if (probeIds.some(id => invalidProbeIds.has(id))) {
      unsupported.push({
        line: branch.line,
        character: branch.character,
        reason: "A parameter is shadowed at this branch, so its flow type cannot be probed safely",
      })
    } else {
      branchResults.push(classifyBranch(branch, probes))
    }
  }
  const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile).map(diagnostic =>
    formatDiagnostic(diagnostic, originalSource, edits)
  )

  return {
    fileName,
    functionName: options.functionName,
    typeText,
    branches: branchResults,
    diagnostics,
    unsupported,
  }
}

function findFunction(
  sourceFile: ts.SourceFile,
  functionName: string,
  functionPosition?: number,
): ts.FunctionDeclaration {
  const matches: ts.FunctionDeclaration[] = []

  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node)
      && node.name?.text === functionName
      && node.body
      && (functionPosition === undefined || node.getStart(sourceFile) === functionPosition)
    ) {
      matches.push(node)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  if (matches.length === 0) {
    throw new Error(`Could not find function declaration ${functionName}`)
  }
  if (matches.length > 1) {
    throw new Error(`Found multiple function declarations named ${functionName}`)
  }
  return matches[0]
}

function planParameterEdits(
  target: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  typeText: string,
  isJavaScript: boolean,
  unsupported: UnsupportedConstruct[],
  edits?: TextEdit[],
): string[] | undefined {
  const names: string[] = []

  for (const parameter of target.parameters) {
    const hasOptionalJSDoc = isJavaScript && ts.getJSDocParameterTags(parameter).some(tag =>
      tag.isBracketed
      || tag.typeExpression !== undefined
        && ts.isJSDocOptionalType(tag.typeExpression.type)
    )
    if (
      !ts.isIdentifier(parameter.name)
      || parameter.name.text === "this"
      || parameter.dotDotDotToken !== undefined
      || parameter.initializer !== undefined
      || parameter.modifiers !== undefined
      || hasOptionalJSDoc
    ) {
      unsupported.push({
        ...locationOf(sourceFile, parameter),
        reason: hasOptionalJSDoc
          ? "Optional JSDoc parameters cannot be overridden with exactly T"
          : "All parameters must be simple, non-rest identifiers without default initializers",
      })
      return undefined
    }
    names.push(parameter.name.text)
  }

  if (edits) {
    for (const parameter of target.parameters) {
      const name = parameter.name as ts.Identifier
      if (isJavaScript) {
        edits.push({
          start: name.getStart(sourceFile),
          end: name.getStart(sourceFile),
          text: `/** @type {${typeText}} */ `,
          order: edits.length,
        })
      } else {
        const existingSuffix = parameter.type ?? parameter.questionToken
        edits.push({
          start: name.end,
          end: existingSuffix?.end ?? name.end,
          text: `: ${typeText}`,
          order: edits.length,
        })
      }
    }
  }

  return names
}

function planBranches(
  target: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  parameterNames: string[],
  probeMarkerPrefix: string,
  unsupported: UnsupportedConstruct[],
  edits: TextEdit[],
): PlannedBranch[] {
  const branches: PlannedBranch[] = []
  let nextProbeId = 0

  function makeProbe(): {metadata: ProbeMetadata; statement: string} {
    const probe = {
      id: `${probeMarkerPrefix}${nextProbeId++}`,
      parameterNames,
    }
    const elements = [JSON.stringify(probe.id), ...parameterNames].join(", ")
    return {metadata: probe, statement: `void [${elements}];`}
  }

  function insert(position: number, text: string, order: number): void {
    edits.push({
      start: position,
      end: position,
      text,
      order,
    })
  }

  function startOrder(depth: number, role: number): number {
    return 200_000 + depth * 10 + role
  }

  function endOrder(depth: number, role: "edge" | "missing-else" | "statement"): number {
    const roleOrder = role === "edge" ? 0 : role === "missing-else" ? 1 : 2
    return 100_000 - depth * 10 + roleOrder
  }

  function isStatementListContainer(node: ts.Node): boolean {
    return ts.isBlock(node)
      || ts.isSourceFile(node)
      || ts.isModuleBlock(node)
      || ts.isCaseOrDefaultClause(node)
  }

  function wrappingChangesDeclarationScope(statement: ts.Statement): boolean {
    let found = false

    function visit(node: ts.Node): void {
      if (ts.isDeclarationStatement(node)) {
        found = true
        return
      }
      if (
        node !== statement
        && (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isFunctionLike(node))
      ) {
        return
      }
      ts.forEachChild(node, visit)
    }

    visit(statement)
    return found
  }

  function cannotWrapSafely(node: ts.IfStatement): boolean {
    return !isStatementListContainer(node.parent) && wrappingChangesDeclarationScope(node)
      || !ts.isBlock(node.thenStatement) && wrappingChangesDeclarationScope(node.thenStatement)
      || node.elseStatement !== undefined
        && !ts.isBlock(node.elseStatement)
        && wrappingChangesDeclarationScope(node.elseStatement)
  }

  function planBaseline(node: ts.IfStatement, depth: number): ProbeMetadata {
    const probe = makeProbe()
    if (isStatementListContainer(node.parent)) {
      insert(
        node.getStart(sourceFile),
        `\n${probe.statement}\n`,
        startOrder(depth, 0),
      )
    } else {
      insert(
        node.getStart(sourceFile),
        `{\n${probe.statement}\n`,
        startOrder(depth, 0),
      )
      insert(node.end, "\n}", endOrder(depth, "statement"))
    }
    return probe.metadata
  }

  function planExistingEdge(
    statement: ts.Statement,
    depth: number,
    role: number,
  ): ProbeMetadata {
    const probe = makeProbe()
    if (ts.isBlock(statement)) {
      insert(
        statement.getStart(sourceFile) + 1,
        `\n${probe.statement}\n`,
        startOrder(depth, role),
      )
    } else {
      insert(
        statement.getStart(sourceFile),
        `{\n${probe.statement}\n`,
        startOrder(depth, role),
      )
      insert(statement.end, "\n}", endOrder(depth, "edge"))
    }
    return probe.metadata
  }

  function planMissingElse(node: ts.IfStatement, depth: number): ProbeMetadata {
    const probe = makeProbe()
    insert(
      node.end,
      ` else {\n${probe.statement}\n}`,
      endOrder(depth, "missing-else"),
    )
    return probe.metadata
  }

  function visit(node: ts.Node, depth: number): void {
    if (node !== target && ts.isFunctionLike(node)) {
      return
    }

    if (ts.isIfStatement(node)) {
      if (cannotWrapSafely(node)) {
        unsupported.push({
          ...locationOf(sourceFile, node),
          reason: "Instrumenting this unbraced branch would change declaration scope",
        })
      } else {
        const position = locationOf(sourceFile, node)
        const planned: PlannedBranch = {
          ...position,
          condition: node.expression.getText(sourceFile),
          baseline: planBaseline(node, depth),
          edges: [{
            edge: "true",
            probe: planExistingEdge(node.thenStatement, depth, 1),
          }, {
            edge: "false",
            probe: node.elseStatement
              ? planExistingEdge(node.elseStatement, depth, 2)
              : planMissingElse(node, depth),
          }],
        }
        branches.push(planned)
      }
    }

    ts.forEachChild(node, child => visit(child, depth + 1))
  }

  visit(target.body!, 0)
  return branches
}

function applyEdits(sourceText: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((left, right) =>
    right.start - left.start || right.order - left.order
  )
  let result = sourceText
  for (const edit of ordered) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}

function createVirtualProgram(
  fileName: string,
  sourceText: string,
  compilerOptions: ts.CompilerOptions,
): ts.Program {
  const defaultHost = ts.createCompilerHost(compilerOptions, true)
  const isVirtualFile = (candidate: string) => path.resolve(candidate) === fileName
  const scriptKind = scriptKindForFile(fileName)
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: candidate => isVirtualFile(candidate) || defaultHost.fileExists(candidate),
    readFile: candidate => isVirtualFile(candidate) ? sourceText : defaultHost.readFile(candidate),
    getSourceFile: (candidate, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (isVirtualFile(candidate)) {
        return ts.createSourceFile(candidate, sourceText, languageVersion, true, scriptKind)
      }
      return defaultHost.getSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile)
    },
  }
  return ts.createProgram([fileName], compilerOptions, host)
}

function scriptKindForFile(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS
    case ".jsx":
      return ts.ScriptKind.JSX
    case ".tsx":
      return ts.ScriptKind.TSX
    default:
      return ts.ScriptKind.TS
  }
}

function readProbeTypes(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  parameterNames: string[],
  parameterSymbols: Map<string, ts.Symbol>,
  expectedProbeIds: Set<string>,
): ReadProbesResult {
  const probes = new Map<string, ProbeTypes>()
  const invalidProbeIds = new Set<string>()

  function visit(node: ts.Node): void {
    if (
      ts.isArrayLiteralExpression(node)
      && node.elements.length > 0
      && ts.isStringLiteral(node.elements[0])
      && expectedProbeIds.has(node.elements[0].text)
    ) {
      const id = node.elements[0].text
      if (probes.has(id)) {
        throw new Error(`Duplicate probe ${id}`)
      }
      const identifiers = node.elements.slice(1)
      if (
        identifiers.length !== parameterNames.length
        || identifiers.some((element, index) =>
          !ts.isIdentifier(element) || element.text !== parameterNames[index]
        )
      ) {
        throw new Error(`Malformed probe ${id}`)
      }

      const types = new Map<string, ts.Type>()
      const strings = new Map<string, string>()
      identifiers.forEach((element, index) => {
        const name = parameterNames[index]
        if (checker.getSymbolAtLocation(element) !== parameterSymbols.get(name)) {
          invalidProbeIds.add(id)
        }
        const type = checker.getTypeAtLocation(element)
        types.set(name, type)
        strings.set(name, checker.typeToString(type, element, ts.TypeFormatFlags.NoTruncation))
      })
      probes.set(id, {types, strings})
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return {probes, invalidProbeIds}
}

function classifyBranch(
  branch: PlannedBranch,
  probes: Map<string, ProbeTypes>,
): BranchResult {
  const baseline = requireProbe(probes, branch.baseline.id)
  const edges = branch.edges.map(({edge, probe}) => {
    const edgeTypes = requireProbe(probes, probe.id)
    const parameters = probe.parameterNames.map(name => {
      const baselineType = requireType(baseline.types, name, branch.baseline.id)
      const edgeType = requireType(edgeTypes.types, name, probe.id)
      const baselineNever = (baselineType.flags & ts.TypeFlags.Never) !== 0
      const edgeNever = (edgeType.flags & ts.TypeFlags.Never) !== 0
      const classification: ParameterClassification = baselineNever
        ? "inherited-unreachable"
        : edgeNever
          ? "newly-unreachable"
          : "reachable"
      return {
        name,
        baselineType: baseline.strings.get(name)!,
        edgeType: edgeTypes.strings.get(name)!,
        classification,
      }
    })
    const classification: ParameterClassification = parameters.some(
      parameter => parameter.classification === "newly-unreachable",
    )
      ? "newly-unreachable"
      : parameters.some(parameter => parameter.classification === "inherited-unreachable")
        ? "inherited-unreachable"
        : "reachable"
    return {edge, classification, parameters}
  })

  return {
    line: branch.line,
    character: branch.character,
    condition: branch.condition,
    edges,
  }
}

function requireProbe(probes: Map<string, ProbeTypes>, id: string): ProbeTypes {
  const probe = probes.get(id)
  if (!probe) {
    throw new Error(`Could not find probe ${id} in virtual source`)
  }
  return probe
}

function requireType(types: Map<string, ts.Type>, name: string, probeId: string): ts.Type {
  const type = types.get(name)
  if (!type) {
    throw new Error(`Probe ${probeId} has no type for ${name}`)
  }
  return type
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): {line: number; character: number} {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {line: location.line + 1, character: location.character + 1}
}

function formatDiagnostic(
  diagnostic: ts.Diagnostic,
  originalSource: ts.SourceFile,
  edits: TextEdit[],
): AnalysisDiagnostic {
  const result: AnalysisDiagnostic = {
    category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }
  if (diagnostic.file && diagnostic.start !== undefined) {
    const mapped = mapEditedPositionToOriginal(diagnostic.start, edits)
    const location = originalSource.getLineAndCharacterOfPosition(mapped.position)
    result.line = location.line + 1
    result.character = location.character + 1
    if (mapped.generated) {
      result.generated = true
    }
  }
  return result
}

function formatUnmappedDiagnostic(diagnostic: ts.Diagnostic): AnalysisDiagnostic {
  const result: AnalysisDiagnostic = {
    category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }
  if (diagnostic.file && diagnostic.start !== undefined) {
    const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    result.line = location.line + 1
    result.character = location.character + 1
  }
  return result
}

function mapEditedPositionToOriginal(
  position: number,
  edits: TextEdit[],
): {position: number; generated: boolean} {
  const ordered = [...edits].sort((left, right) =>
    left.start - right.start || left.order - right.order
  )
  let offset = 0

  for (const edit of ordered) {
    const generatedStart = edit.start + offset
    const generatedEnd = generatedStart + edit.text.length
    if (position < generatedStart) {
      break
    }
    if (position < generatedEnd) {
      return {position: edit.start, generated: true}
    }
    offset += edit.text.length - (edit.end - edit.start)
  }

  return {position: position - offset, generated: false}
}
