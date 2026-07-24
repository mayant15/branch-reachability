import assert from "node:assert/strict"
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"
import {DatabaseSync} from "node:sqlite"
import test from "node:test"
import ts from "typescript"
import {analyzePackageExport, formatPackageAnalysisResult} from "./discovery.ts"
import {analyzeFile, analyzeSource, getAnalysisTableRows} from "./index.ts"

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
    "edge_id", "edge", "classification",
    "start_line", "start_col", "end_line", "end_col",
    "start_offset", "end_offset", "probed_types", "parent_edge_id",
  ])
  assert.match(rows[0].edge_id, /^edge_[a-f0-9]{16}$/)
  assert.equal(rows[0].edge, "baseline")
  assert.equal(rows[0].start_line, 3)
  assert.equal(rows[1].edge, "true")
  assert.equal(rows[1].classification, "newly-unreachable")
  assert.equal(rows[1].probed_types, "value: never")
  assert.equal(rows[1].parent_edge_id, rows[0].edge_id)
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
      assert.equal(row.parent_edge_id, "")
    } else {
      assert.notEqual(row.parent_edge_id, "")
      assert.equal(rowsById.get(row.parent_edge_id)?.edge, "baseline")
    }
  }
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
