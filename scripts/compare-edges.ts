#!/usr/bin/env node
import {existsSync, mkdirSync, mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {DatabaseSync} from "node:sqlite"
import {analyzeLibrary, type LibraryAnalysisResult} from "../library.ts"
import {type AnalysisResult} from "../index.ts"
import {writeAnalysesToSqlite} from "../sqlite-output.ts"

// Change this constant to compare a different type against the default (string).
const ALTERNATIVE_TYPE = "any"

interface LibraryConfig {
  name: string
  entryFile: string
  declarationFile: string
}

const libraries: LibraryConfig[] = [
  {name: "js-yaml", entryFile: "node_modules/js-yaml/index.js", declarationFile: "node_modules/@types/js-yaml/index.d.ts"},
  {name: "sharp", entryFile: "node_modules/sharp/lib/index.js", declarationFile: "node_modules/sharp/lib/index.d.ts"},
]

function collectAnalyses(result: LibraryAnalysisResult): AnalysisResult[] {
  const analyses: AnalysisResult[] = []
  for (const file of result.files) {
    for (const fn of file.functions) {
      if (fn.status === "analyzed") {
        analyses.push(fn.analysis)
      }
    }
  }
  return analyses
}

function runAndSave(
  libraryName: string,
  entryFile: string,
  declarationFile: string | undefined,
  typeText: string | undefined,
  outputDir: string,
): void {
  const result = analyzeLibrary({
    entryFile,
    declarationFile,
    typeText,
    timeoutMs: 30_000,
  })
  const dbPath = path.join(outputDir, "edges.sqlite")
  writeAnalysesToSqlite(dbPath, collectAnalyses(result))
  const db = new DatabaseSync(dbPath)
  db.exec(`
      CREATE TABLE IF NOT EXISTS library_summary (
        library_name TEXT NOT NULL, type_text TEXT NOT NULL,
        files INTEGER NOT NULL CHECK (files >= 0),
        analyzed INTEGER NOT NULL CHECK (analyzed >= 0),
        failed INTEGER NOT NULL CHECK (failed >= 0),
        branches INTEGER NOT NULL CHECK (branches >= 0),
        unreachable_edges INTEGER NOT NULL CHECK (unreachable_edges >= 0),
        diagnostics INTEGER NOT NULL CHECK (diagnostics >= 0),
        unsupported INTEGER NOT NULL CHECK (unsupported >= 0)
      )
  `)
  db.prepare(
    "INSERT INTO library_summary VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    libraryName,
    result.typeText,
    result.summary.files,
    result.summary.analyzedFunctions,
    result.summary.failedFunctions,
    result.summary.branches,
    result.summary.unreachableEdges,
    result.summary.diagnosticOccurrences,
    result.summary.unsupported,
  )
  const summary = result.summary
  const label = result.typeText
  console.log(
    `  ${label.padEnd(22)} ${String(summary.analyzedFunctions).padStart(4)} functions, `
    + `${String(summary.branches).padStart(5)} branches, `
    + `${String(summary.unreachableEdges).padStart(4)} unreachable`,
  )
  db.close()
}

const tmpDir = mkdtempSync(path.join(tmpdir(), "branch-reachability-compare-"))
try {
  for (const lib of libraries) {
    if (!existsSync(lib.entryFile)) {
      console.error(`Error: ${lib.entryFile} not found. Is the package installed?`)
      process.exitCode = 1
      continue
    }
    const canonicalDir = path.join(tmpDir, lib.name, "canonical")
    const alternativeDir = path.join(tmpDir, lib.name, "alternative")
    mkdirSync(canonicalDir, {recursive: true})
    mkdirSync(alternativeDir, {recursive: true})

    console.log(`\n${lib.name}:`)
    runAndSave(lib.name, lib.entryFile, lib.declarationFile, undefined, canonicalDir)
    runAndSave(lib.name, lib.entryFile, undefined, ALTERNATIVE_TYPE, alternativeDir)
  }

  // Build a combined database for cross-mode comparison
  const combined = new DatabaseSync(path.join(tmpDir, "combined.sqlite"))
  combined.exec("PRAGMA foreign_keys = OFF")
  try {
    for (const lib of libraries) {
      const canonicalPath = path.resolve(tmpDir, lib.name, "canonical", "edges.sqlite")
      const alternativePath = path.resolve(tmpDir, lib.name, "alternative", "edges.sqlite")
      const libAlias = lib.name.replaceAll("-", "_")
      combined.exec(`
        ATTACH DATABASE '${canonicalPath.replace(/'/g, "''")}' AS c_${libAlias};
        ATTACH DATABASE '${alternativePath.replace(/'/g, "''")}' AS a_${libAlias}
      `)
    }

    // side-by-side edge comparison
    console.log("\n--- Edge-by-edge comparison ---")
    for (const lib of libraries) {
      const libAlias = lib.name.replaceAll("-", "_")
      const rows = combined.prepare(`
        SELECT
          c.function_name,
          c.edge_id,
          c.edge,
          c.classification AS canonical_class,
          a.classification AS any_class,
          c.probed_types AS canonical_types,
          a.probed_types AS any_types,
          c.file_name
        FROM c_${libAlias}.edges AS c
        JOIN a_${libAlias}.edges AS a USING (edge_id)
        ORDER BY c.file_name, c.function_name, c.start_offset, c.edge
      `).all() as Array<{
        function_name: string
        edge_id: string
        edge: string
        canonical_class: string
        any_class: string
        canonical_types: string
        any_types: string
        file_name: string
      }>
      console.log(`\n${lib.name} — ${rows.length} shared edges`)
      if (rows.length > 0) {
        console.table(rows.map(r => ({
          function: r.function_name,
          edge: r.edge,
          "d.ts classification": r.canonical_class,
          "any classification": r.any_class,
          "d.ts probed": r.canonical_types,
          "any probed": r.any_types,
        })))
      }

      // count changes per classification
      const changes = combined.prepare(`
        SELECT c.classification AS canonical_class, a.classification AS any_class, COUNT(*) AS cnt
        FROM c_${libAlias}.edges AS c
        JOIN a_${libAlias}.edges AS a USING (edge_id)
        WHERE c.edge != 'baseline'
        GROUP BY c.classification, a.classification
        ORDER BY cnt DESC
      `).all() as Array<{canonical_class: string; any_class: string; cnt: number}>
      console.log(`\n${lib.name} — classification changes (true/false edges only):`)
      console.table(changes)

      // summary
      const summaries = combined.prepare(`
        SELECT * FROM c_${libAlias}.library_summary
        UNION ALL
        SELECT * FROM a_${libAlias}.library_summary
      `).all() as Array<{
        library_name: string
        type_text: string
        files: number
        analyzed: number
        failed: number
        branches: number
        unreachable_edges: number
        diagnostics: number
        unsupported: number
      }>
      console.log(`\n${lib.name} — summary:`)
      console.table(summaries)
    }
  } finally {
    combined.close()
  }
} finally {
  rmSync(tmpDir, {recursive: true, force: true})
}
