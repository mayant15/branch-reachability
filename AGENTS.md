# Branch Reachability Agent Guide

## Project intent

This repository is a research prototype for finding branch edges that TypeScript
narrows to `never` after counterfactually assigning every supported function
parameter a configured type `T`.

Prefer the smallest approach that works on representative libraries. Do not turn
documented JavaScript edge cases into implementation blockers. Record important
gaps in `PLAN.md` under limitations and move on unless the user explicitly asks
for broader support.

## Repository map

- `index.ts`: single-function virtual-source instrumentation and analysis.
- `cli.ts`: file, package, and library CLI modes.
- `discovery.ts`: Phase 5 CommonJS export resolution and bounded local-call
  traversal. Keep this separate from Phase 6 runtime library discovery.
- `library.ts`: Phase 6 CommonJS `require.cache` discovery, top-level function
  inventory, and library orchestration.
- `sqlite-output.ts`: branch-edge persistence.
- `coverage.ts`: V8 coverage import into an existing edge database.
- `fuzzer.ts`: random-input fuzzer for V8 coverage generation.
- `index.test.ts`: automated regression suite.
- `tests/`: manually runnable CLI examples; commands live in `tests/README.md`.
- `coverage/v8/js-yaml/`: committed raw V8 regression fixtures.
- `deps/TypeScript/`: authoritative TypeScript source checkout for investigating
  compiler behavior. Read it instead of using GitHub APIs, but never import from
  it in product code.
- `PLAN.md`: completed phases, current roadmap, acceptance criteria, and known
  limitations. Keep it accurate after meaningful milestones.

## Reusable skills

Suggest a new project skill when work reveals a repeatable, multi-step workflow
that would help future agents, especially when it has clear trigger phrases,
special interpretation rules, or easy-to-miss validation steps. Prefer skills
for task-specific procedures; keep repository-wide invariants and conventions in
this `AGENTS.md` instead. Do not create vague helpers, duplicate an existing
skill, or interrupt a focused task merely to package a one-off command. When a
new skill would be useful, briefly propose its name, trigger, and reusable
workflow, and create it only when the user asks or it is part of the task.

## Core invariants

- Never modify analyzed source files. Apply parameter and probe edits only to an
  in-memory copy and build a fresh TypeScript `Program` from that copy.
- Query only parsed nodes owned by the fresh program. Do not query synthetic
  factory nodes or depend on private TypeScript flow-node APIs.
- Override every parameter of a supported target function with `T`, including
  parameters that already have annotations. If any parameter cannot be safely
  overridden, reject the whole function rather than analyzing a subset.
- Preserve original-source locations and offsets in all public results. Virtual
  annotations and probes must not leak edited offsets into edge IDs, tables,
  SQLite, or V8 coverage matching.
- Detect `never` through `type.flags & ts.TypeFlags.Never`, not type-object
  identity or formatted text.
- A true/false branch row must reference its own baseline row. Baseline rows have
  no parent, and every non-baseline parent must resolve to a baseline.
- Keep branch edges distinct from future call-graph edges in names and schemas.
- Diagnostics and unsupported findings are results, not excuses to silently skip
  work or force a green outcome.

## Prototype scope

Honor the limitations documented in `PLAN.md`. In particular, Phase 6 currently:

- executes only trusted CommonJS entry files in a child process;
- discovers synchronous loads left in `require.cache`;
- analyzes package-owned `.js`/`.cjs` files only;
- inventories direct, top-level, named function declarations only;
- ignores nested functions, arrows, methods, callbacks, and function expressions;
- independently analyzes each function with the same configured `T`;
- does not build a call graph or propagate caller types;
- does not persist library ownership to SQLite.

Do not broaden these areas opportunistically. A simple implementation plus an
explicit limitation is preferred over hooks, sandboxing, abstract interpretation,
or general JavaScript modeling without a concrete failing fixture.

## Coding conventions

- Use strict TypeScript and the repository's existing ESM imports with explicit
  `.ts` extensions for local modules.
- Follow the existing compact style: double quotes, no semicolons, and explicit
  parameter and return types on exported functions.
- Use Node built-ins before adding dependencies. Keep source edits focused and
  avoid one-use abstractions or speculative configuration.
- Use canonical absolute paths for internal source identity and original offsets
  for location-derived identities. Display names are not identities.
- Keep output deterministic where practical: preserve source order, runtime load
  order, and stable table column order.
- Human tabular output uses `console.table`; JSON output must come from the same
  structured records rather than reparsing formatted text.
- Do not edit `node_modules/` or `deps/TypeScript/`.

## Testing

Add focused tests to `index.test.ts`. Prefer temporary fixture directories for
library behavior so tests can exercise runtime loading without adding many files.
Use installed `js-yaml` and committed coverage reports for integration regression
tests. Assert structured results and original locations, not only formatted text.

Run the narrowest relevant check while iterating, then before finishing a code
change run:

```sh
npm test
npx tsc --noEmit
git diff --check
```

If `node`, `npm`, or `npx` is unavailable on `PATH`, run commands through the
repository development shell:

```sh
nix develop -c npm test
nix develop -c npx tsc --noEmit
```

Do not regenerate or rewrite the committed V8 JSON fixtures merely to make a test
pass. When changing location semantics, verify explicitly that analyzer offsets
still align with direct JavaScript V8 coverage.
