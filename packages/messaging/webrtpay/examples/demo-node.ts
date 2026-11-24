/**
 * Two wallets in one process pay each other over a real WebRTC data channel
 * (node-datachannel), with an in-memory hub carrying the signaling.
 *
 * From packages/messaging/webrtpay in a ts-stack checkout, after `pnpm install` at the
 * repository root and `pnpm build`:
 *
 *   node --experimental-strip-types examples/demo-node.ts
 *
 * It imports the package by its own name, so it runs the built entry (`dist/src/index.js`)
 * as an app that depends on `@bsv/webrtpay` would. Both peers bind to 127.0.0.1.
 */
import {
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  UnlockingScript
} from '@bsv/sdk'
import type { InternalizeActionArgs, InternalizeActionResult } from '@bsv/sdk'
import { cleanup } from 'node-datachannel'
import { RTCPeerConnection } from 'node-datachannel/polyfill'
import {
  DirectPayClient,
  PAYMENT_PROTOCOL_ID,
  WebRTPayError,
  acceptDirectPayment,
  createMemoryHub,
  randomBytes,
  toBase64
} from '@bsv/webrtpay'
import type { PaymentToken, PubKeyHex, RtcOptions, WalletLike } from '@bsv/webrtpay'

/**
 * A wallet with real keys, signatures and encryption (`ProtoWallet`). It has no storage, so
 * `internalizeAction` is a stand-in that only reports what a real wallet would store.
 */
function demoWallet(name: string): WalletLike {
  return Object.assign(new ProtoWallet(PrivateKey.fromRandom()), {
    internalizeAction(args: InternalizeActionArgs): Promise<InternalizeActionResult> {
      const [output] = args.outputs
      console.log(
        `[${name}] internalizeAction (stand-in): output ${output.outputIndex} as '${output.protocol}', ` +
          `labels ${JSON.stringify(args.labels)}`
      )
      return Promise.resolve({ accepted: true })
    }
  })
}

/**
 * The payment a payer hands over: a transaction paying `satoshis` to the payee's BRC-29 key
 * for a fresh derivation prefix and suffix. A real wallet builds and broadcasts it with
 * `createAction`; here the input comes from a made-up parent proven by a one-transaction
 * block, so it is valid Atomic BEEF without a network. Nothing is broadcast.
 */
async function makePayment(
  payer: WalletLike,
  payee: PubKeyHex,
  satoshis: number
): Promise<PaymentToken> {
  const derivationPrefix = toBase64(randomBytes(32))
  const derivationSuffix = toBase64(randomBytes(32))
  const { publicKey } = await payer.getPublicKey({
    protocolID: PAYMENT_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: payee
  })

  const parent = new Transaction()
  parent.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: new UnlockingScript()
  })
  const funding = PrivateKey.fromRandom().toPublicKey()
  parent.addOutput({ lockingScript: new P2PKH().lock(funding.toHash()), satoshis: satoshis + 1000 })
  parent.merklePath = MerklePath.fromCoinbaseTxidAndHeight(parent.id('hex'), 1)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript()
  })
  tx.addOutput({
    lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toHash()),
    satoshis
  })
  return {
    customInstructions: { derivationPrefix, derivationSuffix },
    transaction: tx.toAtomicBEEF(),
    amount: satoshis,
    outputIndex: 0
  }
}

function short(key: PubKeyHex): string {
  return `${key.slice(0, 10)}…`
}

const rtc: RtcOptions = {
  // The polyfill implements the browser interface; only its static side differs.
  RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  extraConfig: { bindAddress: '127.0.0.1' }
}

const hub = createMemoryHub()
const payeeWallet = demoWallet('payee')
const payerWallet = demoWallet('payer')
const { publicKey: payeeKey } = await payeeWallet.getPublicKey({ identityKey: true })
const { publicKey: payerKey } = await payerWallet.getPublicKey({ identityKey: true })
const payee = new DirectPayClient({
  wallet: payeeWallet,
  signaler: hub.signaler(payeeKey),
  rtc,
  chain: 'test'
})
const payer = new DirectPayClient({
  wallet: payerWallet,
  signaler: hub.signaler(payerKey),
  rtc,
  chain: 'test'
})

// Payee: answer offers and take custody of each payment once. A real app persists `seen`,
// and keeps a payment that verified but could not be internalized for a passing reason
// (wallet locked, storage down) to retry, acking it 'received': see the README.
const seen = new Set<string>()
await payee.startReceiving({
  async onPayment(p) {
    try {
      const { status, txid } = await acceptDirectPayment(payeeWallet, p, {
        seen: {
          has: key => seen.has(key),
          add: key => {
            seen.add(key)
          }
        }
      })
      console.log(`[payee] ${status}: ${p.token.amount} sats from ${short(p.sender)} in ${txid}`)
      return 'accepted' // a duplicate is already in the wallet
    } catch (e) {
      // malformed, or it does not pay this wallet: nothing was stored
      if (e instanceof WebRTPayError && e.code === 'invalid_payment') {
        return { status: 'rejected', reason: e.message }
      }
      throw e // acked 'rejected' with a generic reason; the payer keeps its token
    }
  },
  onSession: peer => console.log(`[payee] authenticated session with ${short(peer)}`),
  onError: e => console.error('[payee] error:', e)
})
console.log(`[payee] receiving as ${short(payeeKey)}`)

try {
  // Payer: connect and authenticate first; if the payee cannot be reached, nothing is spent.
  const peer = await payer.connect(payeeKey)
  console.log(`[payer] connected; the payee proved ${short(peer.peerIdentityKey)}`)
  const token = await makePayment(payerWallet, payeeKey, 1000)
  const ack = await payer.sendPayment(peer, token, { note: 'demo' })
  console.log('[payer] payment.ack', JSON.stringify(ack))
  if (ack.status !== 'accepted') process.exitCode = 1
} finally {
  await payer.close()
  await payee.close()
  cleanup() // let node-datachannel's threads end so the process can exit
}
