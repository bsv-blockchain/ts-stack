import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import createBdkModule from '../src/wasm/bdk-core.mjs'

const SAMPLES = 25
const WORKERS = 4

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function loadedWorker(): Promise<Worker> {
  const worker = new Worker(new URL('./warmup-worker.mjs', import.meta.url))
  await once(worker, 'message')
  return worker
}

async function measure(useSnapshot: boolean): Promise<number> {
  const main = await createBdkModule()
  const workers = await Promise.all(
    Array.from({ length: WORKERS }, async () => await loadedWorker())
  )
  try {
    const start = performance.now()
    main.PrepareVerification!()
    let snapshot: Uint8Array | null = null
    if (useSnapshot) {
      const exported = main.ExportVerificationTables!()
      const shared = new SharedArrayBuffer(exported.byteLength)
      snapshot = new Uint8Array(shared)
      snapshot.set(exported)
    }
    const ready = workers.map(async worker => await once(worker, 'message'))
    for (const worker of workers) worker.postMessage(snapshot)
    await Promise.all(ready)
    return performance.now() - start
  } finally {
    await Promise.all(workers.map(async worker => await worker.terminate()))
  }
}

async function main(): Promise<void> {
  const independent: number[] = []
  const snapshot: number[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    if (sample % 2 === 0) {
      independent.push(await measure(false))
      snapshot.push(await measure(true))
    } else {
      snapshot.push(await measure(true))
      independent.push(await measure(false))
    }
  }
  const independentMedian = median(independent)
  const snapshotMedian = median(snapshot)
  console.log(`Node ${process.version}; ${SAMPLES} median samples; ${WORKERS} workers`)
  console.log(`main + independent worker generation: ${independentMedian.toFixed(3)} ms`)
  console.log(`main generation + snapshot imports: ${snapshotMedian.toFixed(3)} ms`)
  console.log(
    `warm-up reduction: ${((1 - snapshotMedian / independentMedian) * 100).toFixed(1)}% ` +
      `(${(independentMedian / snapshotMedian).toFixed(2)}x)`
  )
}

await main()
