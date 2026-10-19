---
id: pkg-webrtpay
title: '@bsv/webrtpay'
kind: package
domain: messaging
version: '0.2.0'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-10-18'
last_verified: '2026-10-18'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/webrtpay'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/webrtpay'
status: experimental
tags: [messaging, webrtc, payments, brc-29, brc-100]
---

# @bsv/webrtpay

> Direct wallet-to-wallet BSV payments over WebRTC data channels, authenticated with BRC-100
> identity keys.

The payer hands the payee the same BRC-29 `PaymentToken` that PeerPay sends through
MessageBox, but over an encrypted peer-to-peer data channel: no server stores the payment or
can read it. Both sides prove their identity key bound to the DTLS session, so whoever carries
the signaling cannot read, change or redirect a payment. The payer connects before it creates
the transaction, so an unreachable payee costs nothing.

The 0.2.0 source candidate is experimental and declares SDK peer `^2.8.6 || ^3.0.0`. The
byte-level protocol is specified in the package's
[docs/protocol.md](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/messaging/webrtpay/docs/protocol.md).

## Install

```bash
npm install @bsv/webrtpay @bsv/sdk
```

`@bsv/sdk` is a required peer. The package is ESM only and needs Node.js 22 or newer, or a
browser. Browsers supply `RTCPeerConnection`; in Node inject an implementation such as
`node-datachannel/polyfill`, and in React Native `react-native-webrtc`.

## Quick start

```ts
import { DirectPayClient, MessageBoxSignaler } from '@bsv/webrtpay'

const client = new DirectPayClient({
  wallet, // a BRC-100 wallet
  originator: 'wallet.example.com',
  signaler: new MessageBoxSignaler(messageBoxClient), // a @bsv/message-box-client client
  rtc: { iceServers: [{ urls: 'stun:stun.example.com:3478' }] },
  chain: 'main'
})

// Payer: dial and authenticate first, then build, broadcast and deliver the payment. An
// offline payee fails peer_unreachable within 2 s; `signal` cancels just this dial.
const peer = await client.connect(payeeIdentityKey, { signal: cancel.signal })
const ack = await client.sendPayment(peer, token) // ack.status: 'accepted' | 'received' | 'rejected'
```

The payee calls `client.startReceiving({ onPayment })` and verifies each payment with
`verifyDirectPayment` before internalizing it with `acceptDirectPayment`. The package
[README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/webrtpay#readme)
has the complete payer and payee flows, including how to sign without broadcasting, broadcast
only while the payee is still connected, and deliver a token again after a lost acknowledgment.

## What it provides

- `DirectPayClient`: dial, authenticate and pay a payee by identity key, receive payments within
  inbound session and rate limits, and refuse offers from another network before anything is
  spent. A dial knocks first and the payee rings back before any ICE is gathered: an offline
  payee is known within `presenceTimeoutMs` (2 s), an online one has `dialTimeoutMs` (6 s) from
  its reply to connect, and an `AbortSignal` cancels one dial
- face-to-face code exchange: `createOfferCode` and `answerOfferCode` produce compact
  `webrtpay1:` offer and answer codes for QR display, with no server involved
- signalers: `MessageBoxSignaler` over an existing MessageBox (live websocket when the client
  has one, polling as the fallback; a signal MessageBox cannot take fails `unavailable`),
  `RelaySignaler` over the package's
  relay (which can also issue TURN credentials), and `createMemoryHub` for tests and demos
- `PeerLink` and `authenticate`: the data channel with bounded framing, and the handshake that
  binds both identity keys to the DTLS fingerprints
- `verifyDirectPayment`, `acceptDirectPayment` and `validatePaymentToken`: BRC-29 payment checks
  and idempotent internalization against a caller-supplied seen store
- `@bsv/webrtpay/server` (Node only): `createRelayServer`, `turnCredentials` and the
  `webrtpay-relay` CLI, a stateless WebSocket rendezvous that authenticates sockets by identity
  key and forwards encrypted envelopes; `webrtpay-relay --help` lists its settings
- TURN credentials from the relay: short-lived credentials minted from a coturn
  `use-auth-secret` shared secret (`CoturnRestTurnProvider`, with a per-identity pseudonymous
  username) or requested from Cloudflare's managed TURN service (`CloudflareTurnProvider`,
  random credentials per request; Cloudflare never receives the identity key); the relay sends
  their expiry with them, and `RelaySignaler.turnProvider()` reuses them until they are within
  30 seconds of it

## Security

- **Identity bound to the channel.** Each side signs a transcript of both DTLS fingerprints,
  both nonces and both keys under `[2, 'webrtpay channel']`. A man in the middle terminates DTLS
  separately with each side, so neither signature verifies and the session closes before any
  payment byte is sent. Fingerprint verification is never disabled.
- **Funds safety does not depend on the channel.** The payee accepts a payment only if the
  stated output pays its own BRC-29-derived key for the authenticated payer with exactly the
  stated amount.
- **Encrypted signaling.** Knocks, rings, offers, answers and rejects are BRC-2 encrypted to the recipient and
  accepted once per session id; a carrier sees only ciphertext, but can drop signals.
- **Hostile input.** Codes, SDPs, frames, envelopes and messages are parsed with fixed size,
  depth and token bounds; a violation closes the session with an error code. Property tests
  cover the code, compact-SDP and frame decoders.
- **Privacy.** Receiving reveals the payee's IP address and online status to any wallet that
  knows its identity key, and dialing reveals the payer's address to the payee. Make receiving
  opt-in. The README's "Security and privacy" section lists what carriers, relays and TURN
  servers learn.

## Distribution and verification

The package publishes ESM and declarations for the browser-safe root entry and the Node-only
`./server` subpath. Exact-tarball validation checks both entries and the `webrtpay-relay` bin,
and the browser gate bundles the root entry with Vite and esbuild within a size budget and
rejects Node builtins and `ws` in the browser graph.

## Related

- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/webrtpay#readme)
- [Protocol specification](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/messaging/webrtpay/docs/protocol.md)
- [@bsv/message-box-client](./message-box-client.md)
- [Peer-to-peer messaging guide](../../guides/peer-to-peer-messaging.md)
- [npm](https://www.npmjs.com/package/@bsv/webrtpay)
