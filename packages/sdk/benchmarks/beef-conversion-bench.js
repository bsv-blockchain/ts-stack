import Transaction from '../dist/esm/src/transaction/Transaction.js'
import { Beef } from '../dist/esm/src/transaction/Beef.js'
import PrivateKey from '../dist/esm/src/primitives/PrivateKey.js'
import P2PKH from '../dist/esm/src/script/templates/P2PKH.js'
import LockingScript from '../dist/esm/src/script/LockingScript.js'
import { runBenchmark } from './lib/benchmark-runner.js'

// Legacy number[] and hex BEEF paths against their byte equivalents on one
// multi-transaction BEEF; each transaction carries a data output so the BEEF
// reaches realistic sizes (defaults: 1000 transactions, 4000 bytes each, ~4 MB).
// `node benchmarks/beef-conversion-bench.js [depth] [dataBytes]`

// OP_FALSE OP_RETURN OP_PUSHDATA2 <data>
function dataOutput(size) {
  const hex =
    '006a4d' +
    (size & 0xff).toString(16).padStart(2, '0') +
    (size >> 8).toString(16).padStart(2, '0') +
    'ab'.repeat(size)
  return LockingScript.fromHex(hex)
}

async function buildChain(depth, dataBytes) {
  const data = dataOutput(dataBytes)
  const privateKey = new PrivateKey(1)
  const p2pkh = new P2PKH()
  const lockingScript = p2pkh.lock(privateKey.toPublicKey().toHash())
  const root = new Transaction()
  root.addOutput({ lockingScript, satoshis: 1_000_000 })
  // Each transaction spends its parent, which must be signed first.
  return Array.from({ length: depth - 1 }, (_, index) => index + 1).reduce(
    async (parentPromise, i) => {
      const parent = await parentPromise
      const next = new Transaction()
      next.addInput({
        sourceTransaction: parent,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: p2pkh.unlock(privateKey)
      })
      next.addOutput({ lockingScript, satoshis: 1_000_000 - i })
      next.addOutput({ lockingScript: data, satoshis: 0 })
      await next.sign()
      return next
    },
    Promise.resolve(root)
  )
}

async function main() {
  const depth = Number.parseInt(process.argv[2] ?? '1000', 10)
  const dataBytes = Number.parseInt(process.argv[3] ?? '4000', 10)
  const options = { minSampleMs: 300, samples: 6 }
  const tx = await buildChain(depth, dataBytes)
  const bytes = tx.toBEEFBytes()
  const hex = tx.toHexBEEF()
  const beef = Beef.fromBinary(bytes)
  console.log(`BEEF with ${depth} transactions, ${bytes.length} bytes`)

  await runBenchmark('Transaction.toBEEF (number[])', () => tx.toBEEF(), options)
  await runBenchmark('Transaction.toBEEFBytes (Uint8Array)', () => tx.toBEEFBytes(), options)
  await runBenchmark('Transaction.toHexBEEF', () => tx.toHexBEEF(), options)
  await runBenchmark('Transaction.fromHexBEEF', () => Transaction.fromHexBEEF(hex), options)
  await runBenchmark('Beef.toBinary (number[])', () => beef.toBinary(), options)
  await runBenchmark('Beef.toUint8Array', () => beef.toUint8Array(), options)
  await runBenchmark('Beef.mergeBeef(Beef)', () => new Beef().mergeBeef(beef), options)
  await runBenchmark('Beef.mergeBeef(Uint8Array)', () => new Beef().mergeBeef(bytes), options)
}

try {
  await main()
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
