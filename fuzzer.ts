import assert from "node:assert"
import {randomInt, randomBytes} from "node:crypto"
import {createRequire} from "node:module"
import path from "node:path"

const ITERATIONS = process.env.ITERATIONS
  ? Number(process.env.ITERATIONS)
  : 100

const index = process.argv[2]
assert(typeof index === "string")
assert(index.length > 0)

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

function generateValue(): unknown {
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

function main(): void {
  const apis = discover(index)
  assert(apis.length > 0, `No callable functions discovered from ${index}`)

  for (let i = 0; i < ITERATIONS; ++i) {
    const entry = apis[randomInt(apis.length)]
    const args = Array.from({length: entry.fn.length}, () => generateValue())

    try {
      entry.fn(...args)
    } catch {
      // Expected — random inputs will often be invalid at runtime
    }
  }
}

main()
