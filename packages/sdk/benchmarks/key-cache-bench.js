import PrivateKey from '../dist/esm/src/primitives/PrivateKey.js'
import BigNumber from '../dist/esm/src/primitives/BigNumber.js'
import * as ECDSA from '../dist/esm/src/primitives/ECDSA.js'
import Transaction from '../dist/esm/src/transaction/Transaction.js'
import P2PKH from '../dist/esm/src/script/templates/P2PKH.js'
import { runBenchmark } from './lib/benchmark-runner.js'

// Public-key reuse and verifier memory.
//
// - PrivateKey.toPublicKey on one key, as P2PKH and key derivation call it.
// - Signing a transaction whose inputs all unlock with the same key.
// - Verifying signatures from many distinct public keys, reporting heap growth.
//   Run with `node --expose-gc` for a stable heap reading.

const options = { minSampleMs: 400, samples: 8 }

function buildSpend(privateKey, inputs) {
  const p2pkh = new P2PKH()
  const lockingScript = p2pkh.lock(privateKey.toPublicKey().toHash())
  const source = new Transaction()
  for (let i = 0; i < inputs; i++) source.addOutput({ lockingScript, satoshis: 1000 })
  const spend = new Transaction()
  for (let i = 0; i < inputs; i++) {
    spend.addInput({
      sourceTransaction: source,
      sourceOutputIndex: i,
      unlockingScriptTemplate: p2pkh.unlock(privateKey)
    })
  }
  spend.addOutput({ lockingScript, satoshis: inputs * 1000 - 500 })
  return spend
}

function heapUsed() {
  globalThis.gc?.()
  return process.memoryUsage().heapUsed
}

async function main() {
  const privateKey = PrivateKey.fromRandom()

  await runBenchmark('PrivateKey.toPublicKey (same key)', () => privateKey.toPublicKey(), options)

  const inputs = Number.parseInt(process.env.KEY_BENCH_INPUTS ?? '200', 10)
  await runBenchmark(
    `Transaction.sign (${inputs} P2PKH inputs, one key)`,
    async () => {
      await buildSpend(privateKey, inputs).sign()
    },
    { minSampleMs: 400, samples: 5 }
  )

  const distinctKeys = Number.parseInt(process.env.KEY_BENCH_DISTINCT ?? '2000', 10)
  const message = new BigNumber('deadbeefcafebabe', 16)
  const signed = Array.from({ length: distinctKeys }, () => {
    const key = PrivateKey.fromRandom()
    return { publicKey: key.toPublicKey(), signature: ECDSA.sign(message, key) }
  })
  const before = heapUsed()
  const start = performance.now()
  for (const { publicKey, signature } of signed) {
    if (!ECDSA.verify(message, signature, publicKey)) throw new Error('verify failed')
  }
  const elapsed = performance.now() - start
  const growth = (heapUsed() - before) / (1024 * 1024)
  console.log(
    `ECDSA.verify over ${distinctKeys} distinct keys: ${(elapsed / distinctKeys).toFixed(3)} ms/op, ` +
      `heap growth ${growth.toFixed(2)} MiB${globalThis.gc ? '' : ' (run with --expose-gc for a stable reading)'}`
  )
}

try {
  await main()
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
