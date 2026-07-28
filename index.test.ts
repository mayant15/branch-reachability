import assert from "node:assert/strict"
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"
import {DatabaseSync} from "node:sqlite"
import {fileURLToPath, pathToFileURL} from "node:url"
import test from "node:test"
import ts from "typescript"
import {importV8Coverage} from "./coverage.ts"
import {analyzePackageExport, formatPackageAnalysisResult} from "./discovery.ts"
import {analyzeFile, analyzeSource, getAnalysisTableRows} from "./index.ts"
import {analyzeLibrary, discoverLibraryFiles, inventoryTopLevelFunctions} from "./library.ts"
import {writeAnalysesToSqlite} from "./sqlite-output.ts"

function analyze(sourceText: string, typeText = "string") {
  return analyzeSource({
    fileName: "/virtual/fixture.ts",
    sourceText,
    functionName: "target",
    typeText,
  })
}

function analyzeJavaScript(sourceText: string, typeText = "string") {
  return analyzeSource({
    fileName: "/virtual/fixture.js",
    sourceText,
    functionName: "target",
    typeText,
  })
}

test("records default and explicit uniform input origins without changing context identity", () => {
  const sourceText = `function target(value) {
  if (typeof value === "number") return value
}`
  const defaultInput = analyzeSource({
    fileName: "/virtual/uniform.ts",
    sourceText,
    functionName: "target",
  })
  const explicitInput = analyzeSource({
    fileName: "/virtual/uniform.ts",
    sourceText,
    functionName: "target",
    typeText: "string",
  })
  const differentInput = analyzeSource({
    fileName: "/virtual/uniform.ts",
    sourceText,
    functionName: "target",
    typeText: "number",
  })

  assert.equal(defaultInput.input.parameters[0].origin, "uniform-default")
  assert.equal(explicitInput.input.parameters[0].origin, "uniform-explicit")
  assert.equal(defaultInput.input.contextId, explicitInput.input.contextId)
  assert.notEqual(defaultInput.input.contextId, differentInput.input.contextId)
})

test("overrides an existing annotation and detects a never true edge", () => {
  const source = `
function target(value: number) {
  if (typeof value === "number") {
    console.log(value)
  } else {
    console.log(value)
  }
}
`
  const result = analyze(source)

  assert.equal(result.branches.length, 1)
  assert.deepEqual(
    result.branches[0].edges.map(edge => [edge.edge, edge.classification]),
    [["true", "newly-unreachable"], ["false", "reachable"]],
  )
  assert.equal(result.branches[0].edges[0].parameters[0].baselineType, "string")
  assert.equal(result.branches[0].edges[0].parameters[0].edgeType, "never")
  assert.equal(result.branches[0].line, 3)
  assert.equal(source.includes(": number"), true)
})

test("detects a never false edge", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "string") {
    console.log(value)
  } else {
    console.log(value)
  }
}
`)

  assert.deepEqual(
    result.branches[0].edges.map(edge => [edge.edge, edge.classification]),
    [["true", "reachable"], ["false", "newly-unreachable"]],
  )
})

test("records all parameters and marks an edge unreachable if one becomes never", () => {
  const result = analyze(`
function target(value, other: boolean) {
  if (typeof value === "number") {
    console.log(value, other)
  } else {
    console.log(value, other)
  }
}
`)
  const trueEdge = result.branches[0].edges[0]

  assert.equal(trueEdge.classification, "newly-unreachable")
  assert.deepEqual(trueEdge.parameters.map(parameter => parameter.name), ["value", "other"])
  assert.deepEqual(trueEdge.parameters.map(parameter => parameter.baselineType), ["string", "string"])
  assert.deepEqual(trueEdge.parameters.map(parameter => parameter.edgeType), ["never", "string"])
  assert.deepEqual(trueEdge.parameters.map(parameter => parameter.entryProbability), [0, 1])
  assert.equal(trueEdge.entryProbability, 0)
})

test("computes entry probability from union type narrowing", () => {
  const result = analyze(`
type Shape = {kind: "circle"; radius: number} | {kind: "square"; side: number}
function target(value: Shape) {
  if (value.kind === "circle") {
    console.log(value)
  } else {
    console.log(value)
  }
}
`, "Shape")
  const branch = result.branches[0]
  assert.equal(branch.edges[0].edge, "true")
  assert.equal(branch.edges[0].classification, "reachable")
  assert.equal(branch.edges[0].entryProbability, 0.5)
  assert.equal(branch.edges[1].edge, "false")
  assert.equal(branch.edges[1].classification, "reachable")
  assert.equal(branch.edges[1].entryProbability, 0.5)
})

test("probFromFnEntry is the cumulative product along the enclosing edge chain", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "string") {
    if (typeof value === "number") {
      console.log(value)
    } else {
      console.log(value)
    }
  }
}
`)
  const [outer, inner] = result.branches
  const outerTrue = outer.edges.find(e => e.edge === "true")!
  const outerFalse = outer.edges.find(e => e.edge === "false")!
  assert.equal(outerTrue.classification, "reachable")
  assert.equal(outerFalse.classification, "newly-unreachable")
  assert.equal(outerTrue.entryProbability, 1)
  assert.equal(outerTrue.probFromFnEntry, 1)
  assert.equal(outerFalse.entryProbability, 0)
  assert.equal(outerFalse.probFromFnEntry, 0)

  const innerTrue = inner.edges.find(e => e.edge === "true")!
  const innerFalse = inner.edges.find(e => e.edge === "false")!
  assert.equal(innerTrue.classification, "newly-unreachable")
  assert.equal(innerFalse.classification, "reachable")
  assert.equal(innerTrue.entryProbability, 0)
  assert.equal(innerTrue.probFromFnEntry, 0)
  assert.equal(innerFalse.entryProbability, 1)
  assert.equal(innerFalse.probFromFnEntry, 1)

  const rows = getAnalysisTableRows(result)
  const innerFalseRow = rows.find(r => r.edge_id === innerFalse.edgeId)!
  assert.equal(innerFalseRow.prob_from_fn_entry, 1)
})

test("probFromFnEntry multiplies through multiple nesting levels", () => {
  const result = analyze(`
function target(a: "x" | "y" | "z") {
  if (a === "x") {
    if (a === "y") {
      console.log(a)
    }
  }
}
`, `"x" | "y" | "z"`)
  const outer = result.branches[0]
  const inner = result.branches[1]
  const outerTrue = outer.edges.find(e => e.edge === "true")!
  assert.equal(outerTrue.entryProbability, 1 / 3)
  assert.equal(outerTrue.probFromFnEntry, 1 / 3)

  const innerTrue = inner.edges.find(e => e.edge === "true")!
  assert.equal(innerTrue.entryProbability, 0)
  assert.equal(innerTrue.probFromFnEntry, 0)
})

test("entry probability reflects constituent ratio for boolean narrowing", () => {
  const result = analyze(`
function target(value: boolean) {
  if (value) {
    console.log(value)
  } else {
    console.log(value)
  }
}
`, "boolean")
  const branch = result.branches[0]

  assert.equal(branch.edges[0].edge, "true")
  assert.equal(branch.edges[1].edge, "false")
  assert.equal(branch.edges[0].classification, "reachable")
  assert.equal(branch.edges[1].classification, "reachable")
  assert.equal(branch.edges[0].entryProbability, 0.5)
  assert.equal(branch.edges[1].entryProbability, 0.5)
  assert.equal(
    branch.edges[0].parameters[0].baselineType,
    branch.edges[1].parameters[0].baselineType,
  )
})

test("entry probability is 1 for inherited-unreachable edges", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "number") {
    if (value === 1) {
      console.log(value)
    }
  }
}
`)
  const inner = result.branches.find(branch => branch.condition === "value === 1")!
  assert.equal(inner.edges[0].classification, "inherited-unreachable")
  assert.equal(inner.edges[0].entryProbability, 1)
  assert.equal(inner.edges[1].classification, "inherited-unreachable")
  assert.equal(inner.edges[1].entryProbability, 1)
})

test("classifies nested branches below an impossible edge as inherited unreachable", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "number") {
    if (value === 1) {
      console.log(value)
    } else {
      console.log(value)
    }
  } else {
    console.log(value)
  }
}
`)

  assert.equal(result.branches.length, 2)
  const nested = result.branches.find(branch => branch.condition === "value === 1")!
  assert.equal(nested.edges[0].parameters[0].baselineType, "never")
  assert.equal(nested.edges[0].classification, "inherited-unreachable")
  assert.equal(nested.edges[1].classification, "inherited-unreachable")
})

test("does not analyze branches in nested functions", () => {
  const result = analyze(`
function target(value) {
  function nested(value: number) {
    if (typeof value === "number") {
      console.log(value)
    }
  }
  if (typeof value === "string") {
    console.log(value)
  }
}
`)

  assert.equal(result.branches.length, 1)
  assert.equal(result.branches[0].condition, 'typeof value === "string"')
})

test("reports a branch unsupported when a local shadows a parameter probe", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "string") {
    let value = 1
    console.log(value)
  }
}
`)

  assert.equal(result.branches.length, 0)
  assert.equal(result.unsupported.length, 1)
  assert.match(result.unsupported[0].reason, /shadowed/)
})

test("newly unreachable takes precedence when another parameter is inherited", () => {
  const result = analyze(`
function target(first, second) {
  if (typeof first === "number") {
    if (typeof second === "number") {
      console.log(first, second)
    }
  }
}
`)
  const nested = result.branches.find(branch => branch.condition === 'typeof second === "number"')!

  assert.deepEqual(
    nested.edges[0].parameters.map(parameter => parameter.classification),
    ["inherited-unreachable", "newly-unreachable"],
  )
  assert.equal(nested.edges[0].classification, "newly-unreachable")
})

test("retains diagnostics from the counterfactual program", () => {
  const result = analyze(`
function target(value: number) {
  value = 123
  if (typeof value === "string") {
    console.log(value)
  }
}
`)

  const diagnostic = result.diagnostics.find(diagnostic => diagnostic.code === 2322)
  assert.ok(diagnostic)
  assert.equal(diagnostic.line, 3)
  assert.equal(diagnostic.generated, undefined)
})

test("rejects the entire function when any parameter cannot be overridden", () => {
  const result = analyze(`
function target(value, ...rest: number[]) {
  if (typeof value === "string") {
    console.log(value, rest)
  }
}
`)

  assert.equal(result.branches.length, 0)
  assert.equal(result.unsupported.length, 1)
  assert.match(result.unsupported[0].reason, /All parameters/)
})

test("retains original diagnostics when a function parameter is unsupported", () => {
  const result = analyze(`
function target(value, ...rest: number[]) {
  const broken: number = "wrong"
  console.log(value, rest, broken)
}
`)

  assert.equal(result.branches.length, 0)
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 2322), true)
})

test("rejects parameter modifiers", () => {
  const result = analyze(`
function target(public value: number) {
  if (typeof value === "string") {
    console.log(value)
  }
}
`)

  assert.equal(result.branches.length, 0)
  assert.equal(result.unsupported.length, 1)
})

test("does not confuse user-authored marker-like arrays with probes", () => {
  const result = analyze(`
const marker = ["__branch_reachability_probe_0", "not a probe"]
function target(value) {
  if (typeof value === "string") {
    console.log(value, marker)
  }
}
`)

  assert.equal(result.branches.length, 1)
  assert.equal(result.branches[0].edges[0].classification, "reachable")
})

test("analyzes unbraced branches and synthesizes a missing false edge", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "string") console.log(value)
}
`)

  assert.equal(result.branches.length, 1)
  assert.deepEqual(
    result.branches[0].edges.map(edge => [edge.edge, edge.classification]),
    [["true", "reachable"], ["false", "newly-unreachable"]],
  )
  assert.equal(result.unsupported.length, 0)
})

test("preserves dangling else behavior while wrapping unbraced edges", () => {
  const result = analyze(`
function target(value, other) {
  if (typeof value === "string")
    if (typeof other === "number") return "number"
    else return "not number"
  else return "not string"
}
`)

  assert.equal(result.branches.length, 2)
  const outer = result.branches.find(branch => branch.condition === 'typeof value === "string"')!
  const inner = result.branches.find(branch => branch.condition === 'typeof other === "number"')!
  assert.deepEqual(
    outer.edges.map(edge => [edge.edge, edge.classification]),
    [["true", "reachable"], ["false", "newly-unreachable"]],
  )
  assert.deepEqual(
    inner.edges.map(edge => [edge.edge, edge.classification]),
    [["true", "newly-unreachable"], ["false", "reachable"]],
  )
})

test("orders nested unbraced missing-else rewrites at a shared endpoint", () => {
  const result = analyze(`
function target(value, other) {
  if (typeof value === "string")
    if (typeof other === "number") return "number"
}
`)

  assert.equal(result.branches.length, 2)
  const outer = result.branches.find(branch => branch.condition === 'typeof value === "string"')!
  const inner = result.branches.find(branch => branch.condition === 'typeof other === "number"')!
  assert.deepEqual(outer.edges.map(edge => edge.classification), [
    "reachable",
    "newly-unreachable",
  ])
  assert.deepEqual(inner.edges.map(edge => edge.classification), [
    "newly-unreachable",
    "reachable",
  ])
})

test("reports clear edges for else-if chains", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "number") {
    return "number"
  } else if (typeof value === "boolean") {
    return "boolean"
  } else {
    return "string"
  }
}
`)

  assert.equal(result.branches.length, 2)
  const first = result.branches[0]
  const second = result.branches[1]
  assert.equal(first.condition, 'typeof value === "number"')
  assert.deepEqual(first.edges.map(edge => edge.classification), [
    "newly-unreachable",
    "reachable",
  ])
  assert.equal(second.condition, 'typeof value === "boolean"')
  assert.deepEqual(second.edges.map(edge => edge.classification), [
    "newly-unreachable",
    "reachable",
  ])
})

test("analyzes an if used as a labeled loop body", () => {
  const result = analyze(`
function target(value) {
  outer: for (let index = 0; index < 1; index++)
    if (typeof value === "number")
      continue outer
    else
      break outer
}
`)

  assert.equal(result.branches.length, 1)
  assert.deepEqual(
    result.branches[0].edges.map(edge => edge.classification),
    ["newly-unreachable", "reachable"],
  )
  assert.equal(result.diagnostics.length, 0)
})

test("rejects an unbraced declaration whose scope would change", () => {
  const result = analyze(`
function target(value) {
  if (value) function helper() {}
  helper()
}
`)

  assert.equal(result.branches.length, 0)
  assert.equal(result.unsupported.length, 1)
  assert.match(result.unsupported[0].reason, /declaration scope/)
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 2304), false)
})

test("rejects declarations reached through an unbraced statement chain", () => {
  const result = analyze(`
function target(value) {
  if (value) while (value) function helper() {}
  helper()
}
`)

  assert.equal(result.branches.length, 0)
  assert.equal(result.unsupported.length, 1)
  assert.match(result.unsupported[0].reason, /declaration scope/)
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 2304), false)
})

test("analyzes JavaScript with inline JSDoc parameter overrides", () => {
  const result = analyzeJavaScript(`
function target(value) {
  if (typeof value === "number") {
    return "number"
  } else {
    return "string"
  }
}
`)

  assert.equal(result.branches.length, 1)
  assert.deepEqual(
    result.branches[0].edges.map(edge => [edge.edge, edge.classification]),
    [["true", "newly-unreachable"], ["false", "reachable"]],
  )
  assert.equal(result.branches[0].edges[0].parameters[0].baselineType, "string")
})

test("JavaScript inline overrides replace existing JSDoc parameter types", () => {
  const result = analyzeJavaScript(`
/** @param {number} value */
function target(/** @type {boolean} */ value) {
  if (typeof value === "number") {
    return "number"
  } else {
    return "string"
  }
}
`)

  assert.equal(result.branches[0].edges[0].parameters[0].baselineType, "string")
  assert.equal(result.branches[0].edges[0].parameters[0].edgeType, "never")
  assert.equal(result.branches[0].edges[0].classification, "newly-unreachable")
})

test("uses distinct parameter types from an explicit declaration file", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-decl-"))
  try {
    const fileName = path.join(directory, "implementation.js")
    const declarationFile = path.join(directory, "types.d.ts")
    const source = `function target(value, options) {
  if (typeof value === "number") return options
  return value
}
`
    writeFileSync(fileName, source)
    writeFileSync(declarationFile, `
import type {Shared} from "./shared.js"
export interface Options {kind: "strict"}
export function target(value: Shared, options?: Options): unknown
`)
    writeFileSync(path.join(directory, "shared.d.ts"), "export type Shared = string\n")

    const result = analyzeFile({
      fileName,
      functionName: "target",
      declarationFile,
      tsconfig: false,
    })

    assert.equal(result.input.kind, "declaration")
    assert.deepEqual(result.input.parameters, [{
      name: "value",
      type: "string",
      origin: "declaration",
    }, {
      name: "options",
      type: 'import("./types.d.ts").Options | undefined',
      origin: "declaration",
    }])
    assert.equal(result.input.matchedDeclaration?.line, 4)
    assert.equal(result.branches[0].edges[0].classification, "newly-unreachable")
    assert.equal(readFileSync(fileName, "utf8"), source)
    assert.match(readFileSync(declarationFile, "utf8"), /interface Options/)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("resolves declaration imports for NodeNext ESM source extensions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-decl-esm-"))
  try {
    const declarationFile = path.join(directory, "types.d.ts")
    writeFileSync(declarationFile, "export function target(value: string): unknown\n")
    for (const extension of [".mjs", ".mts"]) {
      const fileName = path.join(directory, `implementation${extension}`)
      writeFileSync(fileName, `export function target(value) {
  if (typeof value === "number") return value
}
`)
      const result = analyzeFile({
        fileName,
        functionName: "target",
        declarationFile,
        tsconfig: false,
      })
      assert.equal(result.input.parameters[0].type, "string")
      assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 2834), false)
    }
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("declaration mode preserves private implementation types", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-decl-private-"))
  try {
    const declarationFile = path.join(directory, "types.d.ts")
    writeFileSync(declarationFile, "export function publicFunction(value: string): void\n")
    const jsFile = path.join(directory, "private.js")
    writeFileSync(jsFile, `
/** @param {number} value */
function privateFunction(value) {
  if (typeof value === "string") return value
}
function untyped(value) {
  if (typeof value === "string") return value
}
function inline(/** @type {boolean} */ value) {
  if (typeof value === "string") return value
}
`)
    const typed = analyzeFile({
      fileName: jsFile,
      functionName: "privateFunction",
      declarationFile,
      tsconfig: false,
    })
    const untyped = analyzeFile({
      fileName: jsFile,
      functionName: "untyped",
      declarationFile,
      tsconfig: false,
    })
    const inline = analyzeFile({
      fileName: jsFile,
      functionName: "inline",
      declarationFile,
      tsconfig: false,
    })

    assert.deepEqual(typed.input.parameters, [{
      name: "value",
      type: "number",
      origin: "source-jsdoc",
    }])
    assert.equal(typed.branches[0].edges[0].classification, "newly-unreachable")
    assert.deepEqual(untyped.input.parameters, [{
      name: "value",
      type: "any",
      origin: "inferred-any",
    }])
    assert.deepEqual(inline.input.parameters, [{
      name: "value",
      type: "boolean",
      origin: "source-jsdoc",
    }])

    const tsFile = path.join(directory, "private.ts")
    writeFileSync(tsFile, `function privateFunction(value: boolean) {
  if (typeof value === "string") return value
}
function explicitAny(value: any) {
  if (typeof value === "string") return value
}
`)
    const annotated = analyzeFile({
      fileName: tsFile,
      functionName: "privateFunction",
      declarationFile,
      tsconfig: false,
    })
    assert.deepEqual(annotated.input.parameters, [{
      name: "value",
      type: "boolean",
      origin: "source-annotation",
    }])
    const explicitAny = analyzeFile({
      fileName: tsFile,
      functionName: "explicitAny",
      declarationFile,
      tsconfig: false,
    })
    assert.deepEqual(explicitAny.input.parameters, [{
      name: "value",
      type: "any",
      origin: "source-annotation",
    }])
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("validates declaration files and matched parameter shapes", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-decl-errors-"))
  try {
    const fileName = path.join(directory, "implementation.js")
    writeFileSync(fileName, "function target(value) { return value }\n")
    const analyzeWith = (declarationFile: string) => analyzeFile({
      fileName,
      functionName: "target",
      declarationFile,
      tsconfig: false,
    })

    assert.throws(() => analyzeWith(path.join(directory, "missing.d.ts")), /Could not read/)
    const wrongExtension = path.join(directory, "types.ts")
    writeFileSync(wrongExtension, "export function target(value: string): string\n")
    assert.throws(() => analyzeWith(wrongExtension), /must end with \.d\.ts/)
    const invalid = path.join(directory, "invalid.d.ts")
    writeFileSync(invalid, "export function target(value: ): void\n")
    assert.throws(() => analyzeWith(invalid), /Invalid declaration file/)
    const arity = path.join(directory, "arity.d.ts")
    writeFileSync(arity, "export function target(value: string, other: number): void\n")
    assert.throws(() => analyzeWith(arity), /arity does not match/)
    const rest = path.join(directory, "rest.d.ts")
    writeFileSync(rest, "export function target(...value: string[]): void\n")
    assert.throws(() => analyzeWith(rest), /unsupported rest parameter/)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("unions compatible declaration overload parameter types", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-decl-invalid-"))
  try {
    const fileName = path.join(directory, "implementation.js")
    const declarationFile = path.join(directory, "types.d.ts")
    writeFileSync(fileName, "function target(value) { return value }\n")
    writeFileSync(declarationFile, `
export function target(value: () => string): string
export function target(value: number): number
`)

    const overloaded = analyzeFile({
      fileName,
      functionName: "target",
      declarationFile,
      tsconfig: false,
    })
    assert.equal(overloaded.input.parameters[0].origin, "declaration")
    assert.match(overloaded.input.parameters[0].type, /number/)
    assert.match(overloaded.input.parameters[0].type, /\(\) => string/)
    assert.equal(overloaded.diagnostics.some(diagnostic => diagnostic.code === 1385), false)
    assert.throws(() => analyzeFile({
      fileName,
      functionName: "target",
      typeText: "string",
      declarationFile,
      tsconfig: false,
    }), /cannot be used together/)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("rejects optional JSDoc parameters instead of retaining undefined", () => {
  for (const annotation of [
    "/** @param {number} [value] */",
    "/** @param {number=} value */",
  ]) {
    const result = analyzeSource({
      fileName: "/virtual/optional.js",
      sourceText: `${annotation}
function target(value) {
  if (value === undefined) return "missing"
  return value
}`,
      functionName: "target",
      compilerOptions: {strict: true},
    })

    assert.equal(result.branches.length, 0)
    assert.equal(result.unsupported.length, 1)
    assert.match(result.unsupported[0].reason, /Optional JSDoc/)
  }
})

test("analyzes JavaScript CommonJS source without changing its language mode", () => {
  const result = analyzeJavaScript(`
function target(value) {
  if (typeof value === "string") {
    return value
  }
}
module.exports.target = target
`)

  assert.equal(result.branches.length, 1)
  assert.equal(result.branches[0].edges[1].classification, "newly-unreachable")
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 8010), false)
})

test("uses a JSX default for standalone JSX source", () => {
  const result = analyzeSource({
    fileName: "/virtual/fixture.jsx",
    sourceText: `function target(value) {
  if (typeof value === "string") return <div>{value}</div>
  return null
}`,
    functionName: "target",
  })

  assert.equal(result.branches.length, 1)
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 17004), false)
})

test("accepts CommonJS module settings for cjs source", () => {
  const result = analyzeSource({
    fileName: "/virtual/fixture.cjs",
    sourceText: `function target(value) {
  if (typeof value === "string") return value
}
module.exports = target`,
    functionName: "target",
    compilerOptions: {module: ts.ModuleKind.CommonJS},
  })

  assert.equal(result.branches.length, 1)
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 5110), false)
})

test("analyzes mjs source in JavaScript mode", () => {
  const result = analyzeSource({
    fileName: "/virtual/fixture.mjs",
    sourceText: `export function target(value) {
  if (typeof value === "number") return value
}`,
    functionName: "target",
  })

  assert.equal(result.branches.length, 1)
  assert.equal(result.branches[0].edges[0].classification, "newly-unreachable")
})

test("analyzes js-yaml load and loadDocuments directly", () => {
  const fileName = path.resolve("node_modules/js-yaml/lib/loader.js")
  const load = analyzeFile({fileName, functionName: "load", tsconfig: false})
  const loadDocuments = analyzeFile({fileName, functionName: "loadDocuments", tsconfig: false})

  assert.equal(load.branches.length, 2)
  assert.equal(load.branches.every(branch =>
    branch.edges.every(edge => edge.classification === "reachable")
  ), true)
  assert.equal(loadDocuments.branches.length, 4)
  assert.equal(loadDocuments.branches.every(branch =>
    branch.edges.every(edge => edge.classification === "reachable")
  ), true)
  assert.deepEqual(
    loadDocuments.branches[0].edges[0].parameters.map(parameter => parameter.baselineType),
    ["string", "string"],
  )
  assert.equal(loadDocuments.diagnostics.some(diagnostic => diagnostic.code === 2322), true)
})

test("discovers the js-yaml CommonJS load chain", () => {
  const result = analyzePackageExport({
    packageName: "js-yaml",
    exportName: "load",
    maxDepth: 1,
    maxFunctions: 10,
  })

  assert.match(result.entryFile, /node_modules\/js-yaml\/index\.js$/)
  assert.deepEqual(
    result.exportPath.map(step => [path.basename(step.fileName), step.expression]),
    [["index.js", "loader.load"], ["loader.js", "load"]],
  )
  assert.deepEqual(result.functions.map(discovered => discovered.functionName), [
    "load",
    "loadDocuments",
  ])
  assert.deepEqual(result.functions.map(discovered => discovered.depth), [0, 1])
  assert.equal(result.truncated.some(item => item.functionName === "readDocument"), true)
  assert.match(formatPackageAnalysisResult(result), /js-yaml\.load \(require\)/)
})

test("CLI emits package discovery JSON", () => {
  const execution = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "cli.ts",
      "--package", "js-yaml",
      "--export", "load",
      "--max-depth", "1",
      "--json",
    ],
    {cwd: path.resolve("."), encoding: "utf8"},
  )

  assert.equal(execution.status, 0, execution.stderr)
  const result = JSON.parse(execution.stdout)
  assert.deepEqual(result.functions.map((item: {functionName: string}) => item.functionName), [
    "load",
    "loadDocuments",
  ])
})

test("CommonJS discovery uses the final export assignment", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-package-"))
  try {
    const entryFile = path.join(directory, "index.js")
    writeFileSync(entryFile, `
function oldLoad(value) {
  if (typeof value === "string") return "old"
}
function currentLoad(value) {
  if (typeof value === "number") return "current"
}
module.exports.load = oldLoad
module.exports.load = currentLoad
`)

    const result = analyzePackageExport({
      packageName: entryFile,
      exportName: "load",
      maxDepth: 0,
    })

    assert.equal(result.exportPath[0].expression, "currentLoad")
    assert.equal(result.functions[0].functionName, "currentLoad")
    assert.equal(result.functions[0].analysis.branches[0].edges[0].classification, "newly-unreachable")
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("CommonJS discovery uses the final merged function declaration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-package-"))
  try {
    const entryFile = path.join(directory, "index.js")
    writeFileSync(entryFile, `
function load(value) {
  if (typeof value === "string") return "old"
}
function load(value) {
  if (typeof value === "number") return "current"
}
module.exports.load = load
`)

    const result = analyzePackageExport({
      packageName: entryFile,
      exportName: "load",
      maxDepth: 0,
    })

    assert.equal(result.functions[0].line, 5)
    assert.equal(result.functions[0].analysis.branches[0].condition, 'typeof value === "number"')
    assert.equal(result.functions[0].analysis.branches[0].edges[0].classification, "newly-unreachable")
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("package traversal guards recursive calls and maximum function count", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-package-"))
  try {
    const entryFile = path.join(directory, "index.js")
    writeFileSync(entryFile, `
function load(value) {
  if (typeof value === "string") load(value)
}
module.exports.load = load
`)
    const recursive = analyzePackageExport({
      packageName: entryFile,
      exportName: "load",
      maxDepth: 10,
    })

    assert.equal(recursive.functions.length, 1)
    assert.equal(recursive.truncated.length, 0)

    const limited = analyzePackageExport({
      packageName: "js-yaml",
      exportName: "load",
      maxDepth: 3,
      maxFunctions: 1,
    })
    assert.deepEqual(limited.functions.map(item => item.functionName), ["load"])
    assert.equal(limited.truncated.some(item =>
      item.functionName === "loadDocuments" && item.reason === "maximum function count reached"
    ), true)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("CLI rejects package-only options in file mode", () => {
  const execution = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "cli.ts", "--max-depth", "1", "index.ts", "analyzeFile"],
    {cwd: path.resolve("."), encoding: "utf8"},
  )

  assert.equal(execution.status, 1)
  assert.match(execution.stderr, /require --package/)
})

test("library mode discovers CommonJS files and analyzes top-level functions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-library-"))
  try {
    const dependencyDirectory = path.join(directory, "node_modules/dependency")
    mkdirSync(dependencyDirectory, {recursive: true})
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({name: "fixture"}))
    writeFileSync(path.join(directory, "data.json"), JSON.stringify({enabled: true}))
    writeFileSync(path.join(dependencyDirectory, "package.json"), JSON.stringify({
      name: "dependency",
      main: "index.js",
    }))
    writeFileSync(path.join(dependencyDirectory, "index.js"), `
function dependencyFunction(value) {
  return value
}
module.exports = dependencyFunction
`)
    writeFileSync(path.join(directory, "dependency.js"), `
function helper(value) {
  if (typeof value === "string") return value
  return null
}
function outer(value) {
  function nested(value) {
    if (typeof value === "number") return value
  }
  return nested(value)
}
module.exports = {helper, outer}
`)
    const entryFile = path.join(directory, "index.js")
    writeFileSync(entryFile, `
console.log("fixture loaded")
const dependencyName = "./dependency.js"
require(dependencyName)
require("./data.json")
require("dependency")
function entryPoint(value) {
  if (typeof value === "number") return value
  return null
}
const ignoredArrow = value => value
module.exports = entryPoint
`)

    const result = analyzeLibrary({entryFile})
    assert.equal(result.discovery.status, "complete")
    assert.match(result.discovery.stdout, /fixture loaded/)
    assert.deepEqual(
      result.files.map(file => path.basename(file.fileName)),
      ["index.js", "dependency.js"],
    )
    assert.deepEqual(
      result.files.flatMap(file => file.functions.map(fn => fn.functionName)),
      ["entryPoint", "helper", "outer"],
    )
    assert.equal(result.discovery.excludedFiles.length, 2)
    assert.deepEqual(result.summary, {
      files: 2,
      excludedFiles: 2,
      functions: 3,
      analyzedFunctions: 3,
      failedFunctions: 0,
      branches: 2,
      unreachableEdges: 2,
      diagnosticOccurrences: 0,
      unsupported: 0,
    })
    assert.equal(result.files.every(file => file.functions.every(fn =>
      fn.status === "analyzed"
      && fn.analysis.input.parameters.every(parameter =>
        parameter.origin === "uniform-default"
      )
    )), true)

    const declarationFile = path.join(directory, "index.d.ts")
    writeFileSync(
      declarationFile,
      "export function entryPoint(value: string): string | null\n",
    )
    const declared = analyzeLibrary({entryFile, declarationFile})
    assert.deepEqual(
      declared.files.flatMap(file => file.functions.map(fn => fn.id)),
      result.files.flatMap(file => file.functions.map(fn => fn.id)),
    )
    assert.equal(declared.summary.analyzedFunctions, 3)
    const declaredFunctions = declared.files.flatMap(file => file.functions)
    const entryPoint = declaredFunctions.find(fn => fn.functionName === "entryPoint")
    const helper = declaredFunctions.find(fn => fn.functionName === "helper")
    assert.equal(entryPoint?.status, "analyzed")
    assert.equal(
      entryPoint?.status === "analyzed" ? entryPoint.analysis.input.parameters[0].origin : "",
      "declaration",
    )
    assert.equal(helper?.status, "analyzed")
    assert.equal(
      helper?.status === "analyzed" ? helper.analysis.input.parameters[0].origin : "",
      "inferred-any",
    )

    const execution = spawnSync(
      process.execPath,
      ["cli.ts", "--library", entryFile, "--json"],
      {cwd: path.resolve("."), encoding: "utf8"},
    )
    assert.equal(execution.status, 0, execution.stderr)
    const cliResult = JSON.parse(execution.stdout) as {summary: {functions: number}}
    assert.equal(cliResult.summary.functions, 3)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("library discovery inventories the loaded js-yaml package", () => {
  const discovered = discoverLibraryFiles("node_modules/js-yaml/index.js")
  assert.equal(discovered.discovery.status, "complete")
  assert.equal(discovered.discovery.files.length, 25)
  assert.equal(discovered.discovery.excludedFiles.length, 0)

  const inventories = discovered.discovery.files.map(fileName => ({
    fileName,
    functions: inventoryTopLevelFunctions(fileName),
  }))
  assert.equal(inventories.reduce((count, file) => count + file.functions.length, 0), 113)
  assert.deepEqual(
    inventories.find(file => file.fileName.endsWith("/index.js"))?.functions
      .map(fn => fn.functionName),
    ["renamed"],
  )
  assert.equal(
    inventories.find(file => file.fileName.endsWith("/lib/loader.js"))?.functions
      .some(fn => fn.functionName === "loadDocuments"),
    true,
  )
})

test("creates deterministic rows for console.table", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "number") {
    console.log(value)
  }
}
`)
  const rows = getAnalysisTableRows(result)

  assert.equal(rows.length, 3)
  assert.deepEqual(Object.keys(rows[0]), [
    "edge_id", "edge", "classification", "entry_probability", "prob_from_fn_entry",
    "start_line", "start_col", "end_line", "end_col",
    "start_offset", "end_offset", "probed_types", "parent_edge_id",
  ])
  assert.match(rows[0].edge_id, /^edge_[a-f0-9]{16}$/)
  assert.equal(rows[0].edge, "baseline")
  assert.equal(rows[0].entry_probability, 1)
  assert.equal(rows[0].prob_from_fn_entry, 1)
  assert.equal(rows[0].start_line, 3)
  assert.equal(rows[1].edge, "true")
  assert.equal(rows[1].classification, "newly-unreachable")
  assert.equal(rows[1].entry_probability, 0)
  assert.equal(rows[1].prob_from_fn_entry, 0)
  assert.equal(rows[1].probed_types, "value: never")
  assert.equal(rows[1].parent_edge_id, rows[0].edge_id)
  assert.equal(rows[2].edge, "false")
  assert.equal(rows[2].entry_probability, 1)
  assert.equal(rows[2].prob_from_fn_entry, 1)
})

test("CLI uses console.table for human output", () => {
  const execution = spawnSync(
    process.execPath,
    ["cli.ts", "--no-project", "tests/basic.ts", "classify"],
    {cwd: path.resolve("."), encoding: "utf8"},
  )

  assert.equal(execution.status, 0, execution.stderr)
  assert.match(execution.stdout, /edge_id/)
  assert.match(execution.stdout, /parent_edge_id/)
  assert.match(execution.stdout, /edge_[a-f0-9]{16}/)
  assert.match(execution.stdout, /[┌┬┐]/)
})

test("CLI writes console.table rows to SQLite", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-sqlite-"))
  try {
    const databasePath = path.join(directory, "edges.sqlite")
    const execution = spawnSync(
      process.execPath,
      [
        "cli.ts", "--no-project", "--sql", databasePath,
        "tests/basic.ts", "classify",
      ],
      {cwd: path.resolve("."), encoding: "utf8"},
    )
    assert.equal(execution.status, 0, execution.stderr)

    const database = new DatabaseSync(databasePath)
    try {
      const rows = database.prepare(`
        SELECT edge_id, edge, parent_edge_id, file_name, function_name, type_text
        FROM edges ORDER BY start_offset, edge
      `).all() as Array<{
        edge_id: string
        edge: string
        parent_edge_id: string | null
        file_name: string
        function_name: string
        type_text: string
      }>
      assert.equal(rows.length, 3)
      assert.deepEqual(rows.map(row => row.edge).sort(), ["baseline", "false", "true"])
      const baseline = rows.find(row => row.edge === "baseline")!
      assert.equal(baseline.parent_edge_id, null)
      assert.equal(rows.filter(row => row.edge !== "baseline").every(
        row => row.parent_edge_id === baseline.edge_id
      ), true)
      assert.match(baseline.file_name, /tests\/basic\.ts$/)
      assert.equal(baseline.function_name, "classify")
      assert.equal(baseline.type_text, "string")

      const invalidParents = database.prepare(`
        SELECT COUNT(*) AS count
        FROM edges AS child
        LEFT JOIN edges AS parent ON parent.edge_id = child.parent_edge_id
        WHERE child.edge != 'baseline'
          AND (parent.edge IS NULL OR parent.edge != 'baseline')
      `).get() as {count: number}
      assert.equal(invalidParents.count, 0)
    } finally {
      database.close()
    }
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("coverage CLI imports exact and smallest containing V8 hit counts", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-coverage-"))
  try {
    const databasePath = path.join(directory, "edges.sqlite")
    const sourcePath = path.join(directory, "source.js")
    const coveragePath = path.join(directory, "coverage.json")
    const database = new DatabaseSync(databasePath)
    try {
      database.exec(`
        CREATE TABLE edges (
          edge_id TEXT PRIMARY KEY,
          edge TEXT NOT NULL,
          file_name TEXT NOT NULL,
          start_offset INTEGER NOT NULL,
          end_offset INTEGER NOT NULL
        );
      `)
      const insert = database.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, ?)")
      insert.run("baseline", "baseline", sourcePath, 10, 20)
      insert.run("exact", "true", sourcePath, 20, 30)
      insert.run("containing", "true", sourcePath, 40, 50)
      insert.run("continuation", "false", sourcePath, 60, 60)
      insert.run("ambiguous", "false", sourcePath, 70, 80)
      insert.run("unmatched", "true", sourcePath, 100, 110)
    } finally {
      database.close()
    }
    writeFileSync(coveragePath, JSON.stringify({result: [{
      url: pathToFileURL(sourcePath).href,
      functions: [{ranges: [
        {startOffset: 0, endOffset: 90, count: 1},
        {startOffset: 20, endOffset: 30, count: 7},
        {startOffset: 38, endOffset: 52, count: 5},
        {startOffset: 60, endOffset: 60, count: 3},
        {startOffset: 68, endOffset: 82, count: 2},
        {startOffset: 69, endOffset: 83, count: 4},
      ]}],
    }]}))

    const execution = spawnSync(
      process.execPath,
      ["coverage.ts", databasePath, coveragePath],
      {cwd: path.resolve("."), encoding: "utf8"},
    )
    assert.equal(execution.status, 0, execution.stderr)
    assert.match(execution.stdout, /coveredEdges/)

    const resultDatabase = new DatabaseSync(databasePath)
    try {
      const rows = resultDatabase.prepare(`
        SELECT edge_id, hit_count FROM edge_coverage ORDER BY edge_id
      `).all().map(row => ({...row}))
      assert.deepEqual(rows, [
        {edge_id: "containing", hit_count: 5},
        {edge_id: "continuation", hit_count: 3},
        {edge_id: "exact", hit_count: 7},
      ])
    } finally {
      resultDatabase.close()
    }
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("imports the saved js-yaml V8 coverage reports", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-js-yaml-coverage-"))
  try {
    const databasePath = path.join(directory, "edges.sqlite")
    const loaderPath = path.resolve("node_modules/js-yaml/lib/loader.js")
    writeAnalysesToSqlite(databasePath, [
      analyzeFile({fileName: loaderPath, functionName: "load"}),
      analyzeFile({fileName: loaderPath, functionName: "loadDocuments"}),
    ])

    // Raw V8 reports retain the absolute path of the checkout that produced
    // them. Preserve that source identity in the temporary edge database so
    // this committed fixture remains runnable from any checkout location.
    const fixtureDirectory = path.resolve("coverage/v8/js-yaml")
    const singleReport = JSON.parse(readFileSync(
      path.join(fixtureDirectory, "single/coverage-15268-1784914056497-0.json"),
      "utf8",
    )) as {result: Array<{url: string}>}
    const capturedUrl = singleReport.result.find(script =>
      script.url.endsWith("/node_modules/js-yaml/lib/loader.js")
    )?.url
    assert.ok(capturedUrl)
    const database = new DatabaseSync(databasePath)
    try {
      database.prepare("UPDATE edges SET file_name = ? WHERE file_name = ?")
        .run(fileURLToPath(capturedUrl), loaderPath)
    } finally {
      database.close()
    }

    const result = importV8Coverage(databasePath, [fixtureDirectory])
    assert.deepEqual(result, {
      databasePath,
      coverageFiles: 5,
      candidateEdges: 12,
      coveredEdges: 12,
    })

    const resultDatabase = new DatabaseSync(databasePath)
    try {
      const rows = resultDatabase.prepare(`
        SELECT e.function_name, e.edge, e.start_offset, e.end_offset, c.hit_count
        FROM edge_coverage AS c
        JOIN edges AS e USING (edge_id)
        ORDER BY e.function_name, e.start_offset, e.edge
      `).all().map(row => ({...row}))
      assert.deepEqual(rows, [
        {function_name: "load", edge: "true", start_offset: 46858, end_offset: 46921, hit_count: 1},
        {function_name: "load", edge: "false", start_offset: 46927, end_offset: 46985, hit_count: 3},
        {function_name: "load", edge: "true", start_offset: 46955, end_offset: 46985, hit_count: 2},
        {function_name: "load", edge: "false", start_offset: 46985, end_offset: 46985, hit_count: 0},
        {function_name: "loadDocuments", edge: "true", start_offset: 45491, end_offset: 45784, hit_count: 4},
        {function_name: "loadDocuments", edge: "true", start_offset: 45656, end_offset: 45684, hit_count: 2},
        {function_name: "loadDocuments", edge: "false", start_offset: 45684, end_offset: 45684, hit_count: 2},
        {function_name: "loadDocuments", edge: "true", start_offset: 45743, end_offset: 45780, hit_count: 1},
        {function_name: "loadDocuments", edge: "false", start_offset: 45780, end_offset: 45780, hit_count: 1},
        {function_name: "loadDocuments", edge: "false", start_offset: 45784, end_offset: 45784, hit_count: 4},
        {function_name: "loadDocuments", edge: "true", start_offset: 45888, end_offset: 45983, hit_count: 1},
        {function_name: "loadDocuments", edge: "false", start_offset: 45983, end_offset: 45983, hit_count: 0},
      ])
      const baselineCount = resultDatabase.prepare(`
        SELECT COUNT(*) AS count
        FROM edge_coverage AS c
        JOIN edges AS e USING (edge_id)
        WHERE e.edge = 'baseline'
      `).get() as {count: number}
      assert.equal(baselineCount.count, 0)
    } finally {
      resultDatabase.close()
    }
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("assigns stable location IDs and baseline parents to edge rows", () => {
  const source = `function target(value) {
  if (typeof value === "number") return value
}`
  const first = analyze(source)
  const second = analyze(source)
  const branch = first.branches[0]

  assert.equal(branch.baseline.edgeId, second.branches[0].baseline.edgeId)
  assert.equal(branch.baseline.parentEdgeId, null)
  assert.equal(branch.baseline.location.start.offset, source.indexOf("typeof"))
  assert.equal(branch.baseline.location.end.offset, source.indexOf(") return"))
  assert.equal(branch.edges[0].parentEdgeId, branch.baseline.edgeId)
  assert.equal(branch.edges[1].parentEdgeId, branch.baseline.edgeId)
  assert.equal(branch.edges[0].location.start.offset, source.indexOf("return"))
  assert.equal(branch.edges[1].location.start.offset, source.indexOf("return") + "return value".length)

  const rows = getAnalysisTableRows(first)
  const rowsById = new Map(rows.map(row => [row.edge_id, row]))
  for (const row of rows) {
    if (row.edge === "baseline") {
      if (row.parent_edge_id === "") {
        // root baseline — no enclosing edge, valid
      } else {
        // nested baseline — parent must be a true/false edge
        assert.ok(rowsById.get(row.parent_edge_id))
        assert.notEqual(rowsById.get(row.parent_edge_id)?.edge, "baseline")
      }
    } else {
      assert.notEqual(row.parent_edge_id, "")
      assert.equal(rowsById.get(row.parent_edge_id)?.edge, "baseline")
    }
  }
})

test("nested baseline parentEdgeId points to the enclosing edge", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "string") {
    if (typeof value === "number") {
      console.log(value)
    }
  }
}
`)
  const [outer, inner] = result.branches
  assert.equal(outer.baseline.parentEdgeId, null)

  const outerTrueEdge = outer.edges.find(edge => edge.edge === "true")!
  assert.equal(inner.baseline.parentEdgeId, outerTrueEdge.edgeId)

  const rows = getAnalysisTableRows(result)
  const rowsById = new Map(rows.map(row => [row.edge_id, row]))
  const innerBaselineRow = rows.find(row =>
    row.edge === "baseline" && row.edge_id === inner.baseline.edgeId
  )!
  assert.notEqual(innerBaselineRow.parent_edge_id, "")
  assert.equal(
    rowsById.get(innerBaselineRow.parent_edge_id)?.edge,
    "true",
  )
})

test("analyzeFile loads the nearest tsconfig and leaves the source unchanged", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-"))
  try {
    const fileName = path.join(directory, "fixture.ts")
    const source = `export function target(value: number) {
  const unused = 1
  if (typeof value === "number") {
    console.log(value)
  }
}
`
    writeFileSync(fileName, source)
    writeFileSync(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({compilerOptions: {noUnusedLocals: true}}),
    )

    const result = analyzeFile({fileName, functionName: "target"})

    assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 6133), true)
    assert.equal(readFileSync(fileName, "utf8"), source)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("analyzeFile can disable tsconfig discovery", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-"))
  try {
    const fileName = path.join(directory, "fixture.ts")
    writeFileSync(fileName, `export function target(value) {
  const unused = 1
  if (typeof value === "string") {
    console.log(value)
  }
}
`)
    writeFileSync(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({compilerOptions: {noUnusedLocals: true}}),
    )

    const result = analyzeFile({fileName, functionName: "target", tsconfig: false})

    assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 6133), false)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("CLI emits structured JSON", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-"))
  try {
    const fileName = path.join(directory, "fixture.ts")
    writeFileSync(fileName, `function target(value) {
  if (typeof value === "number") {
    console.log(value)
  }
}
`)
    const execution = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "cli.ts", "--no-project", "--json", fileName, "target"],
      {cwd: path.resolve("."), encoding: "utf8"},
    )

    assert.equal(execution.status, 0, execution.stderr)
    const result = JSON.parse(execution.stdout)
    assert.equal(result.functionName, "target")
    assert.equal(result.branches[0].edges[0].classification, "newly-unreachable")
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("CLI accepts --decl and rejects conflicting type input", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "branch-reachability-cli-decl-"))
  try {
    const fileName = path.join(directory, "fixture.js")
    const declarationFile = path.join(directory, "fixture.d.ts")
    writeFileSync(fileName, `function target(value) {
  if (typeof value === "number") return value
}
`)
    writeFileSync(declarationFile, "export function target(value: string): unknown\n")
    const execution = spawnSync(
      process.execPath,
      ["cli.ts", "--decl", declarationFile, "--json", fileName, "target"],
      {cwd: path.resolve("."), encoding: "utf8"},
    )

    assert.equal(execution.status, 0, execution.stderr)
    const result = JSON.parse(execution.stdout) as {
      input: {kind: string; parameters: Array<{type: string; origin: string}>}
    }
    assert.equal(result.input.kind, "declaration")
    assert.deepEqual(result.input.parameters, [{
      name: "value",
      type: "string",
      origin: "declaration",
    }])

    const conflict = spawnSync(
      process.execPath,
      ["cli.ts", "--decl", declarationFile, "--type", "number", fileName, "target"],
      {cwd: path.resolve("."), encoding: "utf8"},
    )
    assert.equal(conflict.status, 1)
    assert.match(conflict.stderr, /--type and --decl cannot be used together/)

    const explicitUnion = spawnSync(
      process.execPath,
      ["cli.ts", "--type", "string | number", "--json", fileName, "target"],
      {cwd: path.resolve("."), encoding: "utf8"},
    )
    assert.equal(explicitUnion.status, 0, explicitUnion.stderr)
    const unionResult = JSON.parse(explicitUnion.stdout) as {
      input: {parameters: Array<{type: string; origin: string}>}
    }
    assert.deepEqual(unionResult.input.parameters, [{
      name: "value",
      type: "string | number",
      origin: "uniform-explicit",
    }])

    const sqlConflict = spawnSync(
      process.execPath,
      ["cli.ts", "--decl", declarationFile, "--sql", path.join(directory, "x.db"), fileName, "target"],
      {cwd: path.resolve("."), encoding: "utf8"},
    )
    assert.equal(sqlConflict.status, 1)
    assert.match(sqlConflict.stderr, /--decl cannot be combined with --sql/)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

function assertProbabilitiesInBounds(result: ReturnType<typeof analyze>) {
  for (const branch of result.branches) {
    for (const edge of branch.edges) {
      assert.ok(
        edge.entryProbability >= 0 && edge.entryProbability <= 1,
        `entryProbability ${edge.entryProbability} out of bounds for ${edge.edgeId}`,
      )
      assert.ok(
        edge.probFromFnEntry >= 0 && edge.probFromFnEntry <= 1,
        `probFromFnEntry ${edge.probFromFnEntry} out of bounds for ${edge.edgeId}`,
      )
      for (const param of edge.parameters) {
        assert.ok(
          param.entryProbability >= 0 && param.entryProbability <= 1,
          `parameter entryProbability ${param.entryProbability} out of bounds for ${param.name} in ${edge.edgeId}`,
        )
      }
    }
  }
}

test("all probabilities are in [0,1] for reachable and unreachable edges", () => {
  assertProbabilitiesInBounds(analyze(`
function target(value) {
  if (typeof value === "number") {
    console.log(value)
  } else {
    console.log(value)
  }
}
`))
})

test("all probabilities are in [0,1] for nested narrowing", () => {
  assertProbabilitiesInBounds(analyze(`
function target(value) {
  if (typeof value === "string") {
    if (typeof value === "number") {
      console.log(value)
    }
  }
}
`))
})

test("all probabilities are in [0,1] for else-if chains", () => {
  assertProbabilitiesInBounds(analyze(`
function target(value) {
  if (typeof value === "number") {
    return "number"
  } else if (typeof value === "boolean") {
    return "boolean"
  } else {
    return "string"
  }
}
`))
})

test("all probabilities are in [0,1] for union narrowing", () => {
  assertProbabilitiesInBounds(analyze(`
function target(value: "a" | "b" | "c") {
  if (value === "a") {
    console.log(value)
  } else if (value === "b") {
    console.log(value)
  }
}
`, `"a" | "b" | "c"`))
})

test("all probabilities are in [0,1] for inherited-unreachable with multiple params", () => {
  assertProbabilitiesInBounds(analyze(`
function target(first, second) {
  if (typeof first === "number") {
    if (typeof second === "number") {
      console.log(first, second)
    }
  }
}
`))
})
