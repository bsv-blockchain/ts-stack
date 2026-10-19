# @bsv/webrtpay

Direct wallet-to-wallet BSV payments over WebRTC data channels, authenticated with BRC-100
identity keys.

A payer hands the payee the same `PaymentToken` that PeerPay sends through MessageBox (Atomic
BEEF, as a `number[]` or a `Uint8Array` going in and a `number[]` coming out, plus the BRC-29
derivation prefix and suffix), but over an encrypted peer-to-peer data channel: no server
stores it or can read it (when two networks need a TURN relay, the relay carries only DTLS
ciphertext). Both sides prove their identity key bound to the DTLS session, so whoever carries
the signaling cannot read, change or redirect a payment. A carrier can still drop signals,
which stops a direct payment from happening (a denial of service), but it can never take or
divert the funds: the payer connects before it creates the transaction.

- Browser-safe root entry: no Node builtins; `RTCPeerConnection` from the platform or injected
  (node-datachannel in Node, react-native-webrtc in React Native).
- `@bsv/sdk` is the only (peer) dependency of the root entry. `@bsv/webrtpay/server` (Node) adds
  a small relay and depends on `ws`.
- Status: 0.2.0, experimental. The byte-level protocol is in [docs/protocol.md](docs/protocol.md).

## Why there is still a signaling step

STUN servers cannot coordinate two parties into a WebRTC channel. STUN (RFC 8489) only tells a
client its own public address; it carries no messages between parties. To open a channel each
side needs the other's ICE username fragment and password, DTLS certificate fingerprint and
candidate addresses (RFC 8445 §5.3, §7.2.2), which is the SDP offer and answer, and they have
to travel **both ways** over a channel that already works. TURN (RFC 8656) relays the data
when two NATs cannot be punched through; it does not carry signaling either. A peer that never
receives the answer stays in `checking` forever, and the answerer gives up after about 15 s
(Chromium) or 31 s (libdatachannel).

So the **payment** never needs a server, but the two SDPs (about 1 KB, encrypted) need a
carrier. This package makes the carrier a plug-in:

- in person, two QR codes (`webrtpay1:` offer and answer codes), no server at all;
- remotely, by identity key, through MessageBox or a small relay (`@bsv/webrtpay/server`).

## Install

```sh
npm install @bsv/webrtpay @bsv/sdk
```

Requirements: Node 22 or later, or a browser; `@bsv/sdk` `^2.8.6 || ^3.0.0`, a required peer
dependency; a BRC-100 wallet
(`WalletClient`, a wallet-toolbox `Wallet`, anything with the methods in `WalletLike`). In Node,
inject a WebRTC implementation such as `node-datachannel/polyfill` through `rtc`.

- **ESM only.** Use `import`; a CommonJS `require()` of the package needs Node 22.12 or later.
- **DOM types.** The type declarations use the DOM's WebRTC types (`RTCPeerConnection`,
  `RTCIceServer`, `RTCIceTransportPolicy`). A Node or React Native project that type-checks
  them needs `"lib": ["ES2022", "DOM"]` in its `tsconfig.json`, or declarations of its own for
  those names; with `skipLibCheck` and neither, they silently become `any`.

## Quick start

### Receive (payee)

```ts
import {
  DirectPayClient,
  MessageBoxSignaler,
  WebRTPayError,
  acceptDirectPayment,
  verifyDirectPayment
} from '@bsv/webrtpay'

const originator = 'wallet.example.com'
const client = new DirectPayClient({
  wallet, // a BRC-100 wallet
  originator,
  signaler: new MessageBoxSignaler(messageBoxClient), // a @bsv/message-box-client client
  rtc: { iceServers: [{ urls: 'stun:stun.example.com:3478' }] },
  chain: 'main'
})

// Yours: `seen`, a durable SeenStore (has/add), is what makes a re-delivered payment harmless;
// `retryStore` is a durable store of payments to internalize later, with `size` and `keep`;
// `isTransient` says whether a wallet failure will pass (wallet locked, storage, IPC or
// network down).
const MAX_KEPT = 50

await client.startReceiving({
  async onPayment(p) {
    // 1. Check that output p.token.outputIndex pays this wallet's BRC-29 key for p.sender.
    try {
      await verifyDirectPayment(wallet, p, { originator })
    } catch (e) {
      // malformed, or it does not pay this wallet: nothing was stored
      if (e instanceof WebRTPayError && e.code === 'invalid_payment') {
        return { status: 'rejected', reason: e.message }
      }
      throw e // not checked yet (wallet failure): acked 'rejected', the payer keeps its token
    }
    // 2. It verified, so it is never refused. Internalize it once.
    try {
      await acceptDirectPayment(wallet, p, {
        originator,
        seen,
        onSeenError: e => console.warn('payment taken but not recorded as seen', e)
      })
      return 'accepted'
    } catch (e) {
      // the wallet cannot take it right now: keep it (up to the cap) and retry locally
      if (isTransient(e) && retryStore.size < MAX_KEPT) {
        await retryStore.keep(p)
        return 'received'
      }
      throw e // acked 'rejected' with a generic reason; the payer keeps its token
    }
  },
  onError: e => console.warn('direct payment session failed', e)
})
```

`p.sender` is the identity key the payer proved in the handshake. By the time a payment arrives
the payer has usually broadcast it, so a payment that verifies is never refused: when only
internalizing fails for a passing reason, keep it, retry locally and return `'received'`. Call
`verifyDirectPayment` first and keep only failures after it: a failure before it says nothing
about the payment, and keeping those would let anyone fill the store. Keep them in a store with
a cap, and only for failures that pass: a wallet's argument or proof errors (a BEEF it cannot
verify fails with `WERR_INVALID_PARAMETER`, say) do not. A handler that throws makes the ack
`rejected`, so once the store holds `MAX_KEPT` payments the payer gets `rejected` (with the
`txid`): it keeps its token and delivers it again later, directly or through MessageBox.
`acceptDirectPayment` reports a payment the wallet took as `accepted` even when
`seen.add` fails afterwards (`onSeenError` hears about it). Receiving answers offers
automatically within the inbound limits (3 sessions, 1 per sender, a sender's new dial
replacing its open session, 10 offers a minute, 3 per sender); see [Security and privacy](#security-and-privacy) before turning it on for users.

### Pay (payer)

`connect` knocks first: a sealed `knock` goes to the payee before any ICE is gathered, and a
receiving payee replies `ring` at once (or a sealed refusal). So an offline payee is known
within `presenceTimeoutMs` (2 s) of the carrier taking the knock, and an online one has
`dialTimeoutMs` (6 s) from its reply to open the channel and prove its identity; `timeoutMs` caps the whole dial (default `connectMs`,
30 s). Set the defaults with the client's `timeouts: { presenceMs, dialMs, connectMs }` or per
call. `signal` (an `AbortSignal`) cancels one dial: it rejects `closed` (`Dial cancelled`) and
leaves receiving and other dials alone. Map `peer_unreachable` and `rejected`
(`not_receiving`) to "isn't online", and `unavailable` (the carrier refused this side) to
"check your connection". Payees on 0.1.0 do not answer knocks and look offline.

Connect first, then create the transaction: if the payee cannot be reached, nothing is spent. A
payee that answered the dial waits 60 s (its `firstMessageTimeoutMs`) for the payment before it
hangs up, and creating and broadcasting the transaction, permission prompts included, has to
fit in that window. So have the user confirm before `connect`, sign the transaction without
broadcasting it (`noSend`), check that the session is still open (dial again if it is not),
then broadcast and send at once.

```ts
import { P2PKH, PublicKey } from '@bsv/sdk'
import { PAYMENT_PROTOCOL_ID, randomBytes, toBase64, validatePaymentToken } from '@bsv/webrtpay'
import type { PaymentTokenInput } from '@bsv/webrtpay'

// `wallet` takes the originator on every call (a WalletInterface such as a wallet-toolbox
// Wallet); a WalletClient takes it in its constructor instead, and one argument per method.

// 1. Dial and authenticate. Offline payees fail peer_unreachable within 2 s of the carrier
//    taking the knock; it also rejects unavailable (MessageBox could not take the signal:
//    this side's network), rejected
//    (error.reason 'busy', 'not_receiving' or 'wrong_network'), rate_limited, timeout, closed
//    (cancelled through `signal`) or auth_failed.
const dial = new AbortController() // abort() from the Cancel button
let peer = await client.connect(payeeKey, { signal: dial.signal })

// 2. Build the payment as PeerPay does, P2PKH to the payee's BRC-29 key for a fresh
//    derivation, and sign it without broadcasting it.
const derivationPrefix = toBase64(randomBytes(32))
const derivationSuffix = toBase64(randomBytes(32))
const { publicKey } = await wallet.getPublicKey(
  {
    protocolID: PAYMENT_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: payeeKey
  },
  originator
)
const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex()
const { tx, txid } = await wallet.createAction(
  {
    description: 'Direct payment',
    outputs: [{ satoshis: 1000, lockingScript, outputDescription: 'Payment' }],
    options: { randomizeOutputs: false, noSend: true }
  },
  originator
)
const token: PaymentTokenInput = {
  customInstructions: { derivationPrefix, derivationSuffix },
  transaction: tx!, // number[] or Uint8Array
  amount: 1000,
  outputIndex: 0
}
validatePaymentToken(token) // what the payee checks short of its own key: invalid_payment

// 3. Broadcast only while the payee is still there, then deliver and wait for its ack (45 s).
//    If it hung up meanwhile, dial again first: nothing has been broadcast, so the same token
//    still serves, and a dial that fails throws before anything goes out. The signed noSend
//    transaction then stays in the wallet, unbroadcast, holding its inputs: abandon it with
//    abortAction({ reference: txid }), or broadcast it later with sendWith and deliver the
//    token another way (MessageBox).
if (!peer.isOpen) peer = await client.connect(payeeKey)
await wallet.createAction(
  { description: 'Direct payment', options: { sendWith: [txid!] } },
  originator
)
const ack = await client.sendPayment(peer, token)
// ack.status: 'accepted' | 'received' | 'rejected' (ack.reason); the session then ends
```

Keep the token until the ack is `accepted` or `received`. If `sendPayment` fails after the
broadcast (the channel dropped, the ack timed out), or the ack is `rejected` and carries a
`txid`, the payee may hold an output it cannot find without the derivation values: deliver the
same token again, directly or through MessageBox, rather than treating the payment as failed or
paying again. The payee acknowledges a payment it already has without internalizing it twice.

`sendPayment` sends nothing, and leaves the session as it was, for a token
`validatePaymentToken` refuses (`invalid_payment`) or a transaction over
`MAX_DIRECT_TRANSACTION_BYTES` (`too_large`): 12,579,840 bytes, about 12 MiB, what fits a
payee's default 16 MiB message cap once base64-encoded. A session that has closed fails at
once with `closed`. A payee configured with a smaller cap answers an oversize payment with an
error, which `sendPayment` reports as `too_large`.

**Networks.** An identity key is the same on every network, so a mainnet payer could otherwise
reach a payee whose wallet is on testnet, broadcast, and have the payment refused. Give every
client the wallet's network (`chain: 'main'`, `'test'`, …: 1 to 16 characters from `a-z` and
`0-9`). Dials then name it: a payee refuses an offer from another network before gathering
anything, and a payer refuses an answer from another network before the channel opens. Either
way `connect` rejects with `WebRTPayError` code `rejected` and
`error.reason === 'wrong_network'` before anything is spent, so a UI can say "the recipient's
wallet is on a different network". A client without `chain` names no network and checks none;
clients with one refuse it, so set it on both sides. The constructor throws `TypeError` for any
other `chain` (`'Main'`, `'main-net'`, 17 characters), also on a client that only exchanges
codes, although a code's own network field could hold any UTF-8 name: keep to short lower-case
names such as `main` and `test`, so that codes and signals name a network the same way.

```ts
// when connect rejects with e: show "The recipient's wallet is on a different network"
const onOtherNetwork = (e: unknown): boolean =>
  e instanceof WebRTPayError && e.code === 'rejected' && e.reason === 'wrong_network'
```

### Face to face (code exchange, no server)

The payee shows an offer code; the payer scans it and shows an answer code; the payee scans
that. The payee is the offerer because an offer can wait for minutes while the answer must be
applied within about 15 s (the answerer's ICE timer), and the payee is the one scanning then.
That window starts when the payer calls `answerOfferCode`, which gathers, starts the ICE
checks toward the payee and starts the 30 s timer of `connected`: the payer reviews the offer
with `decodeCode` and confirms before answering, then shows the answer code at once. Pasting
codes through a chat app usually misses the window.

```ts
import { decodeCode } from '@bsv/webrtpay'
// showQr, scanQr and confirmWithUser stand for your UI.

// Payee: no signaler needed. `handlers` are ReceiveHandlers, as for startReceiving.
const offer = await client.createOfferCode({ amount: 1000, expiresInMs: 5 * 60_000, handlers })
showQr(offer.code)
const payerSession = await offer.complete(await scanQr()) // payerSession.peerIdentityKey

// Payer: review first, as answering starts the clock.
const text = await scanQr()
// refuses an expired code and one for another network
const preview = decodeCode(text, { expectedChain: 'main' })
if (preview.kind !== 'offer') throw new Error("Scan the payee's offer code")
if (await confirmWithUser(preview.identityKey, preview.amount)) {
  const answer = await client.answerOfferCode(text) // ICE and the connect timer start here
  showQr(answer.answerCode)
  const peer = await answer.connected // the payee proved preview.identityKey
  // prepare as in Pay; if peer.isOpen is false, broadcast nothing and start over with new
  // codes (a code exchange cannot be redialed); on giving up, answer.cancel()
  const ack = await client.sendPayment(peer, token)
}
```

An offer code carries the payee's identity key, network, optional amount and expiry and its
SDP in a compact binary form (roughly 250 characters for a typical browser offer, a QR code of
version 10 or so). An answer code carries only the session id and the SDP: the payer's
identity comes from the handshake.

A runnable version of the remote flow is [examples/demo-node.ts](examples/demo-node.ts): two
wallets in one process, a real WebRTC channel, an in-memory signaler. It uses node-datachannel,
a development dependency, so run it in [`packages/messaging/webrtpay`](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/webrtpay) of a
[ts-stack](https://github.com/bsv-blockchain/ts-stack) checkout, after `pnpm install` at the
repository root:

```sh
pnpm build && node --experimental-strip-types examples/demo-node.ts
```

## Signalers

A `Signaler` carries already-encrypted envelopes between identity keys; it never sees an SDP.

| Signaler                                             | Server                 | Use                                            |
| ---------------------------------------------------- | ---------------------- | ---------------------------------------------- |
| code exchange (`createOfferCode`, `answerOfferCode`) | none                   | in person, by QR                               |
| `MessageBoxSignaler(client, options?)`               | an existing MessageBox | remote, no new infrastructure                  |
| `RelaySignaler(options)`                             | `@bsv/webrtpay/server` | remote, low latency, can vend TURN credentials |
| `createMemoryHub().signaler(key)`                    | none (one process)     | tests and demos                                |

**`MessageBoxSignaler`** is typed structurally against the `MessageBoxClient` methods it uses
(`sendMessage`, `listMessages`, `acknowledgeMessage`, and optionally `sendLiveMessage`,
`listenForLiveMessages`, `joinRoom`, `leaveRoom`, `resolveHostForRecipient` and
`getIdentityKey`), so there is no dependency on `@bsv/message-box-client`; a `PeerPayClient`
works too. A live websocket reaches only the host it is connected to, so the signaler sends
live only to a recipient whose host (`resolveHostForRecipient`, remembered for 5 minutes) is
this client's: `host` when given, else this client's own advertised host. Everyone else, and
every live send that fails, goes over HTTP, which resolves the recipient's own host, so payer
and payee may use different servers. A live send gets 1.5 s (host lookup included) before the
HTTP send, and an HTTP `ERR_DUPLICATE_MESSAGE` after it means the live one got there. It
receives signals live as they arrive; it also polls box `webrtpay_signals` every 2.5 s (1 s while dialing), as the
safety net and the only path for clients without the websocket, and acknowledges every message
it reads, once per `messageId` whichever path brought it. When neither send path gets a signal
there, `send` rejects `unavailable` (it was `peer_unreachable` in 0.1.0). Options:
`messageBox`, `idlePollMs`, `activePollMs`, `live` (default true; false polls only), and
`host`, the MessageBox host to list, acknowledge and listen live on, and the host compared
with a recipient's for live sends.

**`RelaySignaler`** keeps one authenticated WebSocket to a relay, and only while it is needed:
while subscribed, while a send is in flight, or after `connect()`. Options: `url` (`ws:` or
`wss:`), `wallet`, `originator`, `WebSocket` (defaults to the global one), `onIceServers`,
`onStateChange`, `onCallbackError` and `random`. A throw from `onIceServers` or
`onStateChange` never reaches the connection; it goes to `onCallbackError`.

- `listen()` resolves once the connection is authenticated or the first attempt has failed. The
  subscription stays either way, and while it lasts a lost or refused connection is retried in
  the background after a random delay whose cap doubles with each failure, up to 30 s.
- `onStateChange(state, error?)` reports `connecting`, `online` and `offline`
  (`RelayConnectionState`); use it for a "receiving" indicator. When it goes `offline` because
  the connection or an attempt to open it failed, `error` is the `WebRTPayError` that ended it,
  so the app can say why: `auth_failed` when the relay expects another url (its `PUBLIC_URLS`
  does not list the one dialed), `rate_limited`, or `peer_unreachable` when the relay cannot be
  reached or dropped the connection. Going `offline` on purpose (nothing needs the connection,
  or `close()`) passes no error.
- The relay answers each frame in order; a reply that does not match ends the connection with
  `protocol` rather than being matched to a later frame.
- `requestTurn()` asks for TURN credentials, spending one of this address's credentials, and
  resolves with the full ICE server list. It rejects `rate_limited` when the relay's budget is
  spent and `unavailable` when the relay's TURN provider (Cloudflare) could not issue
  credentials just then. `iceServers()` returns the latest list without TURN entries that
  expire within 30 s, going by the `expiresAt` the relay sends with them (or, from an older
  relay, the expiry in a coturn REST username); every new connection resets it to the relay's
  STUN servers. `turnProvider()` returns the `iceServersProvider` to give a `DirectPayClient`
  (below).

Anything with `send`, `listen` and optionally `setActive` can be a signaler; see `Signaler` in
[`src/signaling/types.ts`](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/messaging/webrtpay/src/signaling/types.ts).

## ICE servers and TURN

`rtc.iceServers` (STUN and TURN servers) applies to every link; `updateRtc()` changes it for
links created later. For short-lived TURN credentials pass `iceServersProvider`, which is asked
before every ICE gather (dialing, answering an offer, creating or answering an offer code).
With a relay that issues TURN, use `RelaySignaler.turnProvider()`:

```ts
const relay = new RelaySignaler({ url: 'wss://relay.example.com', wallet, originator })
const client = new DirectPayClient({
  wallet,
  originator,
  signaler: relay,
  chain: 'main',
  rtc: { iceServers: [{ urls: 'stun:stun.example.com:3478' }] },
  iceServersProvider: relay.turnProvider(),
  onIceServersProviderError: e => console.warn('gathering without the relay TURN servers', e)
})
```

`turnProvider()` reuses the servers of the last `requestTurn()` while one of their TURN entries
has more than 30 s left, and asks the relay only otherwise; calls made while a request is in
flight share it, a failed request is not remembered, and what it keeps survives reconnects
(unlike `iceServers()`). Do not pass `() => relay.requestTurn()`: every request spends one of
this address's TURN credentials (6 an hour by default), a payee gathers for every inbound offer
it admits, and identities are free, so strangers could use up the budget by sending offers. A
relay without TURN answers with STUN only, so it is asked again on each gather (a frame, no
budget).

The provider's servers are merged with `rtc.iceServers`; an entry with the same set of urls is
replaced by the provider's. A provider that throws, rejects, returns something other than an
array or takes more than 5 s is passed over and the gather uses `rtc.iceServers` alone, so a
dial never fails because of it. `onIceServersProviderError` is told why each time: what the
provider threw or rejected with (`rate_limited` once the relay's budget is spent,
`unavailable` when the relay's TURN provider failed), a `TypeError` for a result that is not
an array, or a `timeout` `WebRTPayError` after 5 s.

**Node with node-datachannel.** Its polyfill hands each TURN server to libdatachannel as a
`turn:<username>:<credential>@host` url, which cuts a REST username (`<expiry>:<pseudonym>`)
at its colon, so coturn refuses relay-issued credentials and relayed connections fail without
an error. (Cloudflare's usernames have no colon, but libdatachannel's ICE library uses at most
two TURN servers, over UDP only.) Give libdatachannel TURN servers as native `IceServer`
objects instead, through the polyfill's `peerConnection` option (this is what the repository's
TURN tests run):

```ts
import { PeerConnection } from 'node-datachannel'
import type { IceServer, RtcConfig } from 'node-datachannel'
import { RTCPeerConnection as Polyfill } from 'node-datachannel/polyfill'

let made = 0
class TurnRTCPeerConnection extends Polyfill {
  constructor(config: RTCConfiguration & { bindAddress?: string } = {}) {
    const native: RtcConfig = { iceServers: (config.iceServers ?? []).flatMap(nativeIceServers) }
    if (config.bindAddress !== undefined) native.bindAddress = config.bindAddress
    if (config.iceTransportPolicy !== undefined) {
      native.iceTransportPolicy = config.iceTransportPolicy
    }
    super({ ...config, peerConnection: new PeerConnection(`webrtpay-${++made}`, native) })
  }
}

/** `server`'s urls for libdatachannel: TURN as native IceServer objects, others as they are. */
function nativeIceServers(server: RTCIceServer): Array<string | IceServer> {
  const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
  return urls.map(url => {
    const turn = /^(turns?):([^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url)
    if (turn === null) return url
    const [, scheme, hostname, port, transport] = turn
    const tls = scheme.toLowerCase() === 'turns'
    return {
      hostname,
      port: port === undefined ? (tls ? 5349 : 3478) : Number(port),
      username: server.username,
      password: server.credential,
      relayType: tls ? 'TurnTls' : transport?.toLowerCase() === 'tcp' ? 'TurnTcp' : 'TurnUdp'
    }
  })
}

const client = new DirectPayClient({
  wallet,
  signaler: relay,
  rtc: { RTCPeerConnection: TurnRTCPeerConnection as unknown as typeof RTCPeerConnection },
  iceServersProvider: relay.turnProvider()
})
```

## Security model

- **Identity bound to the channel.** After the data channel opens, each side sends `hello`
  (identity key, fresh 32-byte nonce), then `auth`: a signature under protocol
  `[2, 'webrtpay channel']` over a transcript of both sides' DTLS fingerprints, both nonces and
  both keys. A man in the middle has to terminate DTLS separately with each side, so each sees
  a different remote fingerprint and neither signature verifies; the session closes before any
  payment byte is sent. Each side then raises its message cap from 64 KiB to the full size and
  sends `ready`; nothing else may be sent before both `ready`s. Fingerprint verification is
  never disabled.
- **Pinned peers.** The payer pins the identity it means to pay (the dialed key, or the key in
  the offer code); any other key closes the session. The payee learns the payer from the
  handshake, as MessageBox gives it the authenticated sender.
- **Funds safety does not depend on any of that.** The payee accepts a payment only if output
  `outputIndex` is P2PKH to its own key derived with `[2, '3241645161d8']`, keyID
  `"<prefix> <suffix>"`, counterparty the payer, and carries exactly the stated amount.
- **Encrypted signaling.** Offers, answers and rejects are BRC-2 encrypted under
  `[2, 'webrtpay signaling']` to the recipient, must name the carrier's sender and recipient,
  must be within ±120 s, and each session id is accepted once. A carrier sees only
  `{ v, sid, ciphertext }`.
- **Hostile input.** Frames, codes, envelopes and messages are parsed with fixed bounds (frame
  and message caps, JSON depth 32 and 4096 structural tokens before `JSON.parse`, strict
  base64/hex/UTF-8, unknown fields dropped). A violation closes the session with an error code;
  nothing throws out of the client.
- **Connect first, then pay; deliver idempotently.** The payer spends only after the payee has
  authenticated. `acceptDirectPayment` records each payment it internalizes
  (`txid:outputIndex:prefix:suffix`) in the `seen` store it is given and reports a re-delivery
  as `duplicate` without a second `internalizeAction`; the client decides concurrent deliveries
  of one payment once.

## Security and privacy

Read this before enabling receiving for users.

- **What carriers learn.** The MessageBox host or relay, and Cloudflare or any proxy that
  terminates TLS in front of them, see both identity keys, both IP addresses, the timing and
  the size of every knock, ring, offer, answer and reject. MessageBox stores each encrypted signal until it
  is acknowledged (the signaler acknowledges as soon as it reads); a receiving wallet polls it
  every 2.5 s, which shows when it is online. Carriers never see the payment.
- **Receiving reveals your IP address and online status.** While receiving is on, any wallet
  that knows your identity key can send an offer and get an answer containing your public IP
  address, and learn that your wallet is online, without paying you. The inbound limits bound
  the load, not this disclosure (offers refused by the limits gather no addresses). Make
  receiving opt-in; BSV Desktop has it off by default.
- **Dialing reveals the payer's IP address to the payee**, and both codes in a face-to-face
  exchange show the sender's candidate addresses to anyone who can read the QR code. Browsers
  hide LAN addresses behind mDNS names; Electron apps must allow that (BSV Desktop installs a
  permission check handler); Node does not hide them. The STUN and TURN servers you configure
  see the address of each side that gathers.
- **The relay is a presence oracle.** Its `offline` reply tells any authenticated key whether
  another identity is connected right now. It is a known trade-off, kept so that a dial to a
  payee who is not listening fails at once instead of after 30 s; `RelaySignaler` holds a
  socket only while receiving or dialing, so the oracle shows exactly that. A client that is
  dialing but not receiving answers offers with `not_receiving`, which also shows it is online.
- **A ring is a presence reply.** Any wallet that knows a receiving payee's identity key can
  knock and learn from the `ring` that it is online, without its IP address (no ICE is
  gathered for a knock). Rings are capped at 20 a second, and knocks count against the intake
  budgets like offers.
- **The protocol IDs are ordinary BRC-43 protocols.** `[2, 'webrtpay channel']`,
  `[2, 'webrtpay signaling']` and `[2, 'webrtpay relay']` can be used by any originator the
  wallet allows. The channel binding therefore proves "an originator with signing permission
  for `[2, 'webrtpay channel']` (for this counterparty) on this key's wallet controls the
  endpoint". Wallets should prompt other originators before signing under
  `[2, 'webrtpay channel']`, and a wallet that answers automatically should use its own admin
  originator.
- **TURN.** The TURN service sees the address of each side that relays through it, the ports
  and the timing, never the payment (DTLS-encrypted end to end). Relay-issued coturn usernames
  are pseudonyms (`<expiry>:<HMAC of the identity key>`), but they travel in the clear on
  `turn:` urls: do not run coturn verbose or with its Redis stats database, which log them.
  With Cloudflare the usernames are random and the relay never sends Cloudflare the identity
  key. See [TURN options](#turn-options).
- **Known limitation: free identities can keep direct receive busy.** A few throwaway keys can
  each dial, complete the handshake and send any message (one the payee ignores) within the
  first-message window, then one a minute, holding every inbound slot. `maxSessionMs` (120 s)
  ends each session, but redialing within the per-sender offer limits takes the slot again, so
  genuine payers get `busy` or no answer for as long as it goes on. Nothing is spent, and
  MessageBox remains the fallback; reserving a slot for known counterparties is possible future
  work.

## Relay server

`@bsv/webrtpay/server` is a stateless WebSocket rendezvous: it authenticates sockets by
identity key, forwards envelopes between them, and can issue ephemeral TURN credentials, from
Cloudflare Realtime TURN or for a coturn server (see [TURN options](#turn-options)). It stores
nothing and never logs payloads or secrets.

```sh
PUBLIC_URLS=wss://relay.example.com TRUSTED_IP_HEADER=cf-connecting-ip \
TURN_PROVIDER=cloudflare CLOUDFLARE_TURN_KEY_ID=… CLOUDFLARE_TURN_API_TOKEN=… \
npx --package @bsv/webrtpay webrtpay-relay
```

Set `TRUSTED_IP_HEADER` only when the listener can be reached solely through the proxy that sets
it: keep it private (a ClusterIP Service behind the tunnel, a loopback or cluster-internal
address, a firewall or the proxy's own allow-list). A client that can reach the relay directly
can send any value and choose its own per-source limits.

| Variable                           | Default                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                             | `8787`                             | Port to listen on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `HOST`                             | `0.0.0.0`                          | Address to listen on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PUBLIC_URLS`                      | —                                  | Comma-separated `wss://` urls clients dial; clients sign the one they use. **Required in production**: the relay refuses to start without it unless `HOST` is a loopback address, because otherwise clients sign a url built from the `Host` header, which the client chooses. Set it whenever a proxy fronts the relay, even on loopback.                                                                                                                                                                                                          |
| `TRUSTED_IP_HEADER`                | —                                  | Header the outermost proxy sets to the client's single address, for the per-source limits: `cf-connecting-ip` behind Cloudflare. Without it every client behind a proxy shares the proxy's limits. `x-forwarded-for` is right only behind exactly one proxy that overwrites it. Set it only when every connection reaches the relay through that proxy (firewall it, or keep the listener private, e.g. a ClusterIP Service behind the tunnel); a client that can reach the relay directly can send any value and choose its own per-source limits. |
| `STUN_URLS`                        | —                                  | Comma-separated STUN urls handed to every authenticated socket.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TURN_PROVIDER`                    | — (coturn when TURN_SECRET is set) | Where TURN credentials come from: `coturn` (REST credentials the relay mints; what runs when `TURN_SECRET` is set and this is not) or `cloudflare` (Cloudflare Realtime TURN). Without it and without `TURN_SECRET` the relay issues no TURN. Enable `cloudflare` only once every client is on a package version that reads `ice.expiresAt` (see [TURN options](#turn-options)).                                                                                                                                                                    |
| `TURN_SECRET`                      | —                                  | coturn `static-auth-secret`; requires `TURN_URLS`. Refused with `TURN_PROVIDER=cloudflare`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TURN_URLS`                        | —                                  | Comma-separated TURN urls to issue credentials for; requires `TURN_SECRET`. Refused with `TURN_PROVIDER=cloudflare`, which chooses its own.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CLOUDFLARE_TURN_KEY_ID`           | —                                  | The Cloudflare TURN key's id; requires `TURN_PROVIDER=cloudflare` and `CLOUDFLARE_TURN_API_TOKEN`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CLOUDFLARE_TURN_API_TOKEN`        | —                                  | The TURN key's API token (a secret: never logged); requires `TURN_PROVIDER=cloudflare` and `CLOUDFLARE_TURN_KEY_ID`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `TURN_TTL`                         | `600`                              | Lifetime of issued TURN credentials, in seconds; Cloudflare caps it at 172800 (48 hours).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `TURN_PER_IP_PER_HOUR`             | `6`                                | TURN credential sets one source address may get per hour; requires a TURN provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TURN_PER_48_PER_HOUR`             | `24`                               | The same for all the IPv6 sources of one /48 together; requires a TURN provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TURN_PER_HOUR`                    | `600`                              | TURN credential sets the relay issues per hour in total; requires a TURN provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SOCKETS_PER_IP`                   | `20`                               | Sockets one source address may hold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CONNECTIONS_PER_IP_PER_MINUTE`    | `30`                               | New connections one source address may open a minute.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SOCKETS_PER_48`                   | `80`                               | Sockets all the IPv6 sources of one /48 may hold together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CONNECTIONS_PER_48_PER_MINUTE`    | `120`                              | New connections all the IPv6 sources of one /48 may open a minute.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MAX_SOCKETS`                      | `10000`                            | Sockets the relay holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MAX_UNAUTHENTICATED_SOCKETS`      | `1000`                             | Sockets not yet authenticated the relay holds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SIGNALS_PER_PAIR_PER_MINUTE`      | `6`                                | Signals all the identities behind one source address (an IPv4 address or an IPv6 /64) may send one recipient a minute, together.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SIGNALS_PER_RECIPIENT_PER_MINUTE` | `120`                              | Signals one recipient may receive a minute from all senders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MAX_OVER_RATE_FRAMES`             | `20`                               | Frames over the socket rate answered in a row before the socket is closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

- `GET /health` answers `{"status":"ok"}`. `SIGTERM` or `SIGINT` closes every socket and exits.
- At startup it logs `TURN credentials from <provider>, valid <ttl> s`, naming the provider by
  its `kind` in code: `coturn-rest` for `TURN_PROVIDER=coturn`, or `cloudflare`. It warns when
  there are no public urls (development only) and when `PUBLIC_URLS` is set without
  `TRUSTED_IP_HEADER`.
  It refuses to start with a half-configured or mixed TURN provider (`TURN_URLS` without
  `TURN_SECRET`, `TURN_PROVIDER=cloudflare` without both Cloudflare variables or with
  `TURN_SECRET`, Cloudflare variables without `TURN_PROVIDER=cloudflare`) rather than run
  without TURN.
- Connections are admitted per source address before the WebSocket upgrade: more than 20
  sockets or 30 new connections a minute from one source get `HTTP 429`; more than 10000
  sockets, or 1000 not yet authenticated, get `HTTP 503`. IPv6 counts by its /64 and also by its
  /48, at 4 times those limits (80 sockets, 120 connections a minute), since a free
  tunnel-broker /48 holds 65,536 /64s; an organisation that shares one /48 shares its budget
  too. Every user behind one carrier-grade NAT address shares that address's limits; raise them
  with the variables above when many of your users do.
- A socket may send 20 frames per 10 s, WebSocket pings included. Each frame over that is
  answered `rate_limited` (pings get no pong) until 20 have come in a row; the next closes the
  socket with 1008, so a client that floods, reading the replies or not, is cut off.
- An identity may hold 5 sockets and receive 120 signals a minute from all senders together,
  6 a minute from any one source address (its /64 for IPv6), however many identities connect
  from it. A sender over its address's share gets `rate_limited`; when the total is spent the
  sender gets `offline`, as if the recipient were not connected. Identities are free and
  addresses are not, so the share is per address: fresh identities from one address share it.
  Every user behind one carrier-grade NAT address therefore shares 6 signals a minute toward
  one recipient; raise `SIGNALS_PER_PAIR_PER_MINUTE` when many of your users do.
- An envelope may be up to 24672 bytes, the largest a signal can produce (a 16384-character
  SDP fits).
- TURN credentials are issued only on request (`{ t: 'turn' }`), at most 6 an hour per source
  address (`TURN_PER_IP_PER_HOUR`) and 600 an hour in total, valid for `TURN_TTL`, whichever
  the provider. The budget is spent before the provider is asked, so a request Cloudflare fails
  costs one too. The answer lists the relay's `STUN_URLS`, then the provider's servers, with
  `expiresAt`. A provider that fails (Cloudflare answers an error, nothing within 5 s, or more
  than 64 KiB) gets the client `{ t: 'error', code: 'unavailable' }` and one log line naming
  what failed, never the token or credentials. Other frames from that socket are still
  forwarded at once, and their replies follow the TURN reply in order.
- coturn REST: the username is `<expiry>:<pseudonym>`
  (`credential = base64(HMAC-SHA1(secret, username))`), so coturn needs `use-auth-secret`.
  Identities are free, so in production also give coturn its own quotas (`--total-quota`,
  `--max-bps`, `--denied-peer-ip` for private ranges); `--user-quota` alone does not stop
  fresh keys.

In code, `createRelayServer(options)` takes the same settings (`port`, `host`, `publicUrls`,
`trustedIpHeader`, `stunUrls`, `turn` as `{ kind: 'coturn-rest', secret, urls, ttlSeconds }`
or `{ kind: 'cloudflare', keyId, apiToken, ttlSeconds, fetch }`, and `limits` for the limit
variables, e.g. `limits: { turnPerIpPerHour }` for `TURN_PER_IP_PER_HOUR`) plus `server`
(attach to an existing HTTP server), `path`, the other `limits` (see `DEFAULT_RELAY_LIMITS`),
`log` and, for development only, `trustHostHeader`. It resolves to `{ url, port, close(), stats() }`.
`webrtpay-relay --help` lists the variables with their defaults.

## TURN options

Most connections need no TURN; it carries the (encrypted) payment only when neither side can
reach the other directly, as on many mobile networks. The relay issues short-lived credentials
for one of two providers.

**Cloudflare Realtime TURN (`TURN_PROVIDER=cloudflare`; recommended for production, and must be
set explicitly).**

- Rollout: enable `TURN_PROVIDER=cloudflare` only after every client is on a package version
  that reads `ice.expiresAt` (this version on). Older clients work out when TURN credentials
  expire from the `<expiry>:<pseudonym>` username of coturn REST credentials, and treat
  Cloudflare's opaque usernames as never expiring.
- Setup: create a TURN key in the Cloudflare dashboard, or with
  `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/calls/turn_keys` and an API
  token with Calls Write permission. The key has an id (`uid`) and an API token (`key`); give
  them to the relay as `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`, from a secret
  store. Use one key per environment.
- For each `turn` request the relay calls
  `POST https://rtc.live.cloudflare.com/v1/turn/keys/<key id>/credentials/generate-ice-servers`
  with `{ "ttl": TURN_TTL }`. It passes on Cloudflare's STUN url and its TURN urls (UDP 3478
  and 443, TCP 3478 and 80, TLS 5349 and 443, anycast to the nearest Cloudflare location),
  picked by scheme rather than by position because the answer's shape has changed before, and
  drops any url on port 53, which browsers block. It reads at most 64 KiB of the answer and
  forwards at most 8 TURN urls (the first listed; Cloudflare lists 6). Cloudflare's answer
  does not say when the credentials expire, so the relay sends `expiresAt` (request time +
  ttl). The log line for a failed request says what failed in a few words (`HTTP 503`,
  `no answer within 5 s`, `request failed (ECONNREFUSED)`), never the url or the token.
- Cost: TURN is billed at $0.05 per GB sent from Cloudflare to TURN clients, after the first
  1,000 GB a month, which are free and shared with Cloudflare's Realtime SFU; STUN is free. A
  direct payment is about 100 KB, so even with every session relayed, 1,000 sessions a day
  stay far inside the free tier.
- Privacy: Cloudflare sees each relayed client's IP address, ports and timing, never the
  payment (DTLS end to end), and never the identity key (the usernames are random). There is
  no data-localization guarantee: Realtime TURN is not covered by Cloudflare's Data
  Localization Suite, and an allocation is made at the client's nearest location.
- Risks: Cloudflare's budget alerts are e-mail only and informational; nothing caps the spend
  except the relay's own issuance limits (6 an hour per address, 600 an hour in total by
  default) and the short ttl, so set a budget alert anyway. It is a third-party dependency
  (maintenance can drop allocations; clients recover by connecting again), relays IPv4 only,
  and refuses private and loopback peers. Credentials can be revoked through Cloudflare's API
  (the relay does not do this itself).

**Self-hosted coturn (`TURN_PROVIDER=coturn`, with `TURN_SECRET` and `TURN_URLS`).** The relay
mints coturn REST credentials with the shared secret; nothing is asked of a third party, and
only you see the addresses. It is what the [local stack](#running-the-local-stunturn-stack)
runs. In production coturn needs:

- a public address it can send from as well as receive on: `external-ip` set to it, every relay
  port reachable on that address with the same port number, and its own first packets leaving
  from it. A load balancer only answers flows that clients start, so coturn behind one, with
  egress through a NAT gateway, fails whenever coturn has to send first; give it a host or
  node with its own public IP and host networking instead;
- a relay port range wide enough for the expected sessions (an allocation lives 10 minutes
  after a client vanishes), UDP 3478 plus TCP 3478 and TLS 5349 or 443 for networks that block
  UDP;
- `denied-peer-ip` for private, loopback, link-local, IPv4-mapped IPv6 and NAT64 ranges, with
  `allowed-peer-ip` for its own address so that two relayed peers on the same coturn can reach
  each other, plus `--total-quota`, `--max-bps` and `--bps-capacity`;
- a current release (4.18.0 removed `--no-dtls`) and secret rotation as the only way to cut
  off issued credentials, which cannot be revoked.

## Running the local STUN/TURN stack

`docker/` runs coturn (STUN and TURN with REST credentials) for development and the TURN tests;
the relay runs on the host from the build, in a second terminal:

```sh
docker compose -f docker/docker-compose.yml up -d
pnpm build && HOST=127.0.0.1 STUN_URLS=stun:127.0.0.1:3478 TURN_SECRET=webrtpay-dev-secret \
  TURN_URLS=turn:127.0.0.1:3478 TURN_PER_IP_PER_HOUR=600 node dist/server/cli.js
pnpm test:turn    # in the first terminal
docker compose -f docker/docker-compose.yml down
```

- coturn 4.18.0 listens on `127.0.0.1:3478` (UDP and TCP) with relay ports 49160–49200; the
  relay on `ws://127.0.0.1:8787` hands out `stun:127.0.0.1:3478` and credentials for
  `turn:127.0.0.1:3478`. Everything listens on 127.0.0.1 only. The secret
  `webrtpay-dev-secret` is public: never deploy this stack.
- coturn has a fixed address, 172.30.78.10 on subnet 172.30.78.0/24; if that clashes with a
  network on your machine, change it in `docker-compose.yml` (two places) and `turnserver.conf`.
- `external-ip=127.0.0.1/172.30.78.10` has a private half on purpose. coturn maps a peer address
  equal to its advertised address back to its relay address; with a bare `external-ip` and a
  `0.0.0.0` listener that relay address is `0.0.0.0` and coturn refuses every peer with
  `403 Forbidden IP`. `allowed-peer-ip=172.30.78.10` is a development-only exception to the
  private-range deny list.
- `pnpm test:turn` runs the normal suite plus `test/turn.test.ts`: two relay-only peers,
  a full payment over TURN with `RelaySignaler.turnProvider()` as `iceServersProvider`, and the
  dev relay's credentials against the compose coturn. That last test spends one credential of
  the dev relay, where every client arrives from 127.0.0.1; the command above therefore sets
  `TURN_PER_IP_PER_HOUR=600` (the relay's total) instead of the default 6, so the suite can be
  run again and again (restarting the relay starts over).
- coturn's 41 relay ports are the other limit: a run holds 5 allocations, which outlive it
  until their lifetime runs out, so about 8 runs in a row fill them. The TURN tests then time
  out and coturn logs `create_relay_ioa_sockets: no available ports`; run
  `docker compose -f docker/docker-compose.yml restart coturn` to free them.
- The TURN tests give node-datachannel its TURN servers as native `IceServer` objects (see
  [ICE servers and TURN](#ice-servers-and-turn)), since its polyfill cuts a REST username at
  its colon.

## React Native

Inject the platform's peer connection:

```ts
import { RTCPeerConnection } from 'react-native-webrtc'

const client = new DirectPayClient({
  wallet,
  signaler,
  rtc: { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection }
})
```

The root entry also needs `TextEncoder`, `TextDecoder` with `{ fatal: true }`,
`crypto.getRandomValues` (for example from `react-native-get-random-values`) and
`queueMicrotask`, and uses `performance.now()` when there is one; `RelaySignaler` uses the
global `WebSocket` unless given one. For the type declarations, add `"DOM"` to `lib` (see
[Install](#install)). It uses no
Node builtins, `Buffer` or `process`, and imports nothing outside `src/`
(`test/browser-safety.test.ts` enforces this). It has not been run on React Native.

## Development

The package lives in [`packages/messaging/webrtpay`](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/webrtpay) of
[ts-stack](https://github.com/bsv-blockchain/ts-stack), whose
[CONTRIBUTING.md](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md) applies.
After `pnpm install` at the repository root, from the package directory:

| Command              | What                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| `pnpm build`         | Compile `src/` and `server/` to `dist/` (`dist/src/index.js`, `dist/server/cli.js`). |
| `pnpm test`          | All tests (jest, ESM); the TURN suite is skipped.                                    |
| `pnpm test:coverage` | The same with coverage and its thresholds.                                           |
| `pnpm test:property` | The fast-check property suites only.                                                 |
| `pnpm test:turn`     | Also the TURN suite (needs the local STUN/TURN stack).                               |
| `pnpm typecheck`     | `tsc --noEmit` over `src/`, `server/`, `test/` and `examples/`.                      |
| `pnpm lint`          | Oxlint over `src/`, `server/`, `test/` and `examples/`, warnings denied.             |
| `pnpm format:check`  | Prettier with the repository's configuration.                                        |
| `pnpm test:browser`  | Bundles the packed root entry for browsers, within `browser-budget.json`.            |
| `pnpm pack:check`    | Checks the packed tarball, its exports and the `webrtpay-relay` executable.          |

Node tests run real WebRTC with node-datachannel bound to `127.0.0.1`.

## Verification

What the test suite exercises (`pnpm test`: 768 tests at 0.1.0, 914 at 0.2.0; `pnpm test:turn` adds 3 TURN
tests):

- codes, compact SDP, frames: unit tests plus fast-check property suites with hostile input
  (truncation, oversized and out-of-order frames, JSON depth and width bombs);
- the identity handshake with real keys (`ProtoWallet`) over real node-datachannel loopback
  connections: swapped fingerprints, a relay forwarding the handshake between two links, wrong
  keys, an echoed nonce, messages before authentication, the published transcript test vector;
- full payments between two `DirectPayClient`s over loopback WebRTC, through the in-memory hub
  and through a real relay over `ws`, and by code exchange: a 2 MiB transaction, acks, the
  payee dropping mid-payment, duplicate and concurrent delivery, offline and refusing payees,
  inbound limits and intake budgets, timeouts;
- the relay: authentication and URL binding, limits, TURN issuance from coturn REST and from
  Cloudflare (against a mocked API: both answer shapes, failures, the 5 s timeout, no secret in
  frames or logs), admission, liveness;
- `MessageBoxSignaler` against a fake MessageBox client, live websocket paths included;
- presence: knocks and rings, the 2 s presence and 6 s dial clocks, and per-dial cancel;
- the relayed path through a real coturn 4.18.0 in Docker (`pnpm test:turn`);
- the examples in `docs/protocol.md`, recomputed from the code (`test/protocol-doc.test.ts`);
- guards: nothing under `src/` uses Node (`test/browser-safety.test.ts`), no public IP address
  is published in tests or docs (`test/ip-literals.test.ts`), and the files the README links
  to are in the package (`test/package-files.test.ts`);
- type-level interop: `PaymentToken` and `IncomingPayment` against `@bsv/sdk`'s
  `CreateActionResult` and `@bsv/message-box-client`'s types (the workspace packages), both
  ways (`test/types.test.ts`, checked by `pnpm typecheck`).

The demo, `examples/demo-node.ts`, is not part of `pnpm test`; run by hand, it pays through the
built package and prints an `accepted` ack.

Not verified:

- any browser end to end: no Chromium, Firefox or Safari peer connected to another peer in
  these tests. A research prototype of the compact SDP was accepted by Chromium as both offer
  and answer; whether Chromium accepts the rebuilt `raddr ::` for IPv6 candidates is unchecked;
- React Native;
- real networks: the test sandbox drops UDP to non-loopback addresses, so NAT traversal and
  Electron-to-Electron across networks are untested;
- TURN in production: only the local coturn; no test calls Cloudflare's API or relays through
  Cloudflare. A real MessageBox server is untested too;
- real BRC-100 wallets other than `ProtoWallet` (`internalizeAction` is mocked in the tests).

## License

Open BSV License Version 6; see [LICENSE.txt](LICENSE.txt).
