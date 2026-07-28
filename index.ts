import {createHash} from "node:crypto"
import {realpathSync} from "node:fs"
import path from "node:path"
import ts from "typescript"

// Default type annotation for function arguments
const DEFAULT_TYPE_ANNOTATION = "string"

export interface AnalyzeSourceOptions {
  fileName: string
  sourceText: string
  functionName: string
  functionPosition?: number
  typeText?: string
  declarationFile?: string
  declarationSession?: DeclarationAnalysisSession
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

export interface SourcePosition {
  line: number
  character: number
  offset: number
}

export interface SourceSpan {
  start: SourcePosition
  end: SourcePosition
}

export interface BaselineResult {
  edgeId: string
  edge: "baseline"
  location: SourceSpan
  probedTypes: Array<{name: string; type: string}>
  parentEdgeId: null
}

export interface EdgeResult {
  edgeId: string
  edge: "true" | "false"
  location: SourceSpan
  parentEdgeId: string
  classification: ParameterClassification
  parameters: ParameterResult[]
}

export interface BranchResult {
  line: number
  character: number
  condition: string
  baseline: BaselineResult
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

export type ParameterTypeOrigin =
  | "uniform-default"
  | "uniform-explicit"
  | "declaration"
  | "source-annotation"
  | "source-jsdoc"
  | "inferred"
  | "inferred-any"

export interface AnalysisInputParameter {
  name: string
  type: string
  origin: ParameterTypeOrigin
}

export interface MatchedDeclaration {
  fileName: string
  functionName: string
  line: number
  character: number
}

export interface AnalysisInput {
  kind: "uniform" | "declaration"
  contextId: string
  declarationFile?: string
  matchedDeclaration?: MatchedDeclaration
  parameters: AnalysisInputParameter[]
}

export interface AnalysisResult {
  fileName: string
  functionName: string
  typeText: string
  input: AnalysisInput
  branches: BranchResult[]
  diagnostics: AnalysisDiagnostic[]
  unsupported: UnsupportedConstruct[]
}

export interface AnalysisTableRow {
  edge_id: string
  edge: "baseline" | "true" | "false"
  classification: "" | ParameterClassification
  start_line: number
  start_col: number
  end_line: number
  end_col: number
  start_offset: number
  end_offset: number
  probed_types: string
  parent_edge_id: string
}

interface TextEdit {
  start: number
  end: number
  text: string
  order: number
}

interface ProbeMetadata {
  id: string
  edgeId: string
  location: SourceSpan
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

interface PlannedParameterType {
  expression?: string
  origin: ParameterTypeOrigin
  intentionalAny?: boolean
}

interface PlannedAnalysisInput {
  kind: "uniform" | "declaration"
  declarationFile?: string
  virtualDeclarationText?: string
  matchedDeclaration?: MatchedDeclaration
  parameters: PlannedParameterType[]
}

interface DeclarationIndex {
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
  externalModule: boolean
  functions: Map<string, ts.FunctionDeclaration[]>
}

export interface DeclarationAnalysisSession {
  readonly indexes: Map<string, unknown>
}

export function createDeclarationAnalysisSession(): DeclarationAnalysisSession {
  return {indexes: new Map()}
}

/**
 * Entry point.
 */
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
    declarationFile: options.declarationFile,
    declarationSession: options.declarationSession,
    compilerOptions: {
      ...configured.options,
      ...options.compilerOptions,
    },
  })
  // add diagnostics from parsing tsconfig.json
  result.diagnostics.unshift(...configured.diagnostics)
  return result
}

export function getAnalysisTableRows(result: AnalysisResult): AnalysisTableRow[] {
  return result.branches.flatMap(branch => [
    toAnalysisTableRow(
      branch.baseline.edgeId,
      branch.baseline.edge,
      "",
      branch.baseline.location,
      branch.baseline.probedTypes,
      branch.baseline.parentEdgeId,
    ),
    ...branch.edges.map(edge => toAnalysisTableRow(
      edge.edgeId,
      edge.edge,
      edge.classification,
      edge.location,
      edge.parameters.map(parameter => ({name: parameter.name, type: parameter.edgeType})),
      edge.parentEdgeId,
    )),
  ])
}

export function printAnalysisResult(result: AnalysisResult): void {
  const input = result.input.kind === "uniform"
    ? `T = ${result.typeText}`
    : `types from ${result.input.declarationFile}`
  console.log(`${result.fileName}:${result.functionName} (${input})`)
  if (result.input.kind === "declaration" && result.input.parameters.length > 0) {
    console.table(result.input.parameters.map(parameter => ({
      parameter: parameter.name,
      type: parameter.type,
      source: parameter.origin,
    })))
  }
  const rows = getAnalysisTableRows(result)
  if (rows.length > 0) {
    console.table(rows)
  } else {
    console.log("No supported branches analyzed.")
  }

  const lines: string[] = []
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
  if (lines.length > 0) {
    console.log(lines.join("\n"))
  }
}

/**
 * Each "baseline" branch gets its own row.
 *
 * For nested if conditions, the probed type could change *between*
 * the entry of the parent basic block (__probe_1) and the baseline
 * for the current branch (__probe_2). So it is not correct for an
 * edge to have another edge as its parent.
 * ```ts
 * if (typeof x === "number") {
 *   __probe_1(x)
 *   x = String(x)
 *   __probe_2(x)
 *   if (x === "") {}
 * }
 * ```
 */
function toAnalysisTableRow(
  edgeId: string,
  edge: "baseline" | "true" | "false",
  classification: "" | ParameterClassification,
  location: SourceSpan,
  probedTypes: Array<{name: string; type: string}>,
  parentEdgeId: string | null,
): AnalysisTableRow {
  const types = probedTypes
    .map(probe => `${probe.name}: ${probe.type}`)
    .join("; ")
    .replaceAll("\n", " ")
  return {
    edge_id: edgeId,
    edge,
    classification,
    start_line: location.start.line,
    start_col: location.start.character,
    end_line: location.end.line,
    end_col: location.end.character,
    start_offset: location.start.offset,
    end_offset: location.end.offset,
    probed_types: types,
    parent_edge_id: parentEdgeId ?? "",
  }
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

/**
 * Start analyzing a source file.
 * TODO: why do I not just read the file in here? instead of passing source text into it?
 */
export function analyzeSource(options: AnalyzeSourceOptions): AnalysisResult {
  const fileName = path.resolve(options.fileName)
  if (options.typeText !== undefined && options.declarationFile !== undefined) {
    throw new Error("typeText and declarationFile cannot be used together")
  }
  const typeText = options.typeText ?? DEFAULT_TYPE_ANNOTATION
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
    ...(options.declarationFile === undefined ? {} : {strictNullChecks: true}),
  }
  const originalSource = ts.createSourceFile(
    fileName,
    options.sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const target = findFunction(originalSource, options.functionName, options.functionPosition)
  const plannedInput = planAnalysisInput(
    fileName,
    target,
    options.typeText,
    options.declarationFile,
    options.declarationSession,
    compilerOptions,
    isJavaScript,
  )
  const unsupported: UnsupportedConstruct[] = []
  const edits: TextEdit[] = []
  const parameterNames = planParameterEdits(
    target,
    originalSource,
    plannedInput.parameters,
    isJavaScript,
    unsupported,
    edits,
  )

  if (parameterNames === undefined) {
    const originalProgram = createVirtualProgram(
      fileName,
      options.sourceText,
      compilerOptions,
      plannedInput.declarationFile === undefined ? [] : [plannedInput.declarationFile],
      virtualDeclarationFiles(plannedInput),
    )
    const programSource = originalProgram.getSourceFile(fileName)
    const input = programSource
      ? readAnalysisInput(
          plannedInput,
          findFunction(programSource, options.functionName, options.functionPosition),
          originalProgram.getTypeChecker(),
          fileName,
        )
      : emptyAnalysisInput(plannedInput, fileName, target)
    const diagnostics = programSource
      ? ts.getPreEmitDiagnostics(originalProgram, programSource).map(diagnostic =>
          formatDiagnostic(diagnostic, originalSource, [])
        )
      : []
    return {
      fileName,
      functionName: options.functionName,
      typeText: plannedInput.kind === "uniform" ? typeText : "TypeScript-defined",
      input,
      branches: [],
      diagnostics,
      unsupported,
    }
  }

  // Add underscores to the prefix if it already exists in the source.
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
  const program = createVirtualProgram(
    fileName,
    instrumentedText,
    compilerOptions,
    plannedInput.declarationFile === undefined ? [] : [plannedInput.declarationFile],
    virtualDeclarationFiles(plannedInput),
  )
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
  const input = readAnalysisInput(plannedInput, instrumentedTarget, checker, fileName)
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
    typeText: plannedInput.kind === "uniform" ? typeText : "TypeScript-defined",
    input,
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

function planAnalysisInput(
  fileName: string,
  target: ts.FunctionDeclaration,
  explicitTypeText: string | undefined,
  declarationFile: string | undefined,
  declarationSession: DeclarationAnalysisSession | undefined,
  compilerOptions: ts.CompilerOptions,
  isJavaScript: boolean,
): PlannedAnalysisInput {
  if (declarationFile === undefined) {
    const origin: ParameterTypeOrigin = explicitTypeText === undefined
      ? "uniform-default"
      : "uniform-explicit"
    return {
      kind: "uniform",
      parameters: target.parameters.map(() => ({
        expression: explicitTypeText ?? DEFAULT_TYPE_ANNOTATION,
        origin,
      })),
    }
  }

  if (!declarationFile.endsWith(".d.ts")) {
    throw new Error(`Declaration file must end with .d.ts: ${declarationFile}`)
  }
  let canonicalDeclaration: string
  try {
    canonicalDeclaration = realpathSync(path.resolve(declarationFile))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read declaration file ${path.resolve(declarationFile)}: ${message}`)
  }
  const declarationIndex = loadDeclarationIndex(
    canonicalDeclaration,
    compilerOptions,
    declarationSession,
  )
  const declarationSource = declarationIndex.sourceFile
  const externalModule = declarationIndex.externalModule
  const matches = declarationIndex.functions.get(target.name?.text ?? "") ?? []
  if (matches.length === 0) {
    return {
      kind: "declaration",
      declarationFile: canonicalDeclaration,
      parameters: target.parameters.map(parameter => ({
        origin: sourceParameterOrigin(parameter, isJavaScript),
      })),
    }
  }
  const declaration = matches[0]
  if (matches.some(match => match.parameters.length !== target.parameters.length)) {
    throw new Error(
      `Declaration ${target.name?.text} overload arity does not match the `
      + `${target.parameters.length}-parameter implementation`,
    )
  }
  if (matches.some(match =>
    match.parameters.some(parameter => parameter.dotDotDotToken !== undefined)
  )) {
    throw new Error(`Declaration ${target.name?.text} has an unsupported rest parameter`)
  }

  const moduleSpecifier = externalModule
    ? declarationModuleSpecifier(fileName, canonicalDeclaration)
    : undefined
  let virtualDeclarationText: string | undefined
  let parameters: PlannedParameterType[]
  if (matches.length === 1) {
    parameters = declaration.parameters.map((parameter, index): PlannedParameterType => {
      let expression: string
      if (moduleSpecifier !== undefined) {
        expression = `Parameters<typeof import(${JSON.stringify(moduleSpecifier)}).${target.name!.text}>[${index}]`
      } else {
        expression = declarationParameterTypeText(
          parameter,
          declarationSource,
          target.name!.text,
          index,
        )
      }
      return {
        expression,
        origin: "declaration",
        intentionalAny: declarationTypeIsAny(declarationIndex.checker, parameter),
      }
    })
  } else {
    const aliasPrefix = `__branch_reachability_${createHash("sha256")
      .update(`${fileName}:${target.getStart(target.getSourceFile())}:${target.name!.text}`)
      .digest("hex")
      .slice(0, 12)}`
    const aliases = target.parameters.map((_, index) => {
      const alternatives = [...new Set(matches.map(match => declarationParameterTypeText(
        match.parameters[index],
        declarationSource,
        target.name!.text,
        index,
      )))]
      const union = alternatives.map(alternative => `(${alternative})`).join(" | ")
      return `${externalModule ? "export " : ""}type ${aliasPrefix}_${index} = ${union}`
    })
    virtualDeclarationText = `${declarationSource.text}\n${aliases.join("\n")}\n`
    parameters = target.parameters.map((_, index) => ({
      expression: moduleSpecifier === undefined
        ? `${aliasPrefix}_${index}`
        : `import(${JSON.stringify(moduleSpecifier)}).${aliasPrefix}_${index}`,
      origin: "declaration",
      intentionalAny: matches.some(match =>
        declarationTypeIsAny(declarationIndex.checker, match.parameters[index])
      ),
    }))
  }
  const declarationLocation = locationOf(declarationSource, declaration)
  return {
    kind: "declaration",
    declarationFile: canonicalDeclaration,
    virtualDeclarationText,
    matchedDeclaration: {
      fileName: canonicalDeclaration,
      functionName: target.name!.text,
      ...declarationLocation,
    },
    parameters,
  }
}

function declarationTypeIsAny(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
): boolean {
  return parameter.type !== undefined
    && (checker.getTypeFromTypeNode(parameter.type).flags & ts.TypeFlags.Any) !== 0
}

function declarationParameterTypeText(
  parameter: ts.ParameterDeclaration,
  sourceFile: ts.SourceFile,
  functionName: string,
  index: number,
): string {
  if (!parameter.type) {
    throw new Error(`Declaration ${functionName} parameter ${index + 1} has no type`)
  }
  const declared = parameter.type.getText(sourceFile)
  return parameter.questionToken ? `(${declared}) | undefined` : declared
}

function loadDeclarationIndex(
  declarationFile: string,
  compilerOptions: ts.CompilerOptions,
  session: DeclarationAnalysisSession | undefined,
): DeclarationIndex {
  const cacheKey = `${declarationFile}\0${JSON.stringify(compilerOptions)}`
  const cached = session?.indexes.get(cacheKey)
  if (cached !== undefined) {
    return cached as DeclarationIndex
  }

  const program = ts.createProgram([declarationFile], {...compilerOptions, skipLibCheck: false})
  const sourceFile = program.getSourceFile(declarationFile)
  if (!sourceFile) {
    throw new Error(`TypeScript did not include declaration file ${declarationFile}`)
  }
  const declarationDiagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ]
  if (declarationDiagnostics.length > 0) {
    throw new Error(
      `Invalid declaration file ${declarationFile}: `
      + declarationDiagnostics.map(diagnostic =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
      ).join("; "),
    )
  }

  const externalModule = ts.isExternalModule(sourceFile)
  const functions = new Map<string, ts.FunctionDeclaration[]>()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isFunctionDeclaration(statement)
      || statement.body !== undefined
      || !statement.name
      || (externalModule && !hasExportModifier(statement))
    ) {
      continue
    }
    const matches = functions.get(statement.name.text) ?? []
    matches.push(statement)
    functions.set(statement.name.text, matches)
  }
  const index = {sourceFile, checker: program.getTypeChecker(), externalModule, functions}
  session?.indexes.set(cacheKey, index)
  return index
}

function hasExportModifier(node: ts.FunctionDeclaration): boolean {
  return ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function declarationModuleSpecifier(fileName: string, declarationFile: string): string {
  const relative = path.relative(path.dirname(fileName), declarationFile).replaceAll(path.sep, "/")
  return relative.startsWith(".") ? relative : `./${relative}`
}

function sourceParameterOrigin(
  parameter: ts.ParameterDeclaration,
  isJavaScript: boolean,
): ParameterTypeOrigin {
  if (parameter.type) {
    return "source-annotation"
  }
  if (
    isJavaScript
    && (ts.getJSDocType(parameter) !== undefined || ts.getJSDocParameterTags(parameter).length > 0)
  ) {
    return "source-jsdoc"
  }
  return "inferred"
}

function readAnalysisInput(
  planned: PlannedAnalysisInput,
  target: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
  fileName: string,
): AnalysisInput {
  const parameters = target.parameters.map((parameter, index): AnalysisInputParameter => {
    if (!ts.isIdentifier(parameter.name)) {
      return {
        name: parameter.name.getText(),
        type: "unknown",
        origin: planned.parameters[index]?.origin ?? "inferred",
      }
    }
    const type = checker.getTypeAtLocation(parameter.name)
    const originalOrigin = planned.parameters[index]?.origin ?? "inferred"
    if (
      originalOrigin === "declaration"
      && (type.flags & ts.TypeFlags.Any) !== 0
      && planned.parameters[index]?.intentionalAny !== true
    ) {
      throw new Error(
        `Declaration-backed type for parameter ${parameter.name.text} resolved to unexpected any`,
      )
    }
    return {
      name: parameter.name.text,
      type: checker.typeToString(
        type,
        parameter.name,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
      ),
      origin: originalOrigin === "inferred" && (type.flags & ts.TypeFlags.Any) !== 0
        ? "inferred-any"
        : originalOrigin,
    }
  })
  const functionPosition = target.getStart(target.getSourceFile())
  const contextHash = createHash("sha256")
    .update(`${path.resolve(fileName)}:${functionPosition}`)
    .update(JSON.stringify(parameters.map(parameter => parameter.type)))
    .digest("hex")
    .slice(0, 16)
  return {
    kind: planned.kind,
    contextId: `context_${contextHash}`,
    declarationFile: planned.declarationFile,
    matchedDeclaration: planned.matchedDeclaration,
    parameters,
  }
}

function emptyAnalysisInput(
  planned: PlannedAnalysisInput,
  fileName: string,
  target: ts.FunctionDeclaration,
): AnalysisInput {
  const parameters = target.parameters.map((parameter, index) => ({
    name: parameter.name.getText(),
    type: planned.parameters[index]?.expression ?? "unknown",
    origin: planned.parameters[index]?.origin ?? "inferred",
  }))
  const contextHash = createHash("sha256")
    .update(`${path.resolve(fileName)}:${target.getStart(target.getSourceFile())}`)
    .update(JSON.stringify(parameters.map(parameter => parameter.type)))
    .digest("hex")
    .slice(0, 16)
  return {
    kind: planned.kind,
    contextId: `context_${contextHash}`,
    declarationFile: planned.declarationFile,
    matchedDeclaration: planned.matchedDeclaration,
    parameters,
  }
}

function virtualDeclarationFiles(input: PlannedAnalysisInput): ReadonlyMap<string, string> {
  if (input.declarationFile === undefined || input.virtualDeclarationText === undefined) {
    return new Map()
  }
  return new Map([[input.declarationFile, input.virtualDeclarationText]])
}

function planParameterEdits(
  target: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  parameterTypes: readonly PlannedParameterType[],
  isJavaScript: boolean,
  unsupported: UnsupportedConstruct[],
  edits?: TextEdit[],
): string[] | undefined {
  if (parameterTypes.length !== target.parameters.length) {
    throw new Error(
      `Expected ${target.parameters.length} parameter types, received ${parameterTypes.length}`,
    )
  }
  const names: string[] = []

  for (const [index, parameter] of target.parameters.entries()) {
    const hasOptionalJSDoc = parameterTypes[index].expression !== undefined
      && isJavaScript && ts.getJSDocParameterTags(parameter).some(tag =>
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
    target.parameters.forEach((parameter, index) => {
      const typeExpression = parameterTypes[index].expression
      if (typeExpression === undefined) {
        return
      }
      const name = parameter.name as ts.Identifier
      if (isJavaScript) {
        edits.push({
          start: name.getStart(sourceFile),
          end: name.getStart(sourceFile),
          text: `/** @type {${typeExpression}} */ `,
          order: edits.length,
        })
      } else {
        const existingSuffix = parameter.type ?? parameter.questionToken
        edits.push({
          start: name.end,
          end: existingSuffix?.end ?? name.end,
          text: `: ${typeExpression}`,
          order: edits.length,
        })
      }
    })
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

  function makeProbe(
    edge: "baseline" | "true" | "false",
    start: number,
    end: number,
  ): {metadata: ProbeMetadata; statement: string} {
    const probe = {
      id: `${probeMarkerPrefix}${nextProbeId++}`,
      edgeId: makeEdgeId(sourceFile.fileName, edge, start, end),
      location: sourceSpan(sourceFile, start, end),
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
    const probe = makeProbe(
      "baseline",
      node.expression.getStart(sourceFile),
      node.expression.end,
    )
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
    edge: "true" | "false",
  ): ProbeMetadata {
    const probe = makeProbe(edge, statement.getStart(sourceFile), statement.end)
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
    const probe = makeProbe("false", node.end, node.end)
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
            probe: planExistingEdge(node.thenStatement, depth, 1, "true"),
          }, {
            edge: "false",
            probe: node.elseStatement
              ? planExistingEdge(node.elseStatement, depth, 2, "false")
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
  additionalRootNames: readonly string[] = [],
  additionalVirtualFiles: ReadonlyMap<string, string> = new Map(),
): ts.Program {
  const defaultHost = ts.createCompilerHost(compilerOptions, true)
  const virtualFiles = new Map<string, string>([
    [path.resolve(fileName), sourceText],
    ...[...additionalVirtualFiles].map(([candidate, text]) => [path.resolve(candidate), text] as const),
  ])
  const virtualText = (candidate: string) => virtualFiles.get(path.resolve(candidate))
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: candidate => virtualText(candidate) !== undefined || defaultHost.fileExists(candidate),
    readFile: candidate => virtualText(candidate) ?? defaultHost.readFile(candidate),
    getSourceFile: (candidate, languageVersion, onError, shouldCreateNewSourceFile) => {
      const text = virtualText(candidate)
      if (text !== undefined) {
        return ts.createSourceFile(
          candidate,
          text,
          languageVersion,
          true,
          scriptKindForFile(candidate),
        )
      }
      return defaultHost.getSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile)
    },
  }
  return ts.createProgram([fileName, ...additionalRootNames], compilerOptions, host)
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
        strings.set(
          name,
          checker.typeToString(
            type,
            element,
            ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
          ),
        )
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
    return {
      edgeId: probe.edgeId,
      edge,
      location: probe.location,
      parentEdgeId: branch.baseline.edgeId,
      classification,
      parameters,
    }
  })

  return {
    line: branch.line,
    character: branch.character,
    condition: branch.condition,
    baseline: {
      edgeId: branch.baseline.edgeId,
      edge: "baseline",
      location: branch.baseline.location,
      probedTypes: branch.baseline.parameterNames.map(name => ({
        name,
        type: baseline.strings.get(name)!,
      })),
      parentEdgeId: null,
    },
    edges,
  }
}

function makeEdgeId(
  fileName: string,
  edge: "baseline" | "true" | "false",
  start: number,
  end: number,
): string {
  const hash = createHash("sha256")
    .update(`${path.resolve(fileName)}:${start}:${end}:${edge}`)
    .digest("hex")
    .slice(0, 16)
  return `edge_${hash}`
}

function sourceSpan(sourceFile: ts.SourceFile, start: number, end: number): SourceSpan {
  const startLocation = sourceFile.getLineAndCharacterOfPosition(start)
  const endLocation = sourceFile.getLineAndCharacterOfPosition(end)
  return {
    start: {
      line: startLocation.line + 1,
      character: startLocation.character + 1,
      offset: start,
    },
    end: {
      line: endLocation.line + 1,
      character: endLocation.character + 1,
      offset: end,
    },
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
