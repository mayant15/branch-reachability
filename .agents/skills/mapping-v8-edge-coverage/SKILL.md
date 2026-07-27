---
name: mapping-v8-edge-coverage
description: Generates Node V8 coverage, imports hit counts into a branch-edge SQLite database, validates span matching, and interprets covered branches. Use for NODE_V8_COVERAGE, edge_coverage, or runtime-hit questions.
---

# Mapping V8 Edge Coverage

Map direct JavaScript V8 ranges to previously generated branch-analysis rows.

## Preconditions

- Coverage offsets must refer to the same runtime JavaScript source stored in the
  `edges.file_name` rows.
- Analyzer parameter annotations and probes are virtual; stored edge offsets are
  original-source offsets and align with direct JavaScript coverage.
- Transpiled TypeScript or bundled output requires source-map remapping before
  this importer can make valid claims.
- Library mode currently rejects `--sql`; create edge databases through file or
  package mode.

## Workflow

1. Generate the edge database:

   ```sh
   npm run analyze -- --sql edges.sqlite <file.js> <function>
   # or
   npm run analyze -- --package <package> --export <export> --sql edges.sqlite
   ```

2. Remove or choose a fresh coverage output directory, then run representative
   scenarios separately:

   ```sh
   NODE_V8_COVERAGE=coverage/v8/<scenario> node <scenario-command>
   ```

   Do not delete existing untracked or committed reports without explicit
   approval. Keep reports in Git only when the user requests durable fixtures.

3. Confirm each report contains the expected runtime script URL and block ranges.
   Use a small Node script rather than dumping the full JSON to the terminal.

4. Import one report, several reports, or a directory recursively:

   ```sh
   npm run coverage -- edges.sqlite coverage/v8/<package>
   ```

   Every import transactionally replaces `edge_coverage`. Counts from supplied
   reports are summed.

5. Inspect mapped rows:

   ```sql
   SELECT e.file_name, e.function_name, e.edge,
          e.start_offset, e.end_offset, c.hit_count
   FROM edge_coverage AS c
   JOIN edges AS e USING (edge_id)
   ORDER BY e.file_name, e.function_name, e.start_offset, e.edge;
   ```

6. Verify that no baseline row received coverage:

   ```sql
   SELECT COUNT(*)
   FROM edge_coverage AS c
   JOIN edges AS e USING (edge_id)
   WHERE e.edge = 'baseline';
   ```

   The result must be zero.

## Matching contract

- Match true and false edges only; never map baselines.
- A V8 range must contain the edge's complete span:

  ```text
  range.startOffset <= edge.start_offset
  range.endOffset   >= edge.end_offset
  ```

- Prefer an exact span. Otherwise use the smallest containing span.
- An exact zero-width V8 continuation range can map a synthesized zero-width
  false edge.
- If equally specific candidates disagree on count, leave that report unmapped
  for the edge.
- Do not use overlap, adjacency, parent hit counts, or inferred branch behavior.
- An absent `edge_coverage` row means no unambiguous match; `hit_count = 0` means
  an unambiguous matching V8 range executed zero times.

## Validation

When changing matching behavior, run the synthetic range test and the committed
`coverage/v8/js-yaml` regression. Assert exact, containing, ambiguous, zero-width,
zero-count, and baseline-exclusion behavior.

Report coverage-file count, candidate true/false edges, mapped edges, zero-hit
edges, unmapped edges, and any source-path mismatch.
