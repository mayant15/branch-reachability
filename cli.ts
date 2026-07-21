import {parseArgs} from "node:util"
import {analyzePackageExport, formatPackageAnalysisResult} from "./discovery.ts"
import {analyzeFile, formatAnalysisResult} from "./index.ts"

const usage = `Usage:
  npm run analyze -- [options] <file> <function>
  npm run analyze -- --package <name> --export <name> [options]

Analyze TypeScript narrowing for one function.

Options:
  --type <type>       Override every parameter with this type (default: string)
  --project <path>    Use this tsconfig.json instead of searching parent directories
  --no-project        Do not load a tsconfig.json
  --package <name>    Resolve a package through Node's require condition
  --export <name>     CommonJS package export to discover
  --max-depth <n>     Maximum direct-call traversal depth (default: 3)
  --max-functions <n> Maximum functions to analyze (default: 50)
  --json              Print the structured result as JSON
  -h, --help          Show this help`

try {
  const parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      type: {type: "string"},
      project: {type: "string"},
      "no-project": {type: "boolean"},
      package: {type: "string"},
      export: {type: "string"},
      "max-depth": {type: "string"},
      "max-functions": {type: "string"},
      json: {type: "boolean"},
      help: {type: "boolean", short: "h"},
    },
  })

  if (parsed.values.help) {
    console.log(usage)
    process.exitCode = 0
  } else if (parsed.values.project && parsed.values["no-project"]) {
    throw new Error("--project and --no-project cannot be used together")
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
      maxDepth: parseIntegerOption("--max-depth", parsed.values["max-depth"]),
      maxFunctions: parseIntegerOption("--max-functions", parsed.values["max-functions"]),
    })
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
      tsconfig: parsed.values["no-project"] ? false : parsed.values.project,
    })
    console.log(parsed.values.json ? JSON.stringify(result, null, 2) : formatAnalysisResult(result))
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
