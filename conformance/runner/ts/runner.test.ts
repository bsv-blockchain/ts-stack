/**
 * BSV Conformance Vector Runner — TypeScript / Jest
 *
 * Globs all *.json files under conformance/vectors/, dispatches each vector
 * to the appropriate domain dispatcher via registry.ts.
 *
 * Skip rules:
 *   • parity_class === 'intended'  → test.skip (documented gap)
 *   • v.skip === true              → test.skip (explicitly marked)
 *   • any dispatcher throws 'not implemented'
 *                                  → test FAILS; gaps must be declared before execution
 *
 * Note: parity_class === 'best-effort' is NOT skipped — best-effort vectors
 * are executed and their dispatcher runs; only metadata-declared gaps are skipped.
 */

import { describe, test } from '@jest/globals'
import { readdirSync, statSync, readFileSync } from 'fs'
import { join, extname, basename } from 'path'
import { fileURLToPath } from 'url'
import { registerGovernedSkip } from './governedSkip.js'
import { routeForCategory } from './registry.js'

// ── Locate the vectors directory ───────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const VECTORS_DIR = join(__dirname, '..', '..', 'vectors')

// ── Types ──────────────────────────────────────────────────────────────────────
interface VectorFile {
  id: string
  parity_class?: string
  skip_reason?: string
  vectors: VectorEntry[]
}

interface VectorEntry {
  id: string
  parity_class?: string
  skip?: boolean
  skip_reason?: string
  input: Record<string, unknown>
  expected: Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findJsonFiles(dir: string): string[] {
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

function categoryFromFile(filePath: string): string {
  return basename(filePath, '.json').toLowerCase()
}

function isNotImplemented(err: unknown): err is Error {
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
      test('parse JSON', () => {
        throw new Error(`Failed to parse: ${String(e)}`)
      })
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
      const skipReason = v.skip_reason ?? vf.skip_reason

      // Always-skip rules
      if (parityClass === 'intended') {
        registerGovernedSkip(vectorId, skipReason ?? 'missing governed skip reason')
        continue
      }

      if (v.skip === true) {
        registerGovernedSkip(vectorId, skipReason ?? 'missing governed skip reason')
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
          registerGovernedSkip(
            vectorId,
            skipReason ?? `no dispatcher for non-required ${parityClass} capability`
          )
        }
        continue
      }

      // Dispatch
      test(vectorId, async () => {
        try {
          await route.dispatch(cat, input, expected)
        } catch (err) {
          if (isNotImplemented(err)) {
            // A dispatcher cannot discover a skip after Jest has started the
            // test. Non-required gaps must be declared in vector metadata so
            // they are reported as skips rather than false-positive passes.
            throw new Error(
              `${vectorId} reached an unregistered not-implemented path (${parityClass}): ${err.message}`
            )
          }
          throw err
        }
      })
    }
  })
}
