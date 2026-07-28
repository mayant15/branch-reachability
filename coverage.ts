/**
 * Imports raw NODE_V8_COVERAGE reports into a branch-reachability edge database.
 *
 * Process:
 * 1. Create the database while analyzing the same source files that V8 executes:
 *    `npm run analyze -- --sql edges.sqlite <file> <function>`
 * 2. Run the program with `NODE_V8_COVERAGE=<directory>` to produce JSON reports.
 * 3. Import one report or a directory recursively:
 *    `npm run coverage -- edges.sqlite <coverage-json-or-directory> [...]`
 * 4. Join `edge_coverage` to `edges` by `edge_id` to inspect branch hit counts.
 *
 * Only true and false edges are considered. For each report, an edge receives a
 * count only from a V8 range that contains its complete original-source span. An
 * exact span is preferred; otherwise the smallest containing span is used. This
 * includes exact zero-width continuation ranges for synthesized false edges. If
 * equally specific candidates disagree on their count, that report contributes
 * no count for the edge. Counts from all supplied reports are summed. Baselines,
 * unmatched edges, and edges with no unambiguous match are absent from the table.
 *
 * The analyzer's virtual parameter annotations and probes do not change the
 * offsets stored in `edges`; direct JavaScript coverage therefore aligns with
 * them. Coverage for transpiled sources requires source-map remapping first.
 * Every import transactionally replaces `edge_coverage(edge_id, hit_count)`.
 */
import {readdirSync, readFileSync, statSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {parseArgs} from "node:util"
import {DatabaseSync} from "node:sqlite"

interface V8Range {
  startOffset: number
  endOffset: number
  count: number
}

interface V8FunctionCoverage {
  ranges: V8Range[]
}

interface V8ScriptCoverage {
  url: string
  functions: V8FunctionCoverage[]
}

interface V8CoverageFile {
  result: V8ScriptCoverage[]
}

interface EdgeRow {
  edge_id: string
  file_name: string
  start_offset: number
  end_offset: number
}

interface CoverageRow {
  edge_id: string
  hit_count: number
}

export interface ImportCoverageResult {
  databasePath: string
  coverageFiles: number
  candidateEdges: number
  coveredEdges: number
}

const usage = `Usage:
  npm run coverage -- <database> <coverage-json-or-directory> [...]

Add an edge_coverage table to an edge SQLite database. Directories are searched
recursively for .json files. Hit counts are summed across all supplied reports.`

export function importV8Coverage(
  databasePath: string,
  coveragePaths: readonly string[],
): ImportCoverageResult {
  const resolvedDatabasePath = path.resolve(databasePath)
  const coverageFiles = coveragePaths.flatMap(collectJsonFiles)
  if (coverageFiles.length === 0) {
    throw new Error("No coverage JSON files found")
  }

  const rangesByFile = new Map<string, V8Range[][]>()
  for (const coverageFile of coverageFiles) {
    const coverage = parseCoverageFile(coverageFile)
    for (const script of coverage.result) {
      const fileName = coverageUrlToPath(script.url)
      if (fileName === undefined) {
        continue
      }
      const reportRanges = script.functions.flatMap(fn => fn.ranges)
      const reports = rangesByFile.get(fileName) ?? []
      reports.push(reportRanges)
      rangesByFile.set(fileName, reports)
    }
  }

  const database = new DatabaseSync(resolvedDatabasePath)
  try {
    const edges = database.prepare(`
      SELECT edge_id, file_name, start_offset, end_offset
      FROM edges
      WHERE edge IN ('true', 'false')
    `).all() as unknown as EdgeRow[]
    const rows: CoverageRow[] = []
    for (const edge of edges) {
      const reports = rangesByFile.get(path.resolve(edge.file_name)) ?? []
      let hitCount = 0
      let matched = false
      for (const ranges of reports) {
        const count = findHitCount(edge, ranges)
        if (count !== undefined) {
          hitCount += count
          matched = true
        }
      }
      if (matched) {
        rows.push({edge_id: edge.edge_id, hit_count: hitCount})
      }
    }

    database.exec("BEGIN IMMEDIATE")
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS edge_coverage (
          edge_id TEXT PRIMARY KEY REFERENCES edges(edge_id) ON DELETE CASCADE,
          hit_count INTEGER NOT NULL CHECK (hit_count >= 0)
        );
        DELETE FROM edge_coverage;
      `)
      const insert = database.prepare(`
        INSERT INTO edge_coverage (edge_id, hit_count) VALUES (?, ?)
      `)
      for (const row of rows) {
        if (row.hit_count < 0) {
          throw new Error(`Negative hit_count ${row.hit_count} for edge ${row.edge_id}`)
        }
        insert.run(row.edge_id, row.hit_count)
      }
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }

    return {
      databasePath: resolvedDatabasePath,
      coverageFiles: coverageFiles.length,
      candidateEdges: edges.length,
      coveredEdges: rows.length,
    }
  } finally {
    database.close()
  }
}

function collectJsonFiles(inputPath: string): string[] {
  const resolvedPath = path.resolve(inputPath)
  const stats = statSync(resolvedPath)
  if (stats.isFile()) {
    return resolvedPath.endsWith(".json") ? [resolvedPath] : []
  }
  if (!stats.isDirectory()) {
    return []
  }
  return readdirSync(resolvedPath, {withFileTypes: true})
    .flatMap(entry => collectJsonFiles(path.join(resolvedPath, entry.name)))
    .sort()
}

function parseCoverageFile(fileName: string): V8CoverageFile {
  const parsed: unknown = JSON.parse(readFileSync(fileName, "utf8"))
  if (!isCoverageFile(parsed)) {
    throw new Error(`${fileName} is not a V8 coverage JSON file`)
  }
  return parsed
}

function isCoverageFile(value: unknown): value is V8CoverageFile {
  return typeof value === "object" && value !== null
    && Array.isArray((value as {result?: unknown}).result)
}

function coverageUrlToPath(url: string): string | undefined {
  if (!url.startsWith("file://")) {
    return undefined
  }
  return path.resolve(fileURLToPath(url))
}

function findHitCount(edge: EdgeRow, ranges: readonly V8Range[]): number | undefined {
  for (const range of ranges) {
    if (range.startOffset < 0 || range.endOffset < 0) {
      throw new Error(
        `V8 range has negative offset (${range.startOffset}, ${range.endOffset})`,
      )
    }
    if (range.startOffset > range.endOffset) {
      throw new Error(
        `V8 range start ${range.startOffset} > end ${range.endOffset}`,
      )
    }
    if (range.count < 0) {
      throw new Error(`V8 range has negative count ${range.count}`)
    }
  }
  const containing = ranges.filter(range =>
    range.startOffset <= edge.start_offset && range.endOffset >= edge.end_offset
  )
  if (containing.length === 0) {
    return undefined
  }
  const exact = containing.filter(range =>
    range.startOffset === edge.start_offset && range.endOffset === edge.end_offset
  )
  const candidates = exact.length > 0 ? exact : containing.filter(range =>
    range.endOffset - range.startOffset === Math.min(
      ...containing.map(item => item.endOffset - item.startOffset),
    )
  )
  const counts = new Set(candidates.map(range => range.count))
  return counts.size === 1 ? candidates[0].count : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseArgs({allowPositionals: true, strict: true})
    if (parsed.positionals.length < 2) {
      console.error(usage)
      process.exitCode = 1
    } else {
      const [databasePath, ...coveragePaths] = parsed.positionals
      const result = importV8Coverage(databasePath, coveragePaths)
      console.table([result])
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
