---
id: pkg-air-gap
title: '@bsv/air-gap'
kind: package
domain: helpers
version: '0.1.1'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-07-30'
last_verified: '2026-07-30'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/air-gap'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/air-gap'
status: experimental
tags: [helpers, air-gap, qr, optical, transport]
---

# @bsv/air-gap

> One-directional optical air-gap transport for arbitrary bytes — the reference implementation of the experimental BRC-141 wire protocol: fountain-coded QR parts that survive missed camera frames with no back-channel, zero runtime dependencies, session locking against stray frames, and CRC32 payload integrity.

## Install

```bash
npm install @bsv/air-gap
```

No peer dependencies. Browsers and Node.js 22 or newer.

## Quick start

```typescript
import { AirGapDecoder, AirGapEncoder } from '@bsv/air-gap'

// Sender: display parts. The application owns the sequence number and cadence.
const encoder = new AirGapEncoder(payloadBytes)
const cycle = encoder.blockCount * 64
let seq = 0
setInterval(() => {
  renderQrCode(encoder.partAt(seq))
  seq = (seq + 1) % cycle // loop — the repeating systematic prefix guarantees recovery
}, 200)

// Receiver: feed every scan in.
const decoder = new AirGapDecoder()
onBarcodeScan(text => {
  const { ok, done, have, total } = decoder.accept(text)
  if (ok) showProgress(have, total)
  if (!done) return
  const payload = decoder.message() // verified bytes, or null
  if (payload) finish(payload)
})
```

## What it provides

- **AirGapEncoder** — Splits a message into `K` source blocks and renders part `seq` as a wire string; pure function of `(message, blockBytes, sessionId, seq)`
- **AirGapDecoder** — Accepts scanned strings, peels fountain parts, and emits the CRC-verified payload
- **Systematic prefix** — The first `K` parts are the source blocks verbatim, so one clean camera cycle decodes with zero overhead
- **Loss tolerance** — Later parts are interchangeable XOR mixes; with high probability `K + ε` distinct parts reconstruct the message, and a looping sender makes recovery certain
- **Camera safety** — `accept` never throws, never emits partial or unverified bytes, and rejects oversize strings before doing any work
- **Session locking** — An 8-byte session identity names each stream; one stray frame from another sender is rejected, and only three consecutive foreign parts switch the decoder
- **Hostile-input bounds** — Duplicate tracking and mix buffering are hard-capped, so a broken or malicious sender cannot exhaust decoder memory
- **Zero runtime dependencies** — No `@bsv/sdk`, no polyfills beyond `btoa` / `atob` / `crypto.getRandomValues`

## Runtime and package compatibility

The package root provides matching typed entry points for Node.js ESM and
CommonJS consumers, and the published tarball is additionally verified as a
browser artifact: exact-tarball bundling with Vite and esbuild against a
governed size budget (`browser-budget.json`), plus `publint`, strict
`@arethetypeswrong/core` resolution, and clean installs that import and
require every public export. Node.js 22 or newer, evergreen browsers.

## Common patterns

### Animate a multi-part message

```typescript
const encoder = new AirGapEncoder(payload, { blockBytes: 1200 })
const cycle = encoder.blockCount * 64
let seq = 0
const timer = setInterval(() => renderQrCode(encoder.partAt(seq++ % cycle)), 200)
// Loop until the receiver signals success out-of-band; seq is a finite u32,
// and re-running the systematic prefix is what makes recovery deterministic.
```

### Display a single-part message statically

```typescript
const encoder = new AirGapEncoder(shortPayload)
if (encoder.blockCount === 1) renderQrCode(encoder.partAt(0)) // no animation needed
```

### Route camera reads cheaply

```typescript
import { isAirGapPart } from '@bsv/air-gap'

onBarcodeScan(text => {
  if (!isAirGapPart(text)) return handleOtherQr(text)
  decoder.accept(text)
})
```

### Size a part against a QR version

```typescript
import { estimatePartCharLength } from '@bsv/air-gap'

estimatePartCharLength(1200) // 1639 characters, exactly
// Compare against BYTE-mode QR capacity (base64url rules out alphanumeric
// mode): version 40 holds 2953 bytes at EC L, 1663 at EC Q.
```

### Abandon a scan

```typescript
onCancel(() => decoder.reset())
```

## Key concepts

- **Fountain coding** — Luby-transform parts with an exact-integer ideal-soliton degree draw, not numbered chunks; a missed frame costs almost nothing
- **Determinism** — Part contents are a pure function of the header; the decoder rebuilds each part's block set from `seq` alone, seeded with the exact u32 product `seq × 0x9e3779b1` (`Math.imul` — float multiplication diverges from `seq = 3,393,265`)
- **Wire part** — `air-gap:` + unpadded base64url of a 23-byte big-endian header (`ver` u8 = 1, `sessionId` 8 bytes, `seq` u32, `K` u16, `msgLen` u32, `crc32` u32) and exactly one block
- **Block size off the wire** — Inferred from payload length and pinned per session, so every part is the same size and each application picks its own symbol density up to `MAX_BLOCK_BYTES` (2048)
- **Session identity** — `(sessionId, K, msgLen, crc32)`; the decoder locks on and only switches after `SESSION_SWITCH_PARTS` (3) consecutive parts of one new session
- **Probabilistic recovery** — Distinct parts can be linearly dependent (a pinned K = 3 vector stalls at 1/3 after six distinct parts); receivers keep scanning, senders keep looping
- **Fail closed** — A CRC mismatch discards the assembly and resets, so a still-looping sender simply refills the decoder

## When to use this

- Moving a payload between two devices with no shared network, over a screen and a camera
- Signing requests, wallet payloads, or configuration blobs handed to an offline signer
- Any transfer that must survive dropped frames without a back-channel or retry protocol
- Payloads up to `MAX_MESSAGE_BYTES` (64 KiB), realistically a few hundred bytes to a few KiB

## When NOT to use this

- Bidirectional transfers — this transport has no acknowledgement channel
- Payloads larger than a few KiB — send a reference and fetch the bytes over a real network
- Confidentiality or authenticity — CRC32 is an integrity check, not a MAC; encrypt and sign inside the payload
- QR rendering or camera capture — bring your own; this package only produces and consumes strings
- Interoperating with BRC-225 TKQR1, BC-UR (`ur:`), or the legacy `bsvpayf2:` prefix — none share this wire format
- Production systems that cannot tolerate a wire change — the protocol is **experimental** until a second independent implementation passes the shared vectors

## Spec conformance

- **Wire spec** — [`specs/transport/air-gap-optical.md`](../../specs/air-gap-optical.md) (normative), registered publicly as [BRC-141](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0141.md)
- **Conformance vectors** — [`conformance/vectors/transport/air-gap-optical.json`](https://github.com/bsv-blockchain/ts-stack/blob/main/conformance/vectors/transport/air-gap-optical.json), executed by both the package test suite and the cross-language conformance runner; includes seed-precision boundary vectors at `seq = 3,393,265`, `0x7fffffff` and `0xffffffff`
- **CRC-32** — IEEE 802.3, polynomial `0xedb88320`, check value `0xCBF43926` for ASCII `123456789`
- **base64url** — RFC 4648 §5, unpadded; padding, whitespace and foreign alphabets are rejected
- **Coordination** — Convergence with PiWalletSV `PW1`, Vault Manager `CHUNK` and legacy `bsvpayf2:` (shared optical layer, common wallet-state envelope above it, explicit adapters) is tracked in [ts-stack issue #408](https://github.com/bsv-blockchain/ts-stack/issues/408)

## Common pitfalls

- **Waiting for `done` before reading** — `message()` returns `null` until every block is recovered; check `done` first
- **Treating `message() === null` as fatal** — After a CRC failure it means "keep scanning"; the decoder has already reset itself
- **Counting `seq` upward forever** — `seq` is a finite u32 and a receiver may stall on linearly dependent mixes; loop `seq` over a few multiples of `blockCount` instead
- **Changing `blockBytes` mid-stream** — The decoder pins the first accepted payload length and rejects the rest of the session
- **Sizing symbols against alphanumeric QR capacity** — base64url forces byte mode; use `estimatePartCharLength` against byte-mode tables
- **Exporting a display interval from this package** — There is none by design; the application owns its animation loop
- **Passing an empty or oversize message** — The encoder throws `AirGapError`; validate before constructing

## Related packages

- [@bsv/sdk](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/sdk) — Transaction and payload construction for the bytes this transport carries
- [@bsv/simple](simple.md) — Wallet facade that can originate air-gapped payloads
- [@bsv/wallet-helper](wallet-helper.md) — Wallet plumbing above the transport

## Reference

- [Wire specification (BRC-141)](../../specs/air-gap-optical.md)
- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/air-gap/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/air-gap)
- [npm](https://www.npmjs.com/package/@bsv/air-gap)
