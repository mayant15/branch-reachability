import path from "node:path"
import {DatabaseSync} from "node:sqlite"
import {getAnalysisTableRows, type AnalysisResult} from "./index.ts"

export function writeAnalysesToSqlite(
  databasePath: string,
  analyses: readonly AnalysisResult[],
): string {
  const resolvedPath = path.resolve(databasePath)
  const database = new DatabaseSync(resolvedPath)
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS edges (
        edge_id TEXT PRIMARY KEY,
        edge TEXT NOT NULL CHECK (edge IN ('baseline', 'true', 'false')),
        classification TEXT NOT NULL CHECK (classification IN ('', 'reachable', 'newly-unreachable', 'inherited-unreachable')),
        entry_probability REAL NOT NULL CHECK (entry_probability >= 0 AND entry_probability <= 1),
        prob_from_fn_entry REAL NOT NULL CHECK (prob_from_fn_entry >= 0 AND prob_from_fn_entry <= 1),
        start_line INTEGER NOT NULL,
        start_col INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        end_col INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        probed_types TEXT NOT NULL,
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
    const insert = database.prepare(`
      INSERT INTO edges (
        edge_id, edge, classification, entry_probability, prob_from_fn_entry,
        start_line, start_col, end_line, end_col,
        start_offset, end_offset, probed_types, parent_edge_id,
        file_name, function_name, type_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(edge_id) DO UPDATE SET
        edge = excluded.edge,
        classification = excluded.classification,
        entry_probability = excluded.entry_probability,
        prob_from_fn_entry = excluded.prob_from_fn_entry,
        start_line = excluded.start_line,
        start_col = excluded.start_col,
        end_line = excluded.end_line,
        end_col = excluded.end_col,
        start_offset = excluded.start_offset,
        end_offset = excluded.end_offset,
        probed_types = excluded.probed_types,
        parent_edge_id = excluded.parent_edge_id,
        file_name = excluded.file_name,
        function_name = excluded.function_name,
        type_text = excluded.type_text
    `)

    database.exec("BEGIN IMMEDIATE")
    try {
      for (const analysis of analyses) {
        for (const row of getAnalysisTableRows(analysis)) {
          insert.run(
            row.edge_id,
            row.edge,
            row.classification,
            row.entry_probability,
            row.prob_from_fn_entry,
            row.start_line,
            row.start_col,
            row.end_line,
            row.end_col,
            row.start_offset,
            row.end_offset,
            row.probed_types,
            row.parent_edge_id || null,
            analysis.fileName,
            analysis.functionName,
            analysis.typeText,
          )
        }
      }
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  } finally {
    database.close()
  }
  return resolvedPath
}

export function writeAnalysisToSqlite(
  databasePath: string,
  analysis: AnalysisResult,
): string {
  return writeAnalysesToSqlite(databasePath, [analysis])
}
