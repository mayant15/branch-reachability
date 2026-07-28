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
declaration-based types and --type any. Produces one SQLite database per run.

Options:
  --iterations <n>    Fuzzer iterations per run (default: 100000)
  --help              Show this help`

interface LibraryConfig {
  name: string
  entryFile: string
  declarationFile: string
}

const libraries: LibraryConfig[] = [
  {name: "js-yaml", entryFile: "node_modules/js-yaml/index.js", declarationFile: "node_modules/@types/js-yaml/index.d.ts"},
  // {name: "sharp", entryFile: "node_modules/sharp/lib/index.js", declarationFile: "node_modules/sharp/lib/index.d.ts"},
]

const dbPath = path.resolve(projectRoot, "branch-reachability.sqlite")

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
    iterations: parsed.values.iterations ? Number(parsed.values.iterations) : 100000,
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

function tableExists(tableName: string): boolean {
  if (!existsSync(dbPath)) return false
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(tableName) !== undefined
  } finally {
    db.close()
  }
}

function columnExists(tableName: string, columnName: string): boolean {
  if (!existsSync(dbPath)) return false
  const db = new DatabaseSync(dbPath)
  try {
    return (db.prepare(`PRAGMA table_info(\`${tableName}\`)`).all() as Array<{name: string}>)
      .some(c => c.name === columnName)
  } finally {
    db.close()
  }
}

function libraryEdgesPresent(lib: LibraryConfig): boolean {
  if (!tableExists("edges")) return false
  const prefix = `${path.resolve(projectRoot, "node_modules", lib.name)}${path.sep}`
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare(
      "SELECT COUNT(*) AS cnt FROM edges WHERE file_name LIKE ?",
    ).get(`${prefix}%`) as {cnt: number}
    return row.cnt > 0
  } finally {
    db.close()
  }
}

function nullableColumnComplete(tableName: string, columnName: string): boolean {
  if (!tableExists(tableName) || !columnExists(tableName, columnName)) return false
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS cnt FROM \`${tableName}\` WHERE \`${columnName}\` IS NULL`,
    ).get() as {cnt: number}
    return row.cnt === 0
  } finally {
    db.close()
  }
}

function ensureEdgeSchema(): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS edges (
        edge_id TEXT PRIMARY KEY,
        edge TEXT NOT NULL CHECK (edge IN ('baseline', 'true', 'false')),
        classification TEXT NOT NULL CHECK (classification IN ('', 'reachable', 'newly-unreachable', 'inherited-unreachable')),
        decl_score REAL CHECK (decl_score >= 0 AND decl_score <= 1),
        any_score REAL CHECK (any_score >= 0 AND any_score <= 1),
        start_line INTEGER NOT NULL,
        start_col INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        end_col INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        decl_type TEXT,
        any_type TEXT,
        parent_edge_id TEXT REFERENCES edges(edge_id),
        file_name TEXT NOT NULL,
        function_name TEXT NOT NULL,
        type_text TEXT NOT NULL,
        CHECK (start_line < end_line OR (start_line = end_line AND start_col <= end_col)),
        CHECK (start_offset <= end_offset),
        CHECK ((edge = 'baseline' AND classification = '')
            OR (edge IN ('true', 'false') AND classification IN ('reachable', 'newly-unreachable', 'inherited-unreachable')))
      );
      CREATE INDEX IF NOT EXISTS edges_parent_edge_id ON edges(parent_edge_id);
      CREATE INDEX IF NOT EXISTS edges_source ON edges(file_name, function_name);
    `)
  } finally {
    db.close()
  }
}

function ensureCoverageSchema(): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coverage (
        edge_id TEXT PRIMARY KEY REFERENCES edges(edge_id) ON DELETE CASCADE,
        decl_hit_count INTEGER NOT NULL DEFAULT 0 CHECK (decl_hit_count >= 0),
        any_hit_count INTEGER NOT NULL DEFAULT 0 CHECK (any_hit_count >= 0)
      );
    `)
  } finally {
    db.close()
  }
}

function readEdges(sourceDbPath: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(sourceDbPath)
  try {
    return db.prepare("SELECT * FROM edges").all() as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

function mergeEdgesInto(tempDbPath: string, typeColumn: "decl_type" | "any_type"): void {
  const srcRows = readEdges(tempDbPath)
  if (srcRows.length === 0) return
  const probColumn = typeColumn.replace("_type", "_score")

  ensureEdgeSchema()
  const db = new DatabaseSync(dbPath)
  try {
    const insert = db.prepare(`
      INSERT INTO edges (
        edge_id, edge, classification,
        start_line, start_col, end_line, end_col,
        start_offset, end_offset,
        decl_type, any_type,
        decl_score, any_score,
        parent_edge_id, file_name, function_name, type_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(edge_id) DO UPDATE SET
        \`${probColumn}\` = COALESCE(excluded.\`${probColumn}\`, \`${probColumn}\`),
        \`${typeColumn}\` = COALESCE(excluded.\`${typeColumn}\`, \`${typeColumn}\`)
    `)

    db.exec("BEGIN IMMEDIATE")
    try {
      for (const row of srcRows) {
        const isDecl = typeColumn === "decl_type"
        const [declType, anyType] = isDecl ? [row.probed_types, null] : [null, row.probed_types]
        const [declProb, anyProb] = isDecl ? [row.prob_from_fn_entry, null] : [null, row.prob_from_fn_entry]
        insert.run(
          row.edge_id, row.edge, row.classification,
          row.start_line, row.start_col, row.end_line, row.end_col,
          row.start_offset, row.end_offset,
          declType, anyType,
          declProb, anyProb,
          row.parent_edge_id, row.file_name, row.function_name, row.type_text,
        )
      }
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  } finally {
    db.close()
  }
}

function mergeEdgeCoverage(hitColumn: "decl_hit_count" | "any_hit_count"): void {
  const db = new DatabaseSync(dbPath)
  try {
    if (!tableExists("edge_coverage")) return

    ensureCoverageSchema()
    db.exec("BEGIN IMMEDIATE")
    try {
      // Ensure a row exists for every edge_coverage entry
      const rows = db.prepare(
        "SELECT edge_id FROM edge_coverage",
      ).all() as Array<{edge_id: string}>
      const insertRow = db.prepare(
        "INSERT OR IGNORE INTO coverage (edge_id, decl_hit_count, any_hit_count) VALUES (?, 0, 0)",
      )
      for (const {edge_id} of rows) {
        insertRow.run(edge_id)
      }
      db.prepare(`
        UPDATE coverage SET \`${hitColumn}\` = (
          SELECT hit_count FROM edge_coverage
          WHERE edge_coverage.edge_id = coverage.edge_id
        )
        WHERE edge_id IN (SELECT edge_id FROM edge_coverage)
      `).run()
      db.exec("DROP TABLE edge_coverage")
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  } finally {
    db.close()
  }
}

function assertNoNullTypes(): void {
  const db = new DatabaseSync(dbPath)
  try {
    const missingDecl = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM edges WHERE decl_type IS NULL",
    ).get() as {cnt: number}).cnt
    const missingAny = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM edges WHERE any_type IS NULL",
    ).get() as {cnt: number}).cnt
    if (missingDecl + missingAny > 0) {
      console.error(
        `Error: ${missingDecl} edges missing decl_type and ${missingAny} missing any_type. `
        + "Branch structure should not depend on parameter type override.",
      )
      process.exit(1)
    }
  } finally {
    db.close()
  }
}

function printSummary(results: Array<{lib: LibraryConfig; dbPath: string}>): void {
  console.log("\n=== Summary ===")
  const summaryRows: Array<Record<string, string | number>> = []

  for (const {lib} of results) {
    const db = new DatabaseSync(dbPath)
    try {
      const libPrefix = `${path.resolve(projectRoot, "node_modules", lib.name)}${path.sep}`
      const edgeCount = (db.prepare(
        "SELECT COUNT(*) AS cnt FROM edges WHERE file_name LIKE ?",
      ).get(`${libPrefix}%`) as {cnt: number}).cnt
      const coverageCount = (db.prepare(
        "SELECT COUNT(*) AS cnt FROM coverage c JOIN edges e ON c.edge_id = e.edge_id WHERE e.file_name LIKE ?",
      ).get(`${libPrefix}%`) as {cnt: number}).cnt
      const hitSum = (db.prepare(
        "SELECT COALESCE(SUM(c.decl_hit_count), 0) AS total FROM coverage c JOIN edges e ON c.edge_id = e.edge_id WHERE e.file_name LIKE ?",
      ).get(`${libPrefix}%`) as {total: number}).total
      const unreachable = (db.prepare(
        "SELECT COUNT(*) AS cnt FROM edges WHERE file_name LIKE ? AND edge IN ('true','false') AND classification = 'newly-unreachable'",
      ).get(`${libPrefix}%`) as {cnt: number}).cnt
      const inherited = (db.prepare(
        "SELECT COUNT(*) AS cnt FROM edges WHERE file_name LIKE ? AND edge IN ('true','false') AND classification = 'inherited-unreachable'",
      ).get(`${libPrefix}%`) as {cnt: number}).cnt
      summaryRows.push({
        library: lib.name,
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

  const hasNewSchema = tableExists("edges") && columnExists("edges", "decl_type")
  const hasCoverage = tableExists("coverage")

  if (hasNewSchema && hasCoverage) {
    const allPresent = libraries.every(libraryEdgesPresent)
    if (allPresent) {
      console.log("All up to date.")
      printSummary(libraries.map(lib => ({lib, dbPath})))
      return
    }
  }

  if (tableExists("edges") && !columnExists("edges", "decl_type")) {
    rmSync(dbPath)
  }

  for (const lib of libraries) {
    if (!existsSync(path.resolve(projectRoot, lib.entryFile))) {
      console.error(`Warning: ${lib.entryFile} not found — skipping ${lib.name}`)
      continue
    }

    console.log(`\n${lib.name}:`)

    if (!libraryEdgesPresent(lib)) {
      const declFile = lib.declarationFile ? path.resolve(projectRoot, lib.declarationFile) : undefined

      const tmpDecl = path.resolve(projectRoot, `${lib.name}-decl-tmp.sqlite`)
      const tmpAny = path.resolve(projectRoot, `${lib.name}-any-tmp.sqlite`)
      try {
        const declArgs = [
          "run", "analyze", "--",
          "--sql", tmpDecl,
          "--library", path.resolve(projectRoot, lib.entryFile),
          "--decl",
        ]
        if (declFile) declArgs.push(declFile)
        runStep("  declaration — static analysis", "npm", declArgs)
        mergeEdgesInto(tmpDecl, "decl_type")

        const anyArgs = [
          "run", "analyze", "--",
          "--sql", tmpAny,
          "--library", path.resolve(projectRoot, lib.entryFile),
          "--type", "any",
        ]
        runStep("  type any — static analysis", "npm", anyArgs)
        mergeEdgesInto(tmpAny, "any_type")

        assertNoNullTypes()
      } finally {
        for (const tmp of [tmpDecl, tmpAny]) {
          if (existsSync(tmp)) rmSync(tmp)
        }
      }
    } else {
      const declOk = nullableColumnComplete("edges", "decl_type")
      const anyOk = nullableColumnComplete("edges", "any_type")
      if (declOk) process.stderr.write("  declaration — static analysis (cached)\n")
      if (anyOk) process.stderr.write("  type any — static analysis (cached)\n")
    }

    if (!hasCoverage) {
      // Fuzzing + coverage import → mode-specific hit count.
      // Each mode runs the same JavaScript, so hit counts are expected to match,
      // but the pipeline tracks them separately so mode-specific coverage
      // (e.g. from instrumented execution) can be plugged in later.
      for (const mode of ["decl", "any"] as const) {
        const coverageDir = mkdtempSync(path.join(tmpdir(), `branch-reachability-coverage-${mode}-`))
        try {
          const fuzzArgs = mode === "decl"
            ? ["fuzzer.ts", "--decl", path.resolve(projectRoot, lib.declarationFile), path.resolve(projectRoot, lib.entryFile)]
            : ["fuzzer.ts", "--type", "any", path.resolve(projectRoot, lib.entryFile)]
          runStep(`  fuzzing (${mode} mode)`, "node", fuzzArgs, {env: {NODE_V8_COVERAGE: coverageDir, ITERATIONS: String(iterations)}})

          runStep(`  coverage import (${mode} mode)`, "npm", [
            "run", "coverage", "--", dbPath, coverageDir,
          ])
          const hitColumn = mode === "decl" ? "decl_hit_count" : "any_hit_count"
          mergeEdgeCoverage(hitColumn)
        } finally {
          rmSync(coverageDir, {recursive: true, force: true})
        }
      }
    } else {
      process.stderr.write("  coverage (cached)\n")
    }
  }

  if (libraries.some(l => existsSync(path.resolve(projectRoot, l.entryFile)))) {
    printSummary(libraries.map(lib => ({lib, dbPath})))
  } else {
    console.error("No libraries processed. Ensure dependencies are installed.")
    process.exit(1)
  }
}

main()
