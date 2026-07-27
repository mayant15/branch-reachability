---
name: investigating-typescript-flow
description: Investigates TypeScript control-flow narrowing and compiler behavior using the local deps/TypeScript source, then turns findings into public-API-safe analyzer changes. Use for unexpected inferred types, never classification, probes, binding, or virtual-source bugs.
---

# Investigating TypeScript Flow

Explain TypeScript behavior from the checked-out compiler source while keeping
production implementation on supported public APIs.

## Workflow

1. Reduce the issue to the smallest source fixture and identify:
   - configured parameter type `T`;
   - baseline location;
   - true or false edge location;
   - expected and actual flow-sensitive type;
   - diagnostics and generated-text involvement.

2. Reproduce through `analyzeSource` or one focused test before reading broad
   compiler code. Preserve the failing structured result and original offsets.

3. Search `deps/TypeScript` locally; do not use the GitHub API:

   ```sh
   rg -n '<symbol-or-syntax-kind>' deps/TypeScript/src/compiler
   ```

   Begin with public declarations and then trace implementation only as far as
   needed. Common ownership areas are:
   - `src/compiler/types.ts`: public checker/type declarations;
   - `src/compiler/binder.ts`: true/false flow-condition construction;
   - `src/compiler/checker.ts`: narrowing and type-at-location behavior.

4. Separate the explanation from the implementation boundary:
   - compiler internals may explain behavior;
   - product code must use the installed `typescript` package and public APIs;
   - never import from `deps/TypeScript` or access private `flowNode` fields.

5. Check analyzer invariants before changing instrumentation:
   - query nodes parsed into the fresh virtual `Program`;
   - verify probe identifiers resolve to the intended parameter symbols;
   - place probes after the binder's branch edge, not beside the condition;
   - detect `never` with `type.flags & ts.TypeFlags.Never`;
   - retain diagnostics from the counterfactual program;
   - map all public locations back to the original source.

6. If virtual edits are implicated, inspect the original source, ordered text
   edits, instrumented source, reparsed target, and probe IDs as separate stages.
   Do not query factory-created nodes or infer correctness from printed text alone.

7. Implement the smallest source-of-truth fix. Prefer changing planner, virtual
   host, probe reader, or classifier behavior directly over adding a one-call-site
   wrapper.

8. Add a focused regression asserting structured classifications, parameter
   types, diagnostics, and original offsets. Then run strict type checking and
   the full test suite using the commands in `AGENTS.md`.

## Interpretation guardrails

- `never` caused at an edge is different from general runtime unreachability due
  to `return`, `throw`, or constant conditions.
- A baseline already typed `never` means inherited unreachability; it must not be
  reported as newly unreachable.
- Flow types need not narrow monotonically because conditions can assign values.
- Type text is for display. Use flags and symbols for semantic decisions.
- Multiple internal `never` objects exist; object identity is invalid.
- Synthetic false edges and virtual parameter annotations must retain original
  offsets in results.

## Expected investigation output

State:

1. the observed behavior;
2. the relevant compiler path with local file/line evidence;
3. whether the behavior is TypeScript semantics or an analyzer bug;
4. the smallest safe public-API implementation change, if any;
5. the regression that proves the fix without depending on compiler internals.
