import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import BdkVerifier from '../src/BdkVerifier.js'
import { buildCorpus, type CorpusEntry } from './corpus.js'

const ITERATIONS = Number(process.env.VERIFAST_ITERATIONS ?? 200)

function countInputs (corpus: CorpusEntry[]): number {
  return corpus.reduce((n, e) => n + e.tx.inputs.length, 0)
}

async function timeRun (
  corpus: CorpusEntry[],
  verifier: BdkVerifier | undefined
): Promise<number> {
  const start = performance.now()
  for (let i = 0; i < ITERATIONS; i++) {
    for (const { tx } of corpus) {
      await tx.verify('scripts only', undefined, undefined, verifier)
    }
  }
  return performance.now() - start
}

async function loadVerifier (): Promise<BdkVerifier | undefined> {
  const here = dirname(fileURLToPath(import.meta.url))
  const wasmEntry = resolve(here, '../src/wasm/bdk-core.mjs')
  if (!existsSync(wasmEntry)) return undefined
  // @ts-expect-error dynamic import of a user-supplied artifact (not present in CI)
  const { default: createBdkModule } = await import('../src/wasm/bdk-core.mjs')
  const v = new BdkVerifier(async () => await createBdkModule())
  // Warm the module so load time is excluded from timings.
  const warm = await buildCorpus()
  await v.verifyScripts({ tx: warm[0].tx, blockHeight: 943816, consensus: true })
  return v
}

async function main (): Promise<void> {
  const corpus = await buildCorpus()
  const inputsPerPass = countInputs(corpus)
  const totalInputs = inputsPerPass * ITERATIONS

  const jsMs = await timeRun(corpus, undefined)
  console.log(`pure-JS Spend:   ${jsMs.toFixed(1)} ms  (${(totalInputs / (jsMs / 1000)).toFixed(0)} inputs/s)`)

  const verifier = await loadVerifier()
  if (verifier === undefined) {
    console.log('BDK backend:     SKIPPED — no src/wasm/bdk-core.mjs. See README to supply a build.')
    console.log('(Without a real wasm, only the pure-JS baseline is meaningful.)')
    return
  }

  const bdkMs = await timeRun(corpus, verifier)
  console.log(`BDK wasm:        ${bdkMs.toFixed(1)} ms  (${(totalInputs / (bdkMs / 1000)).toFixed(0)} inputs/s)`)
  console.log(`speedup:         ${(jsMs / bdkMs).toFixed(2)}x`)
}

try {
  await main()
} catch (e) {
  console.error(e)
  process.exit(1)
}
