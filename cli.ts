import {parseArgs} from "node:util"
import {analyzeFile, formatAnalysisResult} from "./index.ts"

const usage = `Usage: npm run analyze -- [options] <file> <function>

Analyze TypeScript narrowing for one function.

Options:
  --type <type>       Override every parameter with this type (default: string)
  --project <path>    Use this tsconfig.json instead of searching parent directories
  --no-project        Do not load a tsconfig.json
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
      json: {type: "boolean"},
      help: {type: "boolean", short: "h"},
    },
  })

  if (parsed.values.help) {
    console.log(usage)
    process.exitCode = 0
  } else if (parsed.positionals.length !== 2) {
    console.error(usage)
    process.exitCode = 1
  } else if (parsed.values.project && parsed.values["no-project"]) {
    throw new Error("--project and --no-project cannot be used together")
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
