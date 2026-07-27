import {existsSync, readFileSync, realpathSync} from "node:fs"
import path from "node:path"
import {spawnSync} from "node:child_process"
import ts from "typescript"
import {analyzeFile, type AnalysisResult} from "./index.ts"

export interface AnalyzeLibraryOptions {
  entryFile: string
  libraryRoot?: string
  typeText?: string
  timeoutMs?: number
}

export interface ExcludedLibraryFile {
  fileName: string
  reason: string
}

export interface LibraryDiscoveryResult {
  status: "complete" | "entry-error" | "failed"
  error?: string
  stdout: string
  stderr: string
  files: string[]
  excludedFiles: ExcludedLibraryFile[]
}

export interface TopLevelFunction {
  id: string
  fileName: string
  functionName: string
  startOffset: number
  endOffset: number
  line: number
  character: number
}

interface AnalyzedLibraryFunction extends TopLevelFunction {
  status: "analyzed"
  analysis: AnalysisResult
}

interface FailedLibraryFunction extends TopLevelFunction {
  status: "failed"
  error: string
}

export type LibraryFunctionResult = AnalyzedLibraryFunction | FailedLibraryFunction

export interface LibraryFileResult {
  fileName: string
  functions: LibraryFunctionResult[]
  error?: string
}

export interface LibraryAnalysisSummary {
  files: number
  excludedFiles: number
  functions: number
  analyzedFunctions: number
  failedFunctions: number
  branches: number
  unreachableEdges: number
  diagnosticOccurrences: number
  unsupported: number
}

export interface LibraryAnalysisResult {
  entryFile: string
  libraryRoot: string
  typeText: string
  discovery: LibraryDiscoveryResult
  files: LibraryFileResult[]
  summary: LibraryAnalysisSummary
}

interface ChildPayload {
  files: string[]
  error: string | null
}

const discoveryProgram = String.raw`
const fs = require("node:fs")
const path = require("node:path")
const entryFile = path.resolve(process.argv[1])
const before = new Set(Object.keys(require.cache))
let error = null
try {
  require(entryFile)
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught)
}
const files = [
  entryFile,
  ...Object.keys(require.cache).filter(fileName => !before.has(fileName)),
]
fs.writeSync(3, JSON.stringify({files: [...new Set(files)], error}))
process.exit(0)
`

export function discoverLibraryFiles(
  entryFile: string,
  libraryRoot?: string,
  timeoutMs = 5_000,
): {entryFile: string; libraryRoot: string; discovery: LibraryDiscoveryResult} {
  const canonicalEntry = realpathSync(path.resolve(entryFile))
  const canonicalRoot = realpathSync(
    libraryRoot === undefined ? findLibraryRoot(canonicalEntry) : path.resolve(libraryRoot),
  )
  if (!isWithin(canonicalRoot, canonicalEntry)) {
    throw new Error(`Entry file ${canonicalEntry} is outside library root ${canonicalRoot}`)
  }

  const execution = spawnSync(
    process.execPath,
    ["-e", discoveryProgram, canonicalEntry],
    {
      cwd: canonicalRoot,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  )
  const protocolOutput = execution.output[3]
  let payload: ChildPayload | undefined
  if (typeof protocolOutput === "string" && protocolOutput.length > 0) {
    try {
      const parsed: unknown = JSON.parse(protocolOutput)
      if (isChildPayload(parsed)) {
        payload = parsed
      }
    } catch {
      // Report malformed output as a discovery failure below.
    }
  }

  if (payload === undefined) {
    const error = execution.error?.message
      ?? (execution.signal ? `Discovery child exited with ${execution.signal}` : undefined)
      ?? `Discovery child exited with status ${execution.status}`
    return {
      entryFile: canonicalEntry,
      libraryRoot: canonicalRoot,
      discovery: {
        status: "failed",
        error,
        stdout: execution.stdout ?? "",
        stderr: execution.stderr ?? "",
        files: [],
        excludedFiles: [],
      },
    }
  }

  const files: string[] = []
  const excludedFiles: ExcludedLibraryFile[] = []
  const seen = new Set<string>()
  for (const loadedFile of payload.files) {
    let canonicalFile: string
    try {
      canonicalFile = realpathSync(loadedFile)
    } catch {
      excludedFiles.push({fileName: path.resolve(loadedFile), reason: "file no longer exists"})
      continue
    }
    if (seen.has(canonicalFile)) {
      continue
    }
    seen.add(canonicalFile)
    const extension = path.extname(canonicalFile).toLowerCase()
    const relative = path.relative(canonicalRoot, canonicalFile)
    if (!isWithin(canonicalRoot, canonicalFile)) {
      excludedFiles.push({fileName: canonicalFile, reason: "outside library root"})
    } else if (relative.split(path.sep).includes("node_modules")) {
      excludedFiles.push({fileName: canonicalFile, reason: "dependency package"})
    } else if (extension !== ".js" && extension !== ".cjs") {
      excludedFiles.push({fileName: canonicalFile, reason: "not a JavaScript source file"})
    } else {
      files.push(canonicalFile)
    }
  }

  return {
    entryFile: canonicalEntry,
    libraryRoot: canonicalRoot,
    discovery: {
      status: payload.error === null ? "complete" : "entry-error",
      ...(payload.error === null ? {} : {error: payload.error}),
      stdout: execution.stdout ?? "",
      stderr: execution.stderr ?? "",
      files,
      excludedFiles,
    },
  }
}

export function inventoryTopLevelFunctions(fileName: string): TopLevelFunction[] {
  const canonicalFile = realpathSync(path.resolve(fileName))
  const sourceText = readFileSync(canonicalFile, "utf8")
  const sourceFile = ts.createSourceFile(
    canonicalFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const functions: TopLevelFunction[] = []
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) {
      continue
    }
    const startOffset = statement.getStart(sourceFile)
    const location = sourceFile.getLineAndCharacterOfPosition(startOffset)
    functions.push({
      id: `${canonicalFile}:${startOffset}`,
      fileName: canonicalFile,
      functionName: statement.name.text,
      startOffset,
      endOffset: statement.end,
      line: location.line + 1,
      character: location.character + 1,
    })
  }
  return functions
}

export function analyzeLibrary(options: AnalyzeLibraryOptions): LibraryAnalysisResult {
  const discovered = discoverLibraryFiles(
    options.entryFile,
    options.libraryRoot,
    options.timeoutMs,
  )
  const files: LibraryFileResult[] = []
  for (const fileName of discovered.discovery.files) {
    let inventory: TopLevelFunction[]
    try {
      inventory = inventoryTopLevelFunctions(fileName)
    } catch (error) {
      files.push({fileName, functions: [], error: errorMessage(error)})
      continue
    }
    const functions: LibraryFunctionResult[] = inventory.map(target => {
      try {
        return {
          ...target,
          status: "analyzed" as const,
          analysis: analyzeFile({
            fileName,
            functionName: target.functionName,
            functionPosition: target.startOffset,
            typeText: options.typeText,
            tsconfig: false,
          }),
        }
      } catch (error) {
        return {...target, status: "failed" as const, error: errorMessage(error)}
      }
    })
    files.push({fileName, functions})
  }

  return {
    entryFile: discovered.entryFile,
    libraryRoot: discovered.libraryRoot,
    typeText: options.typeText ?? "string",
    discovery: discovered.discovery,
    files,
    summary: summarize(files, discovered.discovery.excludedFiles.length),
  }
}

export function printLibraryAnalysisResult(result: LibraryAnalysisResult): void {
  console.log(`${result.entryFile} (library T = ${result.typeText})`)
  console.log(`Discovery: ${result.discovery.status}`)
  if (result.discovery.error) {
    console.log(`Discovery error: ${result.discovery.error}`)
  }
  console.table(result.files.map(file => ({
    file: path.relative(result.libraryRoot, file.fileName) || path.basename(file.fileName),
    functions: file.functions.length,
    analyzed: file.functions.filter(fn => fn.status === "analyzed").length,
    failed: file.functions.filter(fn => fn.status === "failed").length,
    branches: file.functions.reduce(
      (count, fn) => count + (fn.status === "analyzed" ? fn.analysis.branches.length : 0),
      0,
    ),
  })))
  console.table([result.summary])
}

function summarize(
  files: readonly LibraryFileResult[],
  excludedFiles: number,
): LibraryAnalysisSummary {
  const functions = files.flatMap(file => file.functions)
  const analyses = functions.flatMap(fn => fn.status === "analyzed" ? [fn.analysis] : [])
  const edges = analyses.flatMap(analysis =>
    analysis.branches.flatMap(branch => branch.edges)
  )
  return {
    files: files.length,
    excludedFiles,
    functions: functions.length,
    analyzedFunctions: analyses.length,
    failedFunctions: functions.length - analyses.length,
    branches: analyses.reduce((count, analysis) => count + analysis.branches.length, 0),
    unreachableEdges: edges.filter(edge => edge.classification !== "reachable").length,
    diagnosticOccurrences: analyses.reduce(
      (count, analysis) => count + analysis.diagnostics.length,
      0,
    ),
    unsupported: analyses.reduce((count, analysis) => count + analysis.unsupported.length, 0),
  }
}

function findLibraryRoot(entryFile: string): string {
  let directory = path.dirname(entryFile)
  while (true) {
    if (existsSync(path.join(directory, "package.json"))) {
      return directory
    }
    const parent = path.dirname(directory)
    if (parent === directory) {
      return path.dirname(entryFile)
    }
    directory = parent
  }
}

function isWithin(root: string, fileName: string): boolean {
  const relative = path.relative(root, fileName)
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative))
}

function isChildPayload(value: unknown): value is ChildPayload {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const candidate = value as {files?: unknown; error?: unknown}
  return Array.isArray(candidate.files)
    && candidate.files.every(fileName => typeof fileName === "string")
    && (candidate.error === null || typeof candidate.error === "string")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
