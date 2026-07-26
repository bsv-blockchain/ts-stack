import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const sdkRoot = process.env.SDK_DIST_ROOT == null
  ? new URL('../dist/esm/src/', import.meta.url)
  : pathToFileURL(`${process.env.SDK_DIST_ROOT.replace(/\/$/, '')}/`)
const [
  { default: Beef },
  { default: Script },
  { default: Transaction },
  { default: WalletWireProcessor },
  { default: WalletWireTransceiver }
] = await Promise.all([
  import(new URL('transaction/Beef.js', sdkRoot)),
  import(new URL('script/Script.js', sdkRoot)),
  import(new URL('transaction/Transaction.js', sdkRoot)),
  import(new URL('wallet/substrates/WalletWireProcessor.js', sdkRoot)),
  import(new URL('wallet/substrates/WalletWireTransceiver.js', sdkRoot))
])

const payloadBytes = Number.parseInt(
  process.env.WALLET_BENCH_BYTES ?? String(8 * 1024 * 1024),
  10
)
const samples = Number.parseInt(process.env.BENCH_SAMPLES ?? '7', 10)

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measure (name, operation, warmups = 2) {
  for (let i = 0; i < warmups; i++) await operation()
  const values = []
  for (let i = 0; i < samples; i++) {
    const start = performance.now()
    await operation()
    values.push(performance.now() - start)
  }
  console.log(`${name}: ${JSON.stringify({
    medianMs: median(values),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    samples: values.length
  })}`)
}

function makePayload () {
  const bytes = new Uint8Array(payloadBytes)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
  return bytes
}

function makeWalletWire (onInternalize) {
  const wallet = new Proxy(
    { internalizeAction: onInternalize },
    {
      get (target, property) {
        if (property in target) return target[property]
        return async () => {
          throw new Error(`Unexpected benchmark wallet call: ${String(property)}`)
        }
      }
    }
  )
  return new WalletWireTransceiver(new WalletWireProcessor(wallet))
}

async function run () {
  const payload = makePayload()
  const hex = `${payload.length.toString(16).padStart(8, '0')}${'51'.repeat(payload.length)}`
  console.log(JSON.stringify({ payloadBytes, samples, node: process.version }))

  await measure('large hex Script.fromHex', () => {
    const script = Script.fromHex(hex)
    if (script.toUint8Array().length !== payload.length + 4) {
      throw new Error('hex script length changed')
    }
  })

  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromBinary(payload) })
  const txid = tx.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const atomic = beef.toUint8ArrayAtomic(txid)
  console.log(`atomic bytes: ${atomic.length}`)
  await measure('warm Beef.toUint8ArrayAtomic', () => {
    if (beef.toUint8ArrayAtomic(txid).length !== atomic.length) {
      throw new Error('Atomic BEEF length changed')
    }
  }, 0)

  let receivedBytes = 0
  const wallet = makeWalletWire(async args => {
    receivedBytes = args.tx.length
    return { accepted: true }
  })
  const internalizeArgs = {
    tx: payload,
    outputs: [],
    description: 'generic large-data wallet benchmark'
  }
  await measure('Wallet Wire internalizeAction round trip', async () => {
    await wallet.internalizeAction(internalizeArgs)
    if (receivedBytes !== payload.length) {
      throw new Error('Wallet Wire payload length changed')
    }
  })
}

await run()
