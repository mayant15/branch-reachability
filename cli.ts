import {parseArgs} from "node:util"
import {analyzePackageExport, formatPackageAnalysisResult} from "./discovery.ts"
import {analyzeFile, type AnalysisResult, printAnalysisResult} from "./index.ts"
import {analyzeLibrary, printLibraryAnalysisResult} from "./library.ts"
import {writeAnalysesToSqlite, writeAnalysisToSqlite} from "./sqlite-output.ts"

const usage = `Usage:
  npm run analyze -- [options] <file> <function>
  npm run analyze -- --package <name> --export <name> [options]
  npm run analyze -- --library <entry.js> [options]

Analyze TypeScript narrowing for one function.

Options:
  --type <type>       Override every parameter with this type (default: string)
  --decl <path>       Use declared types and preserve types of unmatched private functions
  --project <path>    Use this tsconfig.json instead of searching parent directories
  --no-project        Do not load a tsconfig.json
  --package <name>    Resolve a package through Node's require condition
  --export <name>     CommonJS package export to discover
  --library <path>    Execute a CommonJS entry and analyze its library files
  --library-root <p>  Override the library ownership root
  --max-depth <n>     Maximum direct-call traversal depth (default: 3)
  --max-functions <n> Maximum functions to analyze (default: 50)
  --sql <path>        Upsert edge rows into a SQLite database
  --json              Print the structured result as JSON
  -h, --help          Show this help`

try {
  const parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      type: {type: "string"},
      decl: {type: "string"},
      project: {type: "string"},
      "no-project": {type: "boolean"},
      package: {type: "string"},
      export: {type: "string"},
      library: {type: "string"},
      "library-root": {type: "string"},
      "max-depth": {type: "string"},
      "max-functions": {type: "string"},
      sql: {type: "string"},
      json: {type: "boolean"},
      help: {type: "boolean", short: "h"},
    },
  })

  if (parsed.values.help) {
    console.log(usage)
    process.exitCode = 0
  } else if (parsed.values.type && parsed.values.decl) {
    throw new Error("--type and --decl cannot be used together")
  } else if (parsed.values.decl && parsed.values.sql && !parsed.values.library) {
    throw new Error("--decl cannot be combined with --sql")
  } else if (parsed.values.project && parsed.values["no-project"]) {
    throw new Error("--project and --no-project cannot be used together")
  } else if (parsed.values.library) {
    if (
      parsed.positionals.length !== 0
      || parsed.values.package
      || parsed.values.export
      || parsed.values["max-depth"]
      || parsed.values["max-functions"]
      || parsed.values.project
      || parsed.values["no-project"]
    ) {
      throw new Error(
        "--library cannot be combined with positional, package, traversal, or project options",
      )
    }
    const result = analyzeLibrary({
      entryFile: parsed.values.library,
      libraryRoot: parsed.values["library-root"],
      typeText: parsed.values.type,
      declarationFile: parsed.values.decl,
    })
    if (parsed.values.sql) {
      const analyses: AnalysisResult[] = []
      for (const file of result.files) {
        for (const fn of file.functions) {
          if (fn.status === "analyzed") {
            analyses.push(fn.analysis)
          }
        }
      }
      writeAnalysesToSqlite(parsed.values.sql, analyses)
    }
    if (parsed.values.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      printLibraryAnalysisResult(result)
    }
    if (result.discovery.status !== "complete" || result.summary.failedFunctions > 0) {
      process.exitCode = 1
    }
  } else if (parsed.values["library-root"]) {
    throw new Error("--library-root requires --library")
  } else if (parsed.values.package) {
    if (!parsed.values.export || parsed.positionals.length !== 0) {
      throw new Error("Package mode requires --package and --export with no positional arguments")
    }
    if (parsed.values.project || parsed.values["no-project"]) {
      throw new Error("--project and --no-project are not supported in package mode")
    }
    const result = analyzePackageExport({
      packageName: parsed.values.package,
      exportName: parsed.values.export,
      typeText: parsed.values.type,
      declarationFile: parsed.values.decl,
      maxDepth: parseIntegerOption("--max-depth", parsed.values["max-depth"]),
      maxFunctions: parseIntegerOption("--max-functions", parsed.values["max-functions"]),
    })
    if (parsed.values.sql) {
      writeAnalysesToSqlite(
        parsed.values.sql,
        result.functions.map(discovered => discovered.analysis),
      )
    }
    console.log(
      parsed.values.json ? JSON.stringify(result, null, 2) : formatPackageAnalysisResult(result),
    )
  } else if (
    parsed.values.export
    || parsed.values["max-depth"]
    || parsed.values["max-functions"]
  ) {
    throw new Error("--export, --max-depth, and --max-functions require --package")
  } else if (parsed.positionals.length !== 2) {
    console.error(usage)
    process.exitCode = 1
  } else {
    const [fileName, functionName] = parsed.positionals
    const result = analyzeFile({
      fileName,
      functionName,
      typeText: parsed.values.type,
      declarationFile: parsed.values.decl,
      tsconfig: parsed.values["no-project"] ? false : parsed.values.project,
    })
    if (parsed.values.sql) {
      writeAnalysisToSqlite(parsed.values.sql, result)
    }
    if (parsed.values.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      printAnalysisResult(result)
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

function parseIntegerOption(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`)
  }
  return parsed
}
