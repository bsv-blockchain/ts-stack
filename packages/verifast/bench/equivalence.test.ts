import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import BdkVerifier from '../src/BdkVerifier.js'
import { buildCorpus } from './corpus.js'

const here = dirname(fileURLToPath(import.meta.url))
const wasmEntry = resolve(here, '../src/wasm/bdk-core.mjs')
const hasWasm = existsSync(wasmEntry)

const maybe = hasWasm ? describe : describe.skip

maybe('JS Spend vs BdkVerifier equivalence', () => {
  it('produces identical validity verdicts for every corpus tx', async () => {
    // @ts-expect-error dynamic import of a user-supplied artifact (not present in CI)
    const { default: createBdkModule } = await import('../src/wasm/bdk-core.mjs')
    const verifier = new BdkVerifier(async () => await createBdkModule())
    const corpus = await buildCorpus()

    for (const { name, tx } of corpus) {
      const jsResult = await tx.verify('scripts only')
      const bdkResult = await tx.verify('scripts only', undefined, undefined, verifier)
      expect({ name, bdkResult }).toEqual({ name, bdkResult: jsResult })
    }
  })
})

describe('equivalence harness availability', () => {
  it('reports whether a real wasm artifact is present', () => {
    // Always-on sentinel so CI shows the suite ran; logs guidance when skipping.
    if (!hasWasm) {
      console.log('[verifast] No src/wasm/bdk-core.mjs — equivalence test skipped. See README to supply a build.')
    }
    expect(typeof hasWasm).toBe('boolean')
  })
})
