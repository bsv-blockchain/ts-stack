import { BdkVerifier } from '../mod.browser.js'
import { buildCorpus } from '../bench/corpus.js'

interface BrowserResult {
  vectors: Array<{ name: string, expected: boolean, js: boolean, bdk: boolean }>
  workerBatch: {
    count: number
    allValid: boolean
  }
  benchmark: {
    iterations: number
    samples: number
    cases: Array<{
      name: string
      inputs: number
      jsMedianMs: number
      jsP95Ms: number
      bdkMedianMs: number
      bdkP95Ms: number
      jsInputsPerSecond: number
      bdkInputsPerSecond: number
      speedup: number
    }>
  }
}

declare global {
  interface Window {
    __VERIFAST_RESULT__?: BrowserResult
    __VERIFAST_ERROR__?: string
  }
}

function renderResult (value: string): void {
  const result = document.querySelector('#result')
  if (result === null) throw new Error('missing #result element')
  result.textContent = value
}

async function verdict (run: () => Promise<boolean>): Promise<boolean> {
  try {
    return await run()
  } catch {
    return false
  }
}

function percentile (values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

async function timeVerification (tx: Awaited<ReturnType<typeof buildCorpus>>[number]['tx'], verifier?: BdkVerifier): Promise<number> {
  const start = performance.now()
  for (let i = 0; i < 50; i++) await tx.verify('scripts only', undefined, undefined, verifier)
  return performance.now() - start
}

async function run (): Promise<void> {
  const verifier = new BdkVerifier({
    batchWorkers: 4,
    batchWorkerThreshold: 32,
    registerAsDefault: false
  })
  const corpus = await buildCorpus()
  if (verifier.isReady()) throw new Error('VeriFast must remain lazy before preload')
  await verifier.preload()
  if (!verifier.isReady()) throw new Error('VeriFast did not report ready after preload')
  if (!verifier.shouldVerifyScripts({ tx: corpus[0].tx, blockHeight: 943816, consensus: true })) {
    throw new Error('Warm P2PKH did not select VeriFast')
  }
  const vectors: BrowserResult['vectors'] = []
  for (const { name, tx, expected } of corpus) {
    const js = await verdict(async () => await tx.verify('scripts only'))
    const bdk = await verdict(async () => await tx.verify('scripts only', undefined, undefined, verifier))
    vectors.push({ name, expected, js, bdk })
  }
  await verifier.preloadBatch()
  const workerParams = Array.from({ length: 250 }, () => ({
    tx: corpus[0].tx,
    blockHeight: 943816,
    consensus: true
  }))
  const workerVerdicts = await verifier.verifyScriptsBatch(workerParams)

  const iterations = 50
  const samples = 5
  const cases: BrowserResult['benchmark']['cases'] = []
  for (const { name, tx } of corpus.filter(({ name }) => /^p2pkh-(1|5|20)in-valid$/.test(name))) {
    await tx.verify('scripts only')
    await tx.verify('scripts only', undefined, undefined, verifier)
    const jsTimes: number[] = []
    const bdkTimes: number[] = []
    for (let sample = 0; sample < samples; sample++) {
      if (sample % 2 === 0) {
        jsTimes.push(await timeVerification(tx))
        bdkTimes.push(await timeVerification(tx, verifier))
      } else {
        bdkTimes.push(await timeVerification(tx, verifier))
        jsTimes.push(await timeVerification(tx))
      }
    }
    const jsMedianMs = percentile(jsTimes, 0.5)
    const bdkMedianMs = percentile(bdkTimes, 0.5)
    cases.push({
      name,
      inputs: tx.inputs.length,
      jsMedianMs,
      jsP95Ms: percentile(jsTimes, 0.95),
      bdkMedianMs,
      bdkP95Ms: percentile(bdkTimes, 0.95),
      jsInputsPerSecond: tx.inputs.length * iterations / (jsMedianMs / 1000),
      bdkInputsPerSecond: tx.inputs.length * iterations / (bdkMedianMs / 1000),
      speedup: jsMedianMs / bdkMedianMs
    })
  }

  window.__VERIFAST_RESULT__ = {
    vectors,
    workerBatch: {
      count: workerVerdicts.length,
      allValid: workerVerdicts.every(Boolean)
    },
    benchmark: { iterations, samples, cases }
  }
  renderResult(JSON.stringify(window.__VERIFAST_RESULT__, null, 2))
}

try {
  await run()
} catch (error) {
  window.__VERIFAST_ERROR__ = error instanceof Error ? error.stack ?? error.message : String(error)
  renderResult(window.__VERIFAST_ERROR__)
}
