---
name: evaluating-library-reachability
description: Evaluates whether branch-reachability library mode works on a CommonJS package, reports analysis metrics, and separates implementation failures from prototype limitations. Use when testing a library such as js-yaml or sharp.
---

# Evaluating Library Reachability

Evaluate one installed CommonJS library without broadening the analyzer to fit it.

## Workflow

1. Read the Phase 6 limitations in `PLAN.md` and the invariants in `AGENTS.md`.
2. Confirm the package is already installed and resolve its CommonJS entry:

   ```sh
   node -e 'console.log(require.resolve("<package>"))'
   ```

   Use `nix develop -c node ...` when Node is unavailable on `PATH`. Do not install
   or upgrade a package unless the user asks.

3. Check discovery and inventory before running the more expensive full analysis:

   ```sh
   node - <<'NODE'
   const {discoverLibraryFiles, inventoryTopLevelFunctions} = await import('./library.ts')
   const result = discoverLibraryFiles('<entry.js>')
   console.log('status', result.discovery.status)
   console.log('files', result.discovery.files.length)
   console.log('excluded', result.discovery.excludedFiles.length)
   console.log('functions', result.discovery.files.reduce(
     (count, file) => count + inventoryTopLevelFunctions(file).length,
     0,
   ))
   NODE
   ```

4. Run the actual CLI using the resolved entry file:

   ```sh
   npm run analyze -- --library <entry.js>
   ```

   Add `--type '<T>'` only when the user requests a different counterfactual
   parameter type. Use `--json` when exact per-function or per-edge details are
   needed.

5. If the command fails, classify the failure before changing code:
   - entry/runtime loading failure;
   - native addon or platform failure;
   - discovery protocol failure;
   - per-function orchestration failure;
   - documented syntax limitation.

6. Inspect files reporting zero functions when they appear important. Check
   whether they use arrows, function expressions, methods, or callbacks, which
   Phase 6 intentionally does not inventory.

7. Report at least:
   - package version and entry file;
   - discovery status;
   - included and excluded file counts;
   - inventoried, analyzed, and failed function counts;
   - branch and unreachable-edge counts;
   - diagnostic occurrences and unsupported findings;
   - whether native modules loaded or were excluded;
   - the most important known coverage gap.

## Interpretation

- A high diagnostic count is not automatically a failure. Whole-file diagnostics
  repeat for independently analyzed sibling functions, and assigning every
  parameter `T` can intentionally make the counterfactual program invalid.
- Unsupported findings are retained analysis results. They are distinct from
  failed function orchestration.
- “Works” means discovery completes and inventoried functions are analyzed
  without orchestration failure. State clearly that function coverage remains
  limited to direct top-level named declarations.
- Do not add syntax support, loader hooks, sandboxing, or dependency traversal
  merely to improve one evaluation. Document the limitation unless the user asks
  for implementation work.

## Regression policy

Add a regression test only when the package is an intentional stable fixture or
the run exposes a bug being fixed. Prefer broad counts and semantic assertions
over brittle full-output snapshots.
