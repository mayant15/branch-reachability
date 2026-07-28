# Branch Reachability

Use TypeScript's API to detect "difficult" branches taking advantage of TypeScript's built-in
type narrowing capabilities.

[Generated with Amp](https://ampcode.com/threads/T-019f85c6-4f88-72c1-a97e-43f5b59c40b7).

## Algorithm
- Configure function inputs either with one uniform `T` (`string` by default) or
  with `--decl <file.d.ts>`, which uses matching public declarations and preserves
  TypeScript/JSDoc/inferred types for unmatched private functions.
- Before each branch record the inferred type of all function inputs
- After each branch record the inferred type of all function inputs. If the branch had any narrowing
constraint (like `typeof` checks) types should now be smaller (or equal).
- If a branch makes any function input `never`, that branch is `unreachable`.

Each result records a stable function-plus-parameter-types context ID. This keeps
uniform and TypeScript-defined library analysis on the same core API and provides
the context key needed for future callsite-sensitive analysis.

## Scalability Challenges

The above algorithm works with one function at a time. How do we work with calls to other functions?
Approximate them? Nest our analysis and analyze the callee before proceeding?

Try working with `js-yaml`'s exported `load` function. Immediately we notice that:
1. The function comes from a `require` and is not in the `index.js` itself, and
2. The function itself is fairly small and delegates to `loadDocuments` instead.
