#!/usr/bin/env node
import {existsSync, mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {parseArgs} from "node:util"
import {DatabaseSync} from "node:sqlite"
import {spawnSync} from "node:child_process"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const usage = `Usage:
  npm run db -- [options]

Run the full branch-reachability pipeline (static analysis → random fuzzing under
NODE_V8_COVERAGE → coverage import) for every configured library in two modes:
declaration-based types and --type any. Produces one SQLite database per
library-mode combination.

Options:
  --iterations <n>    Fuzzer iterations per run (default: 100)
  --help              Show this help`

interface LibraryConfig {
  name: string
  entryFile: string
  declarationFile: string
}

interface ModeConfig {
  label: string
  suffix: string
  analyzeArgs: string[]
}

const libraries: LibraryConfig[] = [
  {name: "js-yaml", entryFile: "node_modules/js-yaml/index.js", declarationFile: "node_modules/@types/js-yaml/index.d.ts"},
  {name: "sharp", entryFile: "node_modules/sharp/lib/index.js", declarationFile: "node_modules/sharp/lib/index.d.ts"},
]

const modes: ModeConfig[] = [
  {label: "declaration", suffix: "decl", analyzeArgs: ["--decl"]},
  {label: "type any", suffix: "any", analyzeArgs: ["--type", "any"]},
]

function parseCliArgs(): {iterations: number} {
  const parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      iterations: {type: "string"},
      help: {type: "boolean", short: "h"},
    },
  })

  if (parsed.values.help) {
    console.log(usage)
    process.exit(0)
  }

  return {
    iterations: parsed.values.iterations ? Number(parsed.values.iterations) : 100,
  }
}

function runStep(
  label: string,
  command: string,
  args: readonly string[],
  options?: {env?: Record<string, string>},
): void {
  process.stderr.write(`${label} ... `)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    timeout: 120_000,
    env: options?.env ? {...process.env, ...options.env} as NodeJS.ProcessEnv : undefined,
  })
  if (result.error) {
    process.stderr.write(`FAILED (${result.error.message})\n`)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.stderr.write(`FAILED (exit ${result.status})\n`)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exit(1)
  }
  process.stderr.write("done\n")
}

function processLibrary(
  lib: LibraryConfig,
  mode: ModeConfig,
  iterations: number,
): string {
  const dbPath = path.resolve(`${lib.name}-${mode.suffix}.sqlite`)
  const entryFile = path.resolve(lib.entryFile)
  const declFile = lib.declarationFile ? path.resolve(lib.declarationFile) : undefined

  const analyzeArgs = [
    "run", "analyze", "--",
    "--sql", dbPath,
    "--library", entryFile,
    ...mode.analyzeArgs,
    ...(mode.suffix === "decl" && declFile ? [declFile] : []),
  ]

  runStep(`  ${mode.label} — static analysis`, "npm", analyzeArgs)

  const coverageDir = mkdtempSync(path.join(tmpdir(), "branch-reachability-coverage-"))
  try {
    runStep(`  ${mode.label} — fuzzing`, "node", [
      "fuzzer.ts", entryFile,
    ], {env: {NODE_V8_COVERAGE: coverageDir, ITERATIONS: String(iterations)}})

    runStep(`  ${mode.label} — coverage import`, "npm", [
      "run", "coverage", "--", dbPath, coverageDir,
    ])

    return dbPath
  } finally {
    rmSync(coverageDir, {recursive: true, force: true})
  }
}

function getEdgeCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath)
  try {
    return (db.prepare("SELECT COUNT(*) AS cnt FROM edges").get() as {cnt: number}).cnt
  } finally {
    db.close()
  }
}

function printSummary(results: Array<{lib: LibraryConfig; mode: ModeConfig; dbPath: string}>): void {
  console.log("\n=== Summary ===")
  const summaryRows: Array<Record<string, string | number>> = []

  for (const {lib, mode, dbPath} of results) {
    const db = new DatabaseSync(dbPath)
    try {
      const edgeCount = (db.prepare("SELECT COUNT(*) AS cnt FROM edges").get() as {cnt: number}).cnt
      const coverageCount = (db.prepare("SELECT COUNT(*) AS cnt FROM edge_coverage").get() as {cnt: number}).cnt
      const hitSum = (db.prepare("SELECT COALESCE(SUM(hit_count), 0) AS total FROM edge_coverage").get() as {total: number}).total
      const unreachable = (db.prepare(
        "SELECT COUNT(*) AS cnt FROM edges WHERE edge IN ('true','false') AND classification = 'newly-unreachable'",
      ).get() as {cnt: number}).cnt
      const inherited = (db.prepare(
        "SELECT COUNT(*) AS cnt FROM edges WHERE edge IN ('true','false') AND classification = 'inherited-unreachable'",
      ).get() as {cnt: number}).cnt
      summaryRows.push({
        library: lib.name,
        mode: mode.label,
        edges: edgeCount,
        covered: coverageCount,
        hits: hitSum,
        "newly-unreachable": unreachable,
        "inherited-unreachable": inherited,
      })
    } finally {
      db.close()
    }
  }

  console.table(summaryRows)
}

function main(): void {
  const {iterations} = parseCliArgs()
  const results: Array<{lib: LibraryConfig; mode: ModeConfig; dbPath: string}> = []

  for (const lib of libraries) {
    if (!existsSync(path.resolve(lib.entryFile))) {
      console.error(`Warning: ${lib.entryFile} not found — skipping ${lib.name}`)
      continue
    }

    console.log(`\n${lib.name}:`)
    for (const mode of modes) {
      const dbPath = processLibrary(lib, mode, iterations)
      results.push({lib, mode, dbPath})
    }
  }

  // Assert matching edge counts between decl and any modes per library
  for (const lib of libraries) {
    const declPath = results.find(r => r.lib.name === lib.name && r.mode.suffix === "decl")?.dbPath
    const anyPath = results.find(r => r.lib.name === lib.name && r.mode.suffix === "any")?.dbPath
    if (declPath && anyPath) {
      const declEdges = getEdgeCount(declPath)
      const anyEdges = getEdgeCount(anyPath)
      if (declEdges !== anyEdges) {
        console.error(
          `Error: ${lib.name} has ${declEdges} edges in declaration mode but ${anyEdges} in --type any mode. `
          + "Branch structure should not depend on parameter type override.",
        )
        process.exit(1)
      }
    }
  }

  if (results.length > 0) {
    printSummary(results)
  } else {
    console.error("No libraries processed. Ensure dependencies are installed.")
    process.exit(1)
  }
}

main()
