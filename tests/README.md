# CLI Examples

Run these commands from the repository root.

## Impossible `typeof` edge

The default configured type is `string`, even though `value` is originally annotated as `number`. The true edge becomes `never`.

```sh
npm run analyze -- tests/basic.ts classify
```

## Multiple parameters

Every parameter is replaced with `string`. The outer true edge is reachable, while the nested `count`-is-a-number edge and the outer false edge are unreachable.

```sh
npm run analyze -- tests/multiple-parameters.ts compare
```

Use `--json` to inspect the structured result:

```sh
npm run analyze -- --json tests/multiple-parameters.ts compare
```

## Inherited unreachable branches

With the default `string` input, the outer number edge is unreachable. Both edges of the nested branch inherit that impossibility.

```sh
npm run analyze -- tests/nested.ts inspect
```

Analyze the same function with its original union instead:

```sh
npm run analyze -- --type 'string | number' tests/nested.ts inspect
```

## Discriminated union narrowing

Pass an object union as the configured input type. Both top-level edges remain reachable and show their narrowed object variants.

```sh
npm run analyze -- \
  --type '{kind: "text"; value: string} | {kind: "count"; value: number}' \
  tests/discriminated-union.ts render
```

## Counterfactual diagnostics

Replacing `value: number` with the default `string` makes the assignment `value = 123` invalid. The branch result is still reported, followed by TypeScript diagnostic TS2322 at the original source location.

```sh
npm run analyze -- tests/diagnostics.ts assignNumber
```

An invalid configured type also produces a diagnostic marked as originating in generated analysis text:

```sh
npm run analyze -- --type 'MissingType' tests/basic.ts classify
```

## JavaScript with existing JSDoc

The analyzer keeps the file in JavaScript mode and overrides the existing `@param {number}` type with inline `@type {string}` JSDoc in its virtual source.

```sh
npm run analyze -- tests/javascript.js classifyJavaScript
```

## Package export and call-chain discovery

Resolve `js-yaml` through Node's CommonJS `require` condition, follow its forwarded `load` export, and recursively analyze direct local callees. The default traversal depth is 3.

```sh
npm run analyze -- --package js-yaml --export load
```

Limit the result to the exact `load` to `loadDocuments` chain:

```sh
npm run analyze -- --package js-yaml --export load --max-depth 1
```

Structured package results include export-resolution steps, complete per-function analyses, unresolved calls, and functions omitted by traversal guards:

```sh
npm run analyze -- --package js-yaml --export load --max-depth 1 --json
```

## Unsupported functions and branches

Phase 1 requires every parameter to be a simple identifier without rest syntax or a default. Each of these commands rejects the entire selected function and explains why:

```sh
npm run analyze -- tests/unsupported.ts restParameter
npm run analyze -- tests/unsupported.ts defaultParameter
npm run analyze -- tests/unsupported.ts destructuredParameter
npm run analyze -- tests/unsupported.ts explicitThis
```

Wrapping an unbraced declaration in a probe block would change the declaration's scope, so that branch is also rejected instead of being rewritten unsafely:

```sh
npm run analyze -- tests/unsupported.ts declarationScope
```

`unsupported.ts` intentionally uses constructs that cannot be instrumented without changing the analysis contract or source semantics.
