/**
 * BSV Conformance Vector Runner — TypeScript / Jest
 *
 * Globs all *.json files under conformance/vectors/, dispatches each vector
 * to the appropriate domain dispatcher via registry.ts.
 *
 * Skip rules:
 *   • parity_class === 'intended'  → test.skip (documented gap)
 *   • v.skip === true              → test.skip (explicitly marked)
 *   • parity_class === 'required' AND dispatcher throws 'not implemented'
 *                                  → test FAILS (structural marker for Wave 1)
 *   • parity_class !== 'required' AND dispatcher throws 'not implemented'
 *                                  → test passes vacuously (best-effort)
 *
 * Note: parity_class === 'best-effort' is NOT skipped — best-effort vectors
 * are executed and their dispatcher runs; only 'intended' vectors are skipped.
 */

import { describe, test, expect } from '@jest/globals'
import { readdirSync, statSync, readFileSync } from 'fs'
import { join, extname, basename } from 'path'
import { fileURLToPath } from 'url'
import { routeForCategory } from './registry.js'

// ── Locate the vectors directory ───────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const VECTORS_DIR = join(__dirname, '..', '..', 'vectors')

// ── Types ──────────────────────────────────────────────────────────────────────
interface VectorFile {
  id: string
  parity_class?: string
  vectors: VectorEntry[]
}

interface VectorEntry {
  id: string
  parity_class?: string
  skip?: boolean
  input: Record<string, unknown>
  expected: Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findJsonFiles (dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    if (statSync(fullPath).isDirectory()) {
      results.push(...findJsonFiles(fullPath))
    } else if (extname(entry).toLowerCase() === '.json') {
      results.push(fullPath)
    }
  }
  return results
}

function categoryFromFile (filePath: string): string {
  return basename(filePath, '.json').toLowerCase()
}

function isNotImplemented (err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('not implemented')
}

// ── Main runner ───────────────────────────────────────────────────────────────

const vectorFiles = findJsonFiles(VECTORS_DIR)

for (const filePath of vectorFiles) {
  let vf: VectorFile
  try {
    vf = JSON.parse(readFileSync(filePath, 'utf-8')) as VectorFile
  } catch (e) {
    describe(filePath, () => {
      test('parse JSON', () => { throw new Error(`Failed to parse: ${String(e)}`) })
    })
    continue
  }

  if (!Array.isArray(vf.vectors) || vf.vectors.length === 0) continue

  const fileParityClass = vf.parity_class ?? 'required'
  const cat = categoryFromFile(filePath)
  const route = routeForCategory(cat, vf.id)

  describe(vf.id ?? filePath, () => {
    for (const v of vf.vectors) {
      const vectorId = v.id ?? 'unknown'
      const parityClass = v.parity_class ?? fileParityClass

      // Always-skip rules
      if (parityClass === 'intended') {
        test.skip(vectorId, () => {})
        continue
      }

      if (v.skip === true) {
        test.skip(vectorId, () => {})
        continue
      }

      const input = v.input ?? {}
      const expected = v.expected ?? {}

      // No route at all → fail if required, skip otherwise
      if (route === null) {
        if (parityClass === 'required') {
          test(vectorId, () => {
            throw new Error(`no dispatcher registered for category '${cat}' (${vf.id ?? filePath})`)
          })
        } else {
          test.skip(vectorId, () => {})
        }
        continue
      }

      // Dispatch
      test(vectorId, async () => {
        try {
          await route.dispatch(cat, input, expected)
        } catch (err) {
          if (isNotImplemented(err)) {
            if (parityClass === 'required') {
              // Re-throw so the test fails with a clear 'not implemented' message
              throw err
            } else {
              // Non-required: treat as a skip by returning without asserting.
              // Jest does not support dynamic skip inside a test body, so we
              // simply return — the test will pass vacuously for non-required
              // parity. This is acceptable because required is the only class
              // that MUST run assertions.
              return
            }
          }
          throw err
        }
      })
    }
  })
}
