import assert from "node:assert"
import {randomInt, randomBytes} from "node:crypto"
import {createRequire} from "node:module"
import path from "node:path"
import {parseArgs} from "node:util"
import ts from "typescript"

const ITERATIONS = process.env.ITERATIONS
  ? Number(process.env.ITERATIONS)
  : 100

const parsed = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    type: {type: "string"},
    decl: {type: "string"},
  },
})

const entry = parsed.positionals[0]
assert(typeof entry === "string", "Usage: node fuzzer.ts [--type <type>] [--decl <file>] <entry.js>")
assert(entry.length > 0)

if (parsed.values.type && parsed.values.decl) {
  throw new Error("--type and --decl cannot be used together")
}

interface ApiEntry {
  name: string
  fn: (...args: unknown[]) => unknown
}

function discover(entryPath: string): ApiEntry[] {
  const require = createRequire(import.meta.url)
  const mod = require(path.resolve(entryPath))
  const entries: ApiEntry[] = []
  const seen = new Set<(...args: unknown[]) => unknown>()

  if (typeof mod === "function") {
    const fn = mod as (...args: unknown[]) => unknown
    if (!seen.has(fn)) {
      seen.add(fn)
      entries.push({name: fn.name || "(anonymous)", fn})
    }
  }

  if (mod !== null && typeof mod === "object") {
    for (const key of Object.getOwnPropertyNames(mod)) {
      const val = (mod as Record<string, unknown>)[key]
      if (typeof val === "function") {
        const fn = val as (...args: unknown[]) => unknown
        if (!seen.has(fn)) {
          seen.add(fn)
          entries.push({name: key, fn})
        }
      }
    }
  }

  return entries
}

function generateValueForType(type: string): unknown {
  switch (type) {
    case "string":
      return randomBytes(8).toString("hex")
    case "number":
      return randomInt(-10000, 10000)
    case "boolean":
      return Math.random() >= 0.5
    case "undefined":
      return undefined
    case "null":
      return null
    case "object":
      return {}
    default: {
      const choice = randomInt(7)
      switch (choice) {
        case 0: return randomBytes(8).toString("hex")
        case 1: return randomInt(-10000, 10000)
        case 2: return Math.random() >= 0.5
        case 3: return null
        case 4: return undefined
        case 5: return {}
        case 6: return []
      }
    }
  }
}

function generateValueFromTypeText(typeText: string): unknown {
  const t = typeText.replace(/\s+/g, "")
  if (t === "string" || t.startsWith("string|") || t.startsWith("string[")) {
    return randomBytes(8).toString("hex")
  }
  if (t === "number" || t.startsWith("number|")) {
    return randomInt(-10000, 10000)
  }
  if (t === "boolean" || t.startsWith("boolean|") || t.startsWith("bool")) {
    return Math.random() >= 0.5
  }
  if (t === "undefined") return undefined
  if (t === "null" || t.startsWith("null|")) return null
  if (t === "any" || t === "unknown") {
    return randomBytes(8).toString("hex")
  }
  return randomBytes(8).toString("hex")
}

function loadDeclarationTypes(declarationFile: string): Map<string, string[]> {
  const resolvedPath = path.resolve(declarationFile)
  const program = ts.createProgram([resolvedPath], {noEmit: true, skipLibCheck: true})
  const sourceFile = program.getSourceFile(resolvedPath)
  if (!sourceFile) {
    throw new Error(`Could not parse declaration file: ${resolvedPath}`)
  }

  const result = new Map<string, string[]>()

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const params = node.parameters.map(p =>
        p.type ? p.type.getText(sourceFile) : "any",
      )
      result.set(node.name.text, params)
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
  return result
}

function main(): void {
  const apis = discover(entry)
  assert(apis.length > 0, `No callable functions discovered from ${entry}`)

  const declTypes = parsed.values.decl
    ? loadDeclarationTypes(parsed.values.decl)
    : undefined
  const explicitType = parsed.values.type

  for (let i = 0; i < ITERATIONS; ++i) {
    const entryApi = apis[randomInt(apis.length)]
    const args: unknown[] = []

    if (declTypes) {
      const types = declTypes.get(entryApi.name)
      if (types && types.length === entryApi.fn.length) {
        for (const t of types) {
          args.push(generateValueFromTypeText(t))
        }
      } else {
        for (let j = 0; j < entryApi.fn.length; ++j) {
          args.push(explicitType ? generateValueForType(explicitType) : generateValueForType("any"))
        }
      }
    } else if (explicitType) {
      for (let j = 0; j < entryApi.fn.length; ++j) {
        args.push(generateValueForType(explicitType))
      }
    } else {
      for (let j = 0; j < entryApi.fn.length; ++j) {
        args.push(generateValueForType("any"))
      }
    }

    try {
      entryApi.fn(...args)
    } catch {
      // Expected — random inputs will often be invalid at runtime
    }
  }
}

main()
