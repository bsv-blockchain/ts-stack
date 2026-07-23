import {
  MerklePath,
  P2PKH,
  PrivateKey,
  Script,
  Transaction
} from '@bsv/sdk'
import BdkVerifier from '../src/BdkVerifier.js'
import { buildCorpus, spendsForTransaction } from './corpus.js'

const BATCH_SIZES = [1, 10, 50, 250] as const
const SCRIPT_SIZES = [1024, 64 * 1024, 1024 * 1024, 4 * 1024 * 1024] as const
const SAMPLES = 25

function median (values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measure (operation: () => Promise<void>, samples = SAMPLES): Promise<number> {
  await operation()
  const values: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now()
    await operation()
    values.push(performance.now() - start)
  }
  return median(values)
}

function measureSync (operation: () => void, iterations: number): number {
  const values: number[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) operation()
    values.push((performance.now() - start) / iterations)
  }
  return median(values)
}

async function transactionWithOutputScript (scriptSize: number): Promise<Transaction> {
  const key = new PrivateKey(42)
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key)
  })
  const bytes = new Uint8Array(scriptSize)
  bytes[0] = 0x6a
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromBinaryView(bytes) })
  await tx.sign()
  return tx
}

async function dependentP2pkhChain (length: number): Promise<Transaction> {
  const key = new PrivateKey(84)
  let previous = new Transaction()
  previous.addInput({
    sourceTXID: '01'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  previous.addOutput({
    satoshis: 2,
    lockingScript: new P2PKH().lock(key.toAddress())
  })
  previous.merklePath = new MerklePath(800000, [
    [{ offset: 0, hash: previous.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])
  for (let index = 0; index < length; index++) {
    const transaction = new Transaction()
    transaction.addInput({
      sourceTransaction: previous,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(key)
    })
    transaction.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock(key.toAddress())
    })
    await transaction.sign()
    previous = transaction
  }
  return previous
}

function collectMemory (): { heapMiB: number, rssMiB: number } {
  globalThis.gc?.()
  const usage = process.memoryUsage()
  return {
    heapMiB: usage.heapUsed / (1024 * 1024),
    rssMiB: usage.rss / (1024 * 1024)
  }
}

async function main (): Promise<void> {
  const verifier = new BdkVerifier({
    maxBatchItems: 250,
    batchWorkers: 1,
    registerAsDefault: false
  })
  const parallelVerifier = new BdkVerifier({
    maxBatchItems: 250,
    batchWorkers: 4,
    batchWorkerThreshold: 32,
    registerAsDefault: false
  })
  const entry = (await buildCorpus()).find(({ name }) => name === 'p2pkh-1in-valid')
  if (entry === undefined) throw new Error('P2PKH benchmark fixture is missing')
  const spend = spendsForTransaction(entry.tx)[0]
  const ef = entry.tx.toEFBinary()
  const efParams = {
    extendedTransaction: ef,
    utxoHeights: Int32Array.of(800000),
    blockHeight: 943816,
    consensus: true
  }

  try {
    await verifier.preload()
    await parallelVerifier.preloadBatch()
    console.log(`Node ${process.version}; ${SAMPLES} median samples; real BDK WASM`)
    console.log('\nWarm batch scheduling (milliseconds per complete batch):')
    console.log('items  Spend 1 worker  Spend 4 workers  speedup  EF 1 worker  EF 4 workers  speedup')
    for (const count of BATCH_SIZES) {
      const spends = Array.from({ length: count }, () => ({ spend }))
      const transactions = Array.from({ length: count }, () => efParams)
      const spendSingle = await measure(async () => {
        if ((await verifier.verifySpendsBatch(spends)).some(valid => !valid)) {
          throw new Error('Spend batch was rejected')
        }
      })
      const spendParallel = await measure(async () => {
        if ((await parallelVerifier.verifySpendsBatch(spends)).some(valid => !valid)) {
          throw new Error('Parallel Spend batch was rejected')
        }
      })
      const efSingle = await measure(async () => {
        if ((await verifier.verifyScriptsBatchFromEF(transactions)).some(valid => !valid)) {
          throw new Error('EF batch was rejected')
        }
      })
      const efParallel = await measure(async () => {
        if ((await parallelVerifier.verifyScriptsBatchFromEF(transactions)).some(valid => !valid)) {
          throw new Error('Parallel EF batch was rejected')
        }
      })
      console.log(
        `${String(count).padStart(5)}  ${spendSingle.toFixed(3).padStart(14)}  ` +
        `${spendParallel.toFixed(3).padStart(15)}  ${(spendSingle / spendParallel).toFixed(2).padStart(7)}x  ` +
        `${efSingle.toFixed(3).padStart(11)}  ${efParallel.toFixed(3).padStart(12)}  ` +
        `${(efSingle / efParallel).toFixed(2).padStart(7)}x`
      )
    }

    const chain = await dependentP2pkhChain(250)
    const chainSingle = await measure(async () => {
      if (!await chain.verify('scripts only', undefined, undefined, verifier)) {
        throw new Error('single-instance dependent graph was rejected')
      }
    })
    const chainParallel = await measure(async () => {
      if (!await chain.verify('scripts only', undefined, undefined, parallelVerifier)) {
        throw new Error('parallel dependent graph was rejected')
      }
    })
    console.log('\n250-transaction dependent graph through Transaction.verify:')
    console.log(
      `one instance ${chainSingle.toFixed(3)} ms; four workers ` +
      `${chainParallel.toFixed(3)} ms; ` +
      `${(chainSingle / chainParallel).toFixed(2)}x`
    )

    console.log('\nEF serialization (milliseconds per call):')
    console.log('script       EF bytes  number[] cold  typed cold  cached typed  cold gain')
    for (const scriptSize of SCRIPT_SIZES) {
      const tx = await transactionWithOutputScript(scriptSize)
      let sequence = 0
      const legacy = measureSync(() => {
        tx.lockTime = sequence++ & 1
        tx.toEF()
      }, scriptSize >= 1024 * 1024 ? 3 : 15)
      const typed = measureSync(() => {
        tx.lockTime = sequence++ & 1
        tx.toEFBinary()
      }, scriptSize >= 1024 * 1024 ? 3 : 15)
      tx.toEFBinary()
      const cached = measureSync(() => { tx.toEFBinary() }, scriptSize >= 1024 * 1024 ? 100 : 1000)
      const scriptLabel = `${Math.round(scriptSize / 1024)} KiB`.padStart(8)
      console.log(
        `${scriptLabel}  ${String(tx.toEFBinary().byteLength).padStart(9)}  ` +
        `${legacy.toFixed(3).padStart(13)}  ${typed.toFixed(3).padStart(10)}  ` +
        `${cached.toFixed(4).padStart(12)}  ${(legacy / typed).toFixed(2).padStart(8)}x`
      )
    }

    const before = collectMemory()
    await verifier.verifySpendsBatch(Array.from({ length: 250 }, () => ({ spend })))
    const after = collectMemory()
    console.log('\n250-Spend retained-memory delta after forced GC:')
    console.log(`heap ${(after.heapMiB - before.heapMiB).toFixed(2)} MiB; RSS ${(after.rssMiB - before.rssMiB).toFixed(2)} MiB`)
  } finally {
    verifier.dispose()
    parallelVerifier.dispose()
  }
}

await main()
