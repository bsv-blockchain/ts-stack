import type { Transaction } from '@bsv/sdk'
import BdkVerifier from '../src/BdkVerifier.js'
import { buildCorpus } from './corpus.js'

const ITERATIONS = Number(process.env.VERIFAST_ITERATIONS ?? 100)
const SAMPLES = Number(process.env.VERIFAST_SAMPLES ?? 7)

interface Stats {
  medianMs: number
  p95Ms: number
  inputsPerSecond: number
}

interface Comparison {
  name: string
  inputs: number
  pureJs: Stats
  bdkWasm: Stats
  speedup: number
}

function percentile (sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function summarize (samples: number[], inputs: number): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const medianMs = percentile(sorted, 0.5)
  return {
    medianMs,
    p95Ms: percentile(sorted, 0.95),
    inputsPerSecond: inputs * ITERATIONS / (medianMs / 1000)
  }
}

async function timeCase (
  tx: Transaction,
  verifier: BdkVerifier | undefined
): Promise<number> {
  const start = performance.now()
  for (let i = 0; i < ITERATIONS; i++) {
    const valid = await tx.verify('scripts only', undefined, undefined, verifier)
    if (!valid) throw new Error('valid benchmark vector was rejected')
  }
  return performance.now() - start
}

async function timeOperation (operation: () => Promise<unknown>): Promise<number> {
  const start = performance.now()
  for (let i = 0; i < ITERATIONS; i++) await operation()
  return performance.now() - start
}

async function main (): Promise<void> {
  const corpus = (await buildCorpus()).filter(({ expected }) => expected)
  const verifier = new BdkVerifier({ mode: 'always' })

  // Instantiate WASM and JIT both paths before collecting samples.
  await corpus[0].tx.verify('scripts only')
  await corpus[0].tx.verify('scripts only', undefined, undefined, verifier)

  const comparisons: Comparison[] = []
  for (const { name, tx } of corpus) {
    const jsSamples: number[] = []
    const bdkSamples: number[] = []
    for (let sample = 0; sample < SAMPLES; sample++) {
      // Alternate the first backend to reduce ordering and thermal bias.
      if (sample % 2 === 0) {
        jsSamples.push(await timeCase(tx, undefined))
        bdkSamples.push(await timeCase(tx, verifier))
      } else {
        bdkSamples.push(await timeCase(tx, verifier))
        jsSamples.push(await timeCase(tx, undefined))
      }
    }
    const inputs = tx.inputs.length
    const pureJs = summarize(jsSamples, inputs)
    const bdkWasm = summarize(bdkSamples, inputs)
    comparisons.push({
      name,
      inputs,
      pureJs,
      bdkWasm,
      speedup: pureJs.medianMs / bdkWasm.medianMs
    })
  }

  console.log(`Node ${process.version}; ${ITERATIONS} iterations x ${SAMPLES} samples; median and p95 wall time`)
  console.log('case                          in  JS median  BDK median  JS inputs/s  BDK inputs/s  speedup')
  for (const result of comparisons) {
    console.log(
      `${result.name.padEnd(29)} ${String(result.inputs).padStart(2)}  ` +
      `${result.pureJs.medianMs.toFixed(1).padStart(8)}ms  ` +
      `${result.bdkWasm.medianMs.toFixed(1).padStart(9)}ms  ` +
      `${result.pureJs.inputsPerSecond.toFixed(0).padStart(11)}  ` +
      `${result.bdkWasm.inputsPerSecond.toFixed(0).padStart(12)}  ` +
      `${result.speedup.toFixed(2).padStart(6)}x`
    )
  }
  console.log('\np95 milliseconds:')
  for (const result of comparisons) {
    console.log(`${result.name}: JS ${result.pureJs.p95Ms.toFixed(1)}, BDK ${result.bdkWasm.p95Ms.toFixed(1)}`)
  }

  const diagnosticTx = corpus[0].tx
  const directSamples: number[] = []
  const orchestrationSamples: number[] = []
  const noOpVerifier = { verifyScripts: async (): Promise<boolean> => true }
  for (let sample = 0; sample < SAMPLES; sample++) {
    directSamples.push(await timeOperation(async () => await verifier.verifyScripts({
      tx: diagnosticTx,
      blockHeight: 943816,
      consensus: true
    })))
    orchestrationSamples.push(await timeOperation(async () => await diagnosticTx.verify(
      'scripts only', undefined, undefined, noOpVerifier
    )))
  }
  const direct = summarize(directSamples, 1)
  const orchestration = summarize(orchestrationSamples, 1)
  console.log('\n1-input P2PKH diagnostic lanes:')
  console.log(`BDK adapter direct: ${direct.medianMs.toFixed(1)} ms (${direct.inputsPerSecond.toFixed(0)} inputs/s)`)
  console.log(`SDK verify + no-op backend: ${orchestration.medianMs.toFixed(1)} ms (${orchestration.inputsPerSecond.toFixed(0)} inputs/s)`)

  if (process.env.VERIFAST_JSON === '1') console.log(JSON.stringify(comparisons))
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exit(1)
}
