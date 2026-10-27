import { Peer } from '../dist/esm/src/auth/Peer.js'
import { ProtoWallet } from '../dist/esm/src/wallet/ProtoWallet.js'
import PrivateKey from '../dist/esm/src/primitives/PrivateKey.js'
import { snapshotAuthMessage } from '../dist/esm/src/auth/AuthMessageValidation.js'
import { runBenchmark } from './lib/benchmark-runner.js'

// BRC-103 general messages between two in-memory peers.
//
// - Peer.toPeer round trip: copy and check the payload, sign, snapshot the
//   outbound message, then the receiver's snapshot and signature check.
// - snapshotAuthMessage on a received general message.
// Payload size defaults to 1 MiB; set AUTH_BENCH_BYTES to change it.

const options = { minSampleMs: 400, samples: 5 }

function linkedPeers() {
  const callbacks = []
  const transport = (from, to) => ({
    send: async message => await callbacks[to](message),
    onData: async callback => {
      callbacks[from] = callback
    }
  })
  const sender = new Peer(new ProtoWallet(PrivateKey.fromRandom()), transport(0, 1))
  const receiver = new Peer(new ProtoWallet(PrivateKey.fromRandom()), transport(1, 0))
  let delivered
  receiver.listenForGeneralMessages(() => delivered())
  const send = async payload =>
    await new Promise((resolve, reject) => {
      delivered = resolve
      sender.toPeer(payload).catch(reject)
    })
  return send
}

async function main() {
  const bytes = Number.parseInt(process.env.AUTH_BENCH_BYTES ?? String(1024 * 1024), 10)
  const payload = Array.from({ length: bytes }, (_, i) => i & 255)
  const send = linkedPeers()
  await send([1]) // handshake

  await runBenchmark(
    `Peer.toPeer round trip (${bytes} byte payload)`,
    async () => await send(payload),
    options
  )
  await runBenchmark(
    'Peer.toPeer round trip (1 KiB payload)',
    async () => await send(payload.slice(0, 1024)),
    options
  )

  const message = {
    version: '0.1',
    messageType: 'general',
    identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
    nonce: Buffer.alloc(32, 1).toString('base64'),
    yourNonce: Buffer.alloc(48, 2).toString('base64'),
    payload,
    signature: Array.from({ length: 71 }, (_, i) => i)
  }
  await runBenchmark(
    `snapshotAuthMessage (${bytes} byte general payload)`,
    () => snapshotAuthMessage(message),
    options
  )
}

try {
  await main()
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
