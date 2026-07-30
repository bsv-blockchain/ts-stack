import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const sdkRoot =
  process.env.SDK_DIST_ROOT == null
    ? new URL('../dist/esm/src/', import.meta.url)
    : pathToFileURL(`${process.env.SDK_DIST_ROOT.replace(/\/$/, '')}/`)
const [
  { default: Beef },
  { default: MerklePath },
  { default: Transaction },
  { default: PrivateKey },
  { default: Script },
  { default: P2PKH }
] = await Promise.all([
  import(new URL('transaction/Beef.js', sdkRoot)),
  import(new URL('transaction/MerklePath.js', sdkRoot)),
  import(new URL('transaction/Transaction.js', sdkRoot)),
  import(new URL('primitives/PrivateKey.js', sdkRoot)),
  import(new URL('script/Script.js', sdkRoot)),
  import(new URL('script/templates/P2PKH.js', sdkRoot))
])

const chainDepth = Number.parseInt(process.env.CHAIN_DEPTH ?? '2000', 10)
const scriptBytes = Number.parseInt(process.env.SCRIPT_BYTES ?? '2048', 10)
const wideInputs = Number.parseInt(process.env.WIDE_INPUTS ?? '100', 10)
const samples = Number.parseInt(process.env.BENCH_SAMPLES ?? '7', 10)

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measure(name, fn, count = samples) {
  const values = []
  let error
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    try {
      await fn()
      values.push(performance.now() - start)
    } catch (cause) {
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
      break
    }
  }
  const result =
    error == null
      ? {
          medianMs: median(values),
          minMs: Math.min(...values),
          maxMs: Math.max(...values),
          samples: values.length
        }
      : { error }
  console.log(`${name}: ${JSON.stringify(result)}`)
  return result
}

function makeAnchor(lockingScript, satoshis, payloadScript) {
  const tx = new Transaction()
  tx.addOutput({ lockingScript, satoshis })
  if (payloadScript != null) tx.addOutput({ lockingScript: payloadScript, satoshis: 0 })
  const txid = tx.id('hex')
  tx.merklePath = new MerklePath(1, [
    [
      { offset: 0, hash: txid, txid: true },
      { offset: 1, hash: 'ab'.repeat(32) }
    ]
  ])
  return tx
}

function makeLargeChain() {
  const payload = new Uint8Array(scriptBytes)
  payload.fill(0x51)
  const payloadScript = Script.fromBinary(payload)
  const lockingScript = Script.fromHex('51')
  let tx = makeAnchor(lockingScript, chainDepth + 10, payloadScript)
  for (let i = 0; i < chainDepth; i++) {
    const next = new Transaction()
    next.addInput({
      sourceTransaction: tx,
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    next.addOutput({ lockingScript, satoshis: chainDepth + 9 - i })
    next.addOutput({ lockingScript: payloadScript, satoshis: 0 })
    tx = next
  }
  return tx
}

async function makeWideTransaction() {
  const privateKey = new PrivateKey(1)
  const p2pkh = new P2PKH()
  const lockingScript = p2pkh.lock(privateKey.toPublicKey().toHash())
  const tx = new Transaction()
  for (let i = 0; i < wideInputs; i++) {
    const source = makeAnchor(lockingScript, 1000)
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: p2pkh.unlock(privateKey),
      sequence: 0xffffffff
    })
  }
  tx.addOutput({ lockingScript, satoshis: wideInputs * 1000 - 1 })
  await tx.sign()
  return tx
}

async function run() {
  console.log(JSON.stringify({ chainDepth, scriptBytes, wideInputs, node: process.version }))
  const chain = makeLargeChain()
  let atomic
  await measure(
    'large-chain cold atomic serialize',
    () => {
      atomic = chain.toAtomicBEEFUint8Array()
    },
    1
  )
  if (atomic == null) return
  console.log(`atomic bytes: ${atomic.length}`)

  await measure('large-chain warm atomic serialize', () => chain.toAtomicBEEFUint8Array())
  await measure('copy-safe structural BEEF parse', () => Beef.fromBinary(atomic))
  if (typeof Beef.fromBinaryView === 'function') {
    await measure('zero-copy structural BEEF parse', () => Beef.fromBinaryView(atomic))
  }
  await measure('linked Atomic BEEF parse', () => Transaction.fromAtomicBEEF(atomic))
  const linked = Transaction.fromAtomicBEEF(atomic)
  await measure('linked spend-chain verify', async () => await linked.verify('scripts only'))
  await measure('BEEF parse and topological sort', () => {
    const beef = Beef.fromBinary(atomic)
    beef.sortTxs()
  })

  const wide = await makeWideTransaction()
  await measure('wide P2PKH sign', async () => await wide.sign(), 3)
  await measure('wide P2PKH verify', async () => await wide.verify('scripts only'), 3)
}

try {
  await run()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
