// Reproducible storage-ancestor concurrency benchmark.
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const toolboxRoot = process.env.TOOLBOX_OUT_ROOT == null
  ? new URL('../out/src/', import.meta.url)
  : pathToFileURL(`${process.env.TOOLBOX_OUT_ROOT.replace(/\/$/, '')}/`)
const sdkRoot = process.env.SDK_DIST_ROOT == null
  ? new URL('../../../sdk/dist/esm/src/', import.meta.url)
  : pathToFileURL(`${process.env.SDK_DIST_ROOT.replace(/\/$/, '')}/`)
const [{ getBeefForTransaction }, { default: Transaction }, { default: Script }] = await Promise.all([
  import(new URL('storage/methods/getBeefForTransaction.js', toolboxRoot)),
  import(new URL('transaction/Transaction.js', sdkRoot)),
  import(new URL('script/Script.js', sdkRoot))
])

const width = Number.parseInt(process.env.ANCESTOR_WIDTH ?? '32', 10)
const latencyMs = Number.parseInt(process.env.SERVICE_LATENCY_MS ?? '10', 10)
const samples = Number.parseInt(process.env.BENCH_SAMPLES ?? '5', 10)

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const rawByTxid = new Map()
const sources = []
for (let i = 0; i < width; i++) {
  const tx = new Transaction()
  tx.addOutput({ satoshis: i + 1, lockingScript: Script.fromHex('51') })
  rawByTxid.set(tx.id('hex'), tx.toBinary())
  sources.push(tx)
}
const root = new Transaction()
for (const source of sources) {
  root.addInput({
    sourceTXID: source.id('hex'),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff
  })
}
root.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
rawByTxid.set(root.id('hex'), root.toBinary())

let active = 0
let maxActive = 0
const services = {
  getRawTx: async txid => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, latencyMs))
    active--
    return { txid, rawTx: rawByTxid.get(txid), name: 'benchmark' }
  },
  getMerklePath: async () => ({ name: 'benchmark' })
}
const storage = {
  chain: 'main',
  maxRecursionDepth: 3,
  getServices: () => services
}
const options = {
  ignoreNewProven: true,
  ignoreServices: false,
  ignoreStorage: true,
  maxConcurrency: 8
}

const values = []
for (let i = 0; i < samples; i++) {
  const start = performance.now()
  const beef = await getBeefForTransaction(storage, root.id('hex'), options)
  values.push(performance.now() - start)
  if (beef.txs.length !== rawByTxid.size) throw new Error(`Expected ${rawByTxid.size} transactions, received ${beef.txs.length}`)
}

console.log(JSON.stringify({
  width,
  latencyMs,
  maxActive,
  medianMs: median(values),
  minMs: Math.min(...values),
  maxMs: Math.max(...values),
  samples: values.length
}))
