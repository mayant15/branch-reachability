# Branch Reachability Implementation Plan

## Objective

Build a TypeScript compiler-API prototype that answers this counterfactual question:

> If every input to a function had a configured type `T`, which branch edges would TypeScript's control-flow narrowing consider impossible?

The first useful version will analyze one function at a time, use `string` as `T`, and support `if` statements. Later versions will discover callees across files and apply the same intraprocedural analysis to them, with `js-yaml`'s CommonJS `load` implementation as the integration target.

This is an analysis of TypeScript's model, not proof that code is unreachable at runtime. Results must always retain compiler diagnostics and identify unsupported constructs.

## Current Status

**Phases 1 through 5 are complete, so the initial prototype definition of done is satisfied.** The implementation lives in `index.ts` and exposes:

- `analyzeSource`, for analyzing supplied TypeScript source text without writing it to disk;
- `analyzeFile`, for loading a file, finding its nearest `tsconfig.json`, and passing it through the same analysis;
- `formatAnalysisResult`, for deterministic human-readable output;
- structured branch, edge, parameter, diagnostic, and unsupported-construct results.

`discovery.ts` exposes `analyzePackageExport` and `formatPackageAnalysisResult` for CommonJS package-export resolution and bounded direct-call traversal.

The `cli.ts` entry point is available through `npm run analyze`. File mode supports configurable `T`, human-readable or JSON output, explicit `--project`, and `--no-project`. Package mode accepts `--package`, `--export`, `--max-depth`, and `--max-functions`.

The analyzer currently overrides all supported parameters with configurable `T` (`string` by default), builds a fresh virtual `Program`, and analyzes `if` statements in statement lists and single-statement positions. It handles TypeScript and JavaScript—including `.js`, `.jsx`, `.cjs`, and `.mjs`—while preserving each source language. It supports block-bodied and unbraced edges, synthesizes missing false edges, and reports each `else if` as a distinct branch. Existing TypeScript annotations and JavaScript JSDoc types are overridden. A function is rejected as a whole if any parameter cannot be overridden safely.

Thirty-seven tests in `index.test.ts` cover Phases 1 through 5. `npm test`, strict TypeScript checking, CLI execution, and `git diff --check` pass as of the Phase 5 implementation.

The `tests/` directory contains manually runnable end-to-end CLI fixtures for basic and nested narrowing, multiple parameters, discriminated unions, counterfactual and generated diagnostics, and unsupported function/branch syntax. Copy-paste commands and expected behavior are documented in `tests/README.md`.

## Compiler API Strategy

Use the installed `typescript` package for the implementation and `deps/TypeScript` as the authoritative source for understanding its behavior. Do not depend on compiler internals or patch the TypeScript checkout.

The important compiler constraints are:

- The public query is `TypeChecker.getTypeAtLocation(node)` ([API declaration](deps/TypeScript/src/compiler/types.ts)).
- Flow-sensitive types are computed internally from the flow node attached to a parsed reference ([checker implementation](deps/TypeScript/src/compiler/checker.ts)). There is no supported API for asking for a variable's type at an arbitrary source position.
- The checker accepts parse-tree nodes and maps them back to the program's tree. Factory-created nodes that were never parsed as part of the analyzed `Program` are therefore not reliable query targets.
- `never` must be detected with `type.flags & ts.TypeFlags.Never`, not by object identity. The compiler has multiple internal `never` values.
- The binder only creates true/false flow conditions for narrowing expressions ([binder implementation](deps/TypeScript/src/compiler/binder.ts)). Probes must therefore be placed on branch edges after the original condition has been bound.

Consequently, analysis creates an **in-memory edited copy of the source**, reparses it in a fresh `Program`, and queries identifiers in parsed probe expressions. Original files are never modified.

## Analysis Semantics

For each supported `if` statement in the selected function, define three probe points:

1. **Baseline:** immediately before evaluating the `if` condition.
2. **True edge:** at the start of the consequent.
3. **False edge:** at the start of an explicit `else` consequent.

At every probe, record the flow-sensitive type of every parameter. Classify each edge per parameter as:

- **newly unreachable:** baseline is not `never`, but the edge type is `never`;
- **inherited unreachable:** baseline is already `never`;
- **reachable under this check:** the edge type is not `never`.

Classify the edge as newly unreachable if any parameter newly becomes `never`. Preserve per-parameter results so users can see which input caused the classification.

Do not require every edge type to be assignable to its baseline type. A condition can assign to a parameter, so control-flow types are not guaranteed to narrow monotonically.

The initial analysis deliberately excludes general control-flow unreachability caused by `return`, `throw`, or constant conditions. The compiler represents some such paths with an internal unreachable flow value that `getTypeAtLocation` may expose as the declared type. Detecting those paths would require a separate, explicitly designed analysis rather than interpreting all non-`never` probe results as proof of reachability.

## Proposed Components

Keep the first implementation small, but separate these responsibilities so the call-graph work does not become coupled to source rewriting:

1. **Configuration and target selection**
   - Input file, function selector, configured type text, compiler options, and optional traversal limits.
   - Initially select a function by file plus declared name.

2. **Source planner**
   - Parse the original file.
   - Locate the selected function, all of its parameters, and supported branches.
   - Produce text edits plus stable probe metadata tied to original file positions.
   - Reject unsupported syntax explicitly instead of partially analyzing it.

3. **Virtual program builder**
   - Apply edits in memory.
   - Serve edited files through a `CompilerHost`; delegate all untouched files to the normal host.
   - Build a fresh `Program` with `noEmit` and the project's module-resolution settings.
   - Retrieve all query nodes from the `SourceFile` owned by that `Program`.

4. **Probe reader and classifier**
   - Find probe identifiers by unique marker IDs.
   - Call `getTypeAtLocation`, format with `typeToString`, and inspect `TypeFlags.Never`.
   - Map edited positions back to original branch locations using planner metadata.
   - Return structured results plus syntactic and semantic diagnostics.

5. **Reporter**
   - Start with deterministic JSON-friendly records and a concise terminal rendering.
   - Include target, branch location, edge, baseline/edge types per parameter, classification, diagnostics, and unsupported constructs.

6. **Function discovery**
   - Resolve package exports, CommonJS forwarding assignments, local calls, and recursively discovered declarations.
   - Feed each discovered function independently into the same analyzer.
   - Record unresolved calls and traversal truncation instead of guessing.

## Source Instrumentation

### TypeScript inputs

Override **every parameter** of the selected function with `T`, including parameters that already have type annotations:

- add `: T` to each unannotated parameter;
- replace every existing parameter annotation with `T`;
- leave the original file untouched and record the replaced span for diagnostics/location mapping.

The initial implementation only supports functions whose parameters are all non-rest identifiers without default initializers. Destructuring, rest parameters, parameter properties, and defaults need separate rewrite policies. Until those policies are implemented, encountering any such parameter makes the entire function unsupported; the analyzer must never override only a subset of its inputs.

Insert probe statements containing direct references to every parameter, for example an array expression under `void`. Each statement must carry a unique marker. Avoid helper calls because calls can participate in control-flow analysis and introduce avoidable side effects into the counterfactual program.

Instrumentation uses the smallest virtual rewrite appropriate to each branch shape:

- insert directly into existing blocks and statement lists;
- wrap unbraced edges and an `if` in a single-statement parent with virtual blocks;
- synthesize a probe-only `else` when the source has no false body;
- order insertions by nesting depth so dangling `else`, nested missing edges, loops, and labels retain their original control-flow structure.

Before wrapping, inspect the affected single-statement chain for declarations whose scope would change. Report such a branch as unsupported without applying partial edits. Reparse all accepted rewrites and verify that each probe identifier still resolves to the selected parameter symbol; report branches with shadowed probes as unsupported.

### JavaScript inputs

JavaScript sources remain in JavaScript mode with `allowJs`, `checkJs`, and `noEmit`; the analyzer never prints TypeScript annotations into JavaScript. Standalone JavaScript defaults to non-strict checking to avoid unrelated implicit-`any` noise, while discovered or explicit project settings can enable strictness. JSX defaults to preserved JSX when no project setting overrides it.

Every supported parameter receives an inline `/** @type {T} */` annotation immediately before its identifier. This takes precedence over existing function-level `@param` and inline `@type` annotations without deleting source comments. Optional JSDoc parameters are rejected because their existing optionality would retain `undefined` and violate the exact-`T` invariant. If any parameter cannot be overridden safely, the entire function is unsupported rather than analyzing a subset. As with TypeScript, the edited JavaScript is reparsed and only nodes from the fresh program are queried.

## Delivery Phases

### Phase 1: Prove flow-sensitive probes on TypeScript fixtures — Complete

Implemented one-file, one-function analysis for block-bodied `if`/`else` statements and simple identifier parameters.

Acceptance criteria:

- [x] Given `x: string`, `typeof x === "number"` reports the true edge as newly unreachable and the false edge as reachable.
- [x] Given `x: string`, `typeof x === "string"` reports the false edge as newly unreachable.
- [x] Multiple inputs are recorded independently, and one newly-`never` input marks the edge unreachable.
- [x] A nested branch below an already-`never` edge is classified as inherited unreachable.
- [x] Newly unreachable takes precedence at edge level when another parameter is already inherited-unreachable.
- [x] Nested functions are excluded, and a branch whose probe would bind to a shadowing local is reported as unsupported.
- [x] Original source files remain unchanged because all edits are held by the virtual compiler host.
- [x] Branch locations and diagnostics are mapped to original source positions; diagnostics originating in generated text are marked.
- [x] Compiler diagnostics from the counterfactual program are included in output.
- [x] Existing parameter annotations are replaced for every parameter.
- [x] Unsupported rest, defaulted, destructured, `this`, or modified parameters reject the entire function.
- [x] User-authored marker-like expressions cannot collide with generated probes.

### Phase 2: Make the analysis usable — Complete

- [x] Add a small CLI for file, function, and type selection.
- [x] Add deterministic human-readable output alongside JSON structured output.
- [x] Load compiler options from the nearest `tsconfig.json` when present, with explicit defaults for standalone fixtures.
- [x] Support an explicit config path and an option to disable config discovery.
- [x] Report “unsupported” separately from “reachable”; never silently skip a parameter or branch.
- [x] Add focused tests around source edits, marker lookup, diagnostics, symbol binding, and location mapping.

### Phase 3: Expand `if` coverage — Complete

Completed with semantic-preservation tests:

- [x] Unbraced consequents and alternatives.
- [x] Absent `else` via a probe-only false edge.
- [x] `else if` chains with clear edge identities.
- [x] Branches nested under loops, labels, and other single-statement parents.
- [x] Dangling-`else` preservation under nested virtual wrappers.
- [x] Shared-position edit ordering for nested wrappers and synthetic edges.
- [x] Rejection of direct or chained unbraced declarations when wrapping would change scope.

Do not add `switch` or conditional expressions in this phase. `switch` requires a defined policy for fallthrough and merged case flow. Conditional expressions require expression-level instrumentation, which has different contextual-typing risks from statement probes.

### Phase 4: Analyze JavaScript functions — Complete

- [x] Add inline JSDoc-based parameter overrides without changing JavaScript language mode.
- [x] Validate that probe identifiers in `.js` receive flow-sensitive types under `checkJs`.
- [x] Test existing JSDoc, optional JSDoc, CommonJS, JSX, CJS, and MJS syntax and settings.
- [x] Analyze `node_modules/js-yaml/lib/loader.js` functions directly before package-level discovery.

Integration result with `T = string`:

- `load`: 2 `if` conditions, 4 edges, all reachable for both `input` and `options`;
- `loadDocuments`: 4 `if` conditions, 8 edges, all reachable for both parameters;
- no parameter-based unreachable edge is found because these conditions inspect `documents`, string contents, or local positions rather than narrow a parameter's possible type;
- `loadDocuments` reports the expected counterfactual TS2322 at `options = options || {}` because `{}` is not assignable to the injected `string` type.

### Phase 5: Discover the `js-yaml` call chain — Complete

Implemented as source discovery, not interprocedural type propagation.

Start from an explicit runtime target such as:

```text
package: js-yaml
module condition: require
export: load
```

Supported forms:

- [x] `const`/`var x = require("./relative")`;
- [x] `module.exports.name = x.property`;
- [x] `module.exports.name = localIdentifier` and `exports.name = localIdentifier`;
- [x] effective final assignment and final merged function-declaration semantics;
- [x] direct calls to local function declarations using checker-resolved symbols;
- [x] canonical file/declaration-position identities and cycle protection;
- [x] configurable depth and function-count guards;
- [x] explicit unresolved-call and truncated-function records;
- [x] human-readable and JSON package-mode CLI output.

The first integration path should resolve:

```text
js-yaml/index.js: module.exports.load
  -> js-yaml/lib/loader.js: module.exports.load
  -> function load
  -> function loadDocuments
```

Use canonical file plus declaration position as function identity. Add visited-set, maximum-depth, and maximum-function guards. Report dynamic or unresolved calls rather than guessing.

Do not rely on the imported `load` symbol in this repository's `index.ts` to find the runtime implementation: TypeScript can resolve that import to `@types/js-yaml`, while the package selects different runtime files for ESM import and CommonJS require.

`js-yaml` integration results:

- depth 1 resolves and analyzes exactly `load → loadDocuments`, with `throwError` and `readDocument` explicitly depth-truncated;
- the default depth-3 traversal analyzes 13 functions, records 50 unresolved or non-identifier calls, and records 10 depth-truncated functions;
- across those 13 functions, `composeNode` contains one newly unreachable edge at line 1430: the true edge of `CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext` narrows configured `nodeContext: string` to `never`;
- package resolution uses Node's actual `require` resolver. The supported CommonJS assignment forms are inspected statically; executing package code remains an available future fallback for more dynamic export patterns.

### Phase 6: Evaluate interprocedural value — Next

After collecting real `js-yaml` results, decide whether call traversal alone is useful. Independently analyzing callees does not propagate caller argument types, aliases, or object-property provenance.

Likely next experiments, in increasing complexity, are:

1. specialize a callee's parameter type from a statically resolved call argument;
2. analyze each distinct call context with memoization and widening limits;
3. track a parameter copied into a local variable;
4. track a parameter stored in an object field, as `js-yaml` does with parser state.

Each experiment needs a concrete fixture and budget before implementation. Avoid building a general taint engine until direct branch and call-chain results demonstrate the need.

## Test Matrix

Maintain small source fixtures covering:

- `typeof`, equality, null checks, discriminated unions, `in`, and user-defined type guards;
- true-edge and false-edge `never`;
- multiple parameters;
- assignments in conditions;
- nested branches and inherited impossibility;
- shadowing and nested function boundaries;
- syntax/semantic errors in the counterfactual source;
- existing TypeScript annotations;
- existing JavaScript JSDoc;
- unsupported parameter and branch forms;
- CommonJS re-export and direct-call discovery;
- recursive calls and traversal limits.

Every regression test should assert structured classifications and original source locations, not only formatted type strings.

Current coverage is split between:

- `index.test.ts`: 37 automated API, compiler-host, TypeScript/JavaScript branch-rewrite, formatting, configuration, CLI, CommonJS discovery, traversal-guard, and `js-yaml` integration tests;
- `tests/basic.ts`, `multiple-parameters.ts`, `nested.ts`, and `discriminated-union.ts`: successful CLI analysis examples;
- `tests/diagnostics.ts`: diagnostics produced by the counterfactual parameter type;
- `tests/javascript.js`: JavaScript analysis with existing JSDoc and CommonJS export syntax;
- `tests/unsupported.ts`: rest, defaulted, destructured, explicit-`this`, and declaration-scope unsupported examples;
- `tests/README.md`: commands for human-readable, JSON, custom-type, diagnostic, and unsupported runs.

## Risks and Guardrails

- **False certainty:** Label output as “unreachable under TypeScript narrowing with configured input type,” not runtime-unreachable.
- **Invalid counterfactual programs:** Changing parameter types can make assignments and calls invalid. Keep diagnostics attached to results; do not hide them to obtain a classification.
- **Synthetic-node misuse:** Always reparse edited text and query the fresh `Program`'s nodes.
- **Behavior-changing instrumentation:** Prefer direct reference expressions and initially reject placements that require structural rewrites.
- **Compiler-version coupling:** Stay on public APIs. Use `deps/TypeScript` to explain behavior, but do not import from its source tree or depend on internal `flowNode` structures.
- **JavaScript module ambiguity:** Resolve the requested runtime condition explicitly rather than conflating declaration files, ESM bundles, and CommonJS sources.
- **Scope explosion:** Keep branch-kind expansion, JavaScript rewriting, source discovery, and contextual interprocedural analysis as separate milestones.
- **Limited `js-yaml` signal:** `loadDocuments` quickly copies `input` into state and branches on state properties. Parameter-only analysis may find little; report that outcome rather than broadening provenance tracking implicitly.

## Definition of Done for the Prototype

The prototype is complete when it can:

1. analyze supported `if` edges in a selected TypeScript or JavaScript function under configurable `T`;
2. report baseline and edge types for every parameter with correct newly/inherited-unreachable classification;
3. retain diagnostics, unsupported constructs, and original locations;
4. resolve and independently analyze the `js-yaml` chain from CommonJS `load` to `loadDocuments` within bounded traversal; and
5. run a focused automated test suite without modifying analyzed source files.

Context-sensitive call analysis and parameter-to-object-property provenance are explicitly outside this initial definition of done.
