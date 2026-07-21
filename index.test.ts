import assert from "node:assert/strict"
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"
import test from "node:test"
import ts from "typescript"
import {analyzePackageExport, formatPackageAnalysisResult} from "./discovery.ts"
import {analyzeFile, analyzeSource, formatAnalysisResult} from "./index.ts"

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

test("formats a deterministic human-readable report", () => {
  const result = analyze(`
function target(value) {
  if (typeof value === "number") {
    console.log(value)
  }
}
`)
  const output = formatAnalysisResult(result)

  assert.match(output, /fixture\.ts:target \(T = string\)/)
  assert.match(output, /3:3 if \(typeof value === "number"\)/)
  assert.match(output, /true: NEWLY UNREACHABLE/)
  assert.match(output, /value: string -> never \[newly-unreachable\]/)
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
