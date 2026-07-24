# Branch Reachability Implementation Plan

## Objective

Build a TypeScript compiler-API analysis that answers this counterfactual question:

> If every input to a function had a configured type `T`, which branch edges would TypeScript's control-flow narrowing consider impossible?

The completed prototype answers this for one function at a time and has a bounded CommonJS/direct-call discovery experiment. The next version will make a whole reachable library the unit of analysis, then turn the existing traversal experiment into an explicit and progressively broader call graph. `js-yaml`'s CommonJS `load` implementation remains the integration target.

This is an analysis of TypeScript's model, not proof that code is unreachable at runtime. Results must always retain compiler diagnostics and identify unsupported constructs.

## Current Status

**Phases 1 through 5 are complete, so the initial prototype definition of done is satisfied.** Work now moves from a single-function engine and a narrow discovery experiment to library-level analysis and call-graph expansion.

### Implemented baseline

The implementation lives in `index.ts` and exposes:

- `analyzeSource`, for analyzing supplied TypeScript source text without writing it to disk;
- `analyzeFile`, for loading a file, finding its nearest `tsconfig.json`, and passing it through the same analysis;
- `getAnalysisTableRows` and `printAnalysisResult`, for deterministic `console.table` output;
- structured branch, edge, parameter, diagnostic, and unsupported-construct results.

`discovery.ts` exposes `analyzePackageExport` and `formatPackageAnalysisResult` for CommonJS package-export resolution and bounded direct-call traversal.

The `cli.ts` entry point is available through `npm run analyze`. File mode supports configurable `T`, human-readable or JSON output, explicit `--project`, and `--no-project`. Package mode accepts `--package`, `--export`, `--max-depth`, and `--max-functions`. Both modes accept `--sql <path>` to transactionally upsert edge rows into SQLite.

The `coverage.ts` entry point is available through `npm run coverage`. It imports raw V8 coverage reports into an edge database, matching only true/false edges by exact or smallest-containing original-source spans and summing unambiguous counts across reports.

The analyzer currently overrides all supported parameters with configurable `T` (`string` by default), builds a fresh virtual `Program`, and analyzes `if` statements in statement lists and single-statement positions. It handles TypeScript and JavaScript—including `.js`, `.jsx`, `.cjs`, and `.mjs`—while preserving each source language. It supports block-bodied and unbraced edges, synthesizes missing false edges, and reports each `else if` as a distinct branch. Existing TypeScript annotations and JavaScript JSDoc types are overridden. A function is rejected as a whole if any parameter cannot be overridden safely.

Forty-two tests in `index.test.ts` cover Phases 1 through 5, tabular edge output, SQLite persistence, synthetic V8 range matching, and the five saved `js-yaml` coverage reports. `npm test`, strict TypeScript checking, CLI execution, and `git diff --check` pass.

The `tests/` directory contains manually runnable end-to-end CLI fixtures for basic and nested narrowing, multiple parameters, discriminated unions, counterfactual and generated diagnostics, and unsupported function/branch syntax. Copy-paste commands and expected behavior are documented in `tests/README.md`.

### Current boundaries

- Analysis is still intraprocedural: every selected function independently receives the configured `T` for all supported parameters. Caller argument types and caller narrowing are not propagated.
- Package mode is a prototype specialized to Node's `require` condition, a small set of CommonJS forwarding assignments, and checker-resolved direct calls to local named function declarations.
- Discovery returns a traversal list with one `discoveredFrom` parent. It does not retain every callsite or represent a reusable many-to-many call graph.
- Function expressions, arrow functions, methods, constructors, callbacks, imported callees, most property calls, ESM exports, and dynamic dispatch are not resolved as graph nodes.
- A failure to analyze one discovered function is not yet modeled as a recoverable per-function library result.
- SQLite stores analysis edges, but not library identities, function nodes, callsites, unresolved-call records, or traversal metadata.
- V8 coverage is post-processed against original JavaScript offsets. Transpiled sources still require source-map remapping before import.

### Roadmap at a glance

1. **Phase 6 — Library-level analysis:** make an entry point plus its complete *supported reachable function set* one analysis job. Preserve per-function results and failures, and emit one coherent report/database.
2. **Phase 7 — Call-graph expansion:** promote discovery to explicit function and callsite records, broaden static callee resolution in measured steps, and retain unresolved or ambiguous edges rather than guessing.
3. **Later contextual analysis:** only after the graph is reliable, evaluate caller-to-callee type specialization, aliases, and object-property provenance as separate experiments.

The boundary between Phases 6 and 7 is deliberate. Phase 6 uses the currently supported traversal to establish the library-level contract. Phase 7 improves which functions and relationships that contract can represent. Neither phase should silently introduce interprocedural type propagation.

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
   - Emit deterministic JSON-friendly records and a terminal table rendered with `console.table`.
   - Represent every branch baseline and true/false edge as a row with a location-derived `edge_id`, original start/end line, column and offset, probed types, and `parent_edge_id`.
   - True/false rows reference their branch's baseline row; baseline rows have no parent.
   - Retain classifications in structured results and append diagnostics and unsupported constructs after the table.
   - Persist the same rows with `--sql` using Node's built-in SQLite support, including source/function/type context and baseline-parent foreign keys.

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

### Phase 6: Make the library the unit of analysis — Next

#### Goal

Given one explicit runtime entry point, analyze every function reachable through the **currently supported** discovery rules and return a single durable library result. This phase productizes orchestration; it does not broaden callee resolution or propagate types between functions.

Supported entry-point forms should share one internal target model:

- package plus export under an explicit runtime condition, initially `require`;
- source file plus named function and optional declaration position.

The result must preserve:

- library/job identity and entry-point resolution steps;
- a stable function identity based on canonical source file plus declaration position;
- one independent `AnalysisResult` per function;
- depth and discovery provenance;
- unresolved calls, traversal truncation, unsupported functions, and per-function failures;
- deterministic ordering independent of filesystem or checker iteration order.

#### Implementation sequence

1. Extract entry resolution, traversal, and per-function analysis orchestration from the js-yaml-specific package path into a general library-analysis API.
2. Define a structured result in which successful, unsupported, failed, unresolved, and truncated outcomes cannot be confused.
3. Keep one source-discovery `Program` per library job; continue creating the analyzer's fresh virtual `Program` per function until measurements justify a shared counterfactual program.
4. Make traversal resilient: one unsupported or failed function must be recorded without discarding successful sibling results.
5. Add deterministic library-level human and JSON output, with summaries derived from structured records rather than parsed text.
6. Extend SQLite output with library/function ownership while retaining existing `edges` compatibility and baseline-parent invariants. Design the schema before migration; do not overload `edge_id` to encode graph identity.
7. Establish fixture libraries that exercise multiple files, repeated callees, recursion, unsupported functions, and partial failures before relying on js-yaml alone.

#### Acceptance criteria

- [ ] One command can analyze a file/function or package/export entry point as a library job.
- [ ] Every function reachable under the current supported call rules is analyzed at most once by stable identity.
- [ ] Multiple callers of one function do not duplicate its intraprocedural analysis.
- [ ] Unsupported or failed functions are retained as explicit records and do not abort unrelated reachable analysis.
- [ ] Limits produce deterministic truncation records and never silently omit functions.
- [ ] Human, JSON, and SQLite outputs agree on function, branch, diagnostic, unsupported, unresolved, and truncated counts.
- [ ] Existing single-function CLI/API behavior remains compatible.
- [ ] js-yaml `load` produces a stable library-level regression result at fixed traversal limits.

#### Non-goals

- New callee forms beyond those already supported by Phase 5.
- Caller-specific parameter types or separate analysis per call context.
- Alias, closure-capture, heap, object-property, or return-value propagation.
- Treating unresolved calls as reachable graph edges.

### Phase 7: Expand and persist the call graph — Planned

#### Goal

Replace the traversal tree implicit in `discoveredFrom` with an explicit graph. A graph node is a function identity; a graph edge is a concrete callsite with caller, source location, callee resolution status, and zero or more candidate targets. Traversal should consume this graph rather than being the only place call relationships exist.

#### Resolution increments

Implement and evaluate each increment independently, with fixtures and js-yaml deltas reported before proceeding:

1. **Current direct calls as graph edges:** preserve every local named-function callsite, including repeated calls and calls to already visited functions.
2. **Aliases and function-valued bindings:** resolve simple immutable identifier aliases and named function expressions/arrow functions without flow-sensitive assignment tracking.
3. **Imports and module exports:** resolve relative CommonJS imports first, then ESM imports/exports under an explicit runtime condition. Never conflate `.d.ts` symbols with runtime implementations.
4. **Static property calls:** resolve object-literal/module-namespace properties only when the target is unique and statically demonstrated.
5. **Callbacks:** connect a function argument to a callee parameter only for explicit, modeled APIs or locally visible direct invocation; otherwise retain an unresolved callback relationship.
6. **Methods and constructors:** add only after receiver and declaration identity semantics are defined for overloads, inheritance, and JavaScript prototype assignments.

Dynamic property access, `eval`, runtime mutation, and genuinely polymorphic dispatch remain unresolved unless represented as explicit candidate sets. The graph must expose uncertainty rather than select a convenient declaration.

#### Graph and storage contract

- Stable function-node IDs derive from canonical runtime source identity and declaration span.
- Stable callsite IDs derive from caller identity and original call-expression span.
- Each callsite records its spelling, source location, resolution kind, candidate targets, and unresolved/ambiguous reason where applicable.
- Recursion and mutual recursion are ordinary graph cycles, not errors. Traversal limits apply to expansion work, not graph truth already discovered.
- SQLite graph tables reference function nodes and preserve all callsites, including unresolved ones. Analysis `edges` remain branch edges and must not be conflated with call-graph edges.
- JSON and SQLite must represent the same nodes and callsites; terminal output may summarize them.

#### Acceptance criteria

- [ ] The graph records all supported callsites, not only the first parent that discovered a function.
- [ ] Repeated callers, recursion, and mutual recursion preserve their edges while each function node remains unique.
- [ ] Resolved, ambiguous, unsupported, and unresolved callsites are distinguishable in API, JSON, and SQLite output.
- [ ] Traversal from the entry node is deterministic and produces the Phase 6 reachable function set.
- [ ] Every new resolution form has positive, negative, ambiguity, and cycle tests.
- [ ] js-yaml graph growth is measured after each increment: node count, resolved callsites, unresolved callsites, and analysis-result changes.

### Phase 8: Evaluate contextual interprocedural analysis — Deferred

Only after Phases 6 and 7 establish a trustworthy library result and call graph should analysis become call-context sensitive. Candidate experiments, in increasing complexity, are:

1. specialize a callee parameter from a statically known direct-call argument;
2. analyze distinct call contexts with memoization and explicit widening/budget limits;
3. track a parameter copied into a local alias;
4. track a parameter stored in an object field, as js-yaml does with parser state.

Each experiment needs a concrete fixture, semantics for unions of call contexts, a termination budget, and an observed improvement over independent `T` analysis. Avoid building a general taint or abstract-interpretation engine by accident.

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
- recursive calls and traversal limits;
- library jobs with repeated callees and partial function failures;
- explicit callsites with repeated callers, ambiguity, and graph cycles.

Every regression test should assert structured classifications and original source locations, not only formatted type strings.

Current coverage is split between:

- `index.test.ts`: 42 automated API, compiler-host, TypeScript/JavaScript branch-rewrite, `console.table` formatting, SQLite persistence, V8 coverage import, location-ID/parent linkage, configuration, CLI, CommonJS discovery, traversal-guard, and `js-yaml` integration tests;
- `coverage/v8/js-yaml`: five committed raw V8 reports exercised by the coverage-import regression test;
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
- **Graph completeness claims:** A graph is complete only relative to documented resolution rules. Preserve unresolved and ambiguous callsites so “not resolved” is never mistaken for “not called.”
- **Identity drift:** Function and callsite IDs must use original runtime source locations and remain independent of virtual instrumentation offsets and traversal order.
- **Failure amplification:** Library jobs must isolate per-function analysis failures instead of losing the entire reachable result.
- **Database terminology:** Branch `edges` and call-graph edges are different entities and require distinct schemas and names.
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

## Definition of Done for the Two Extensions

The next implementation stage is complete when it can:

1. accept a file/function or runtime package/export entry point and produce one resilient, deterministic library result;
2. analyze each supported reachable function once while preserving unsupported, failed, unresolved, and truncated records;
3. represent functions and every supported callsite as an explicit cyclic graph rather than only a discovery tree;
4. persist library ownership, function nodes, callsites, and branch-analysis rows without conflating call and branch edges;
5. show reproducible js-yaml node/callsite/analysis counts under fixed configuration; and
6. retain all existing single-function, SQLite-edge, and V8-coverage behavior.

Caller-specific type propagation is not required for these two extensions; it is the subject of the deferred contextual-analysis phase.
