---
id: pkg-air-gap
title: '@bsv/air-gap'
kind: package
domain: helpers
version: '0.1.0'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-07-30'
last_verified: '2026-07-30'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/air-gap'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/air-gap'
status: stable
tags: [helpers, air-gap, qr, optical]
---

# @bsv/air-gap

> One-directional optical air-gap transport for arbitrary bytes — fountain-coded QR parts that survive missed camera frames with no back-channel, zero runtime dependencies, and CRC32 payload integrity.

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
let seq = 0
setInterval(() => renderQrCode(encoder.partAt(seq++)), 200)

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

- **AirGapEncoder** — Splits a message into `K` source blocks and renders part `seq` as a wire string; pure function of `(message, blockBytes, seq)`
- **AirGapDecoder** — Accepts scanned strings, peels fountain parts, and emits the CRC-verified payload
- **Systematic prefix** — The first `K` parts are the source blocks verbatim, so one clean camera cycle decodes with zero overhead
- **Loss tolerance** — Later parts are interchangeable XOR mixes; any `K + ε` distinct parts reconstruct the message
- **Camera safety** — `accept` never throws and never emits partial or unverified bytes
- **Session isolation** — `(K, msgLen, crc32)` identifies a message; a foreign part resets the decoder instead of blending
- **Block-size pin** — The first accepted part fixes the payload length for the session, rejecting mismatched frames
- **Zero runtime dependencies** — No `@bsv/sdk`, no polyfills beyond `btoa` / `atob`

## Runtime and package compatibility

The package root provides matching typed entry points for Node.js ESM and
CommonJS consumers. The published tarball is checked with `publint`, strict
`@arethetypeswrong/core` resolution, and clean installs that import and
require every public export. Node.js 22 or newer is supported.

## Common patterns

### Animate a multi-part message

```typescript
const encoder = new AirGapEncoder(payload, 1200)
let seq = 0
const timer = setInterval(() => renderQrCode(encoder.partAt(seq++)), 200)
// seq is unbounded: keep looping until the receiver signals success out-of-band
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

estimatePartCharLength(1200) // 1627 characters, exactly
```

### Abandon a scan

```typescript
onCancel(() => decoder.reset())
```

## Key concepts

- **Fountain coding** — Luby-transform parts with an ideal-soliton degree, not numbered chunks; a missed frame costs almost nothing
- **Determinism** — Part contents are a pure function of `seq`; the decoder rebuilds each part's block set from the header alone
- **Wire part** — `air-gap:` + unpadded base64url of a 14-byte big-endian header (`seq` u32, `K` u16, `msgLen` u32, `crc32` u32) and exactly one block
- **Block size off the wire** — Inferred from payload length, so every part is the same size and each application picks its own symbol density
- **Session key** — `(K, msgLen, crc32)`; a change means a different message and a full decoder reset
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

## Spec conformance

- **CRC-32** — IEEE 802.3, polynomial `0xedb88320`, check value `0xCBF43926` for ASCII `123456789`
- **base64url** — RFC 4648 §5, unpadded
- **Conformance vectors** — Frozen part strings in `tests/vectors.test.ts`; any implementation must reproduce them byte for byte
- **BRC** — The wire format is intended for a future BRC; no number is assigned yet

## Common pitfalls

- **Waiting for `done` before reading** — `message()` returns `null` until every block is recovered; check `done` first
- **Treating `message() === null` as fatal** — After a CRC failure it means "keep scanning"; the decoder has already reset itself
- **Changing `blockBytes` mid-stream** — The decoder pins the first accepted payload length and rejects the rest of the session
- **Exporting a display interval from this package** — There is none by design; the application owns its animation loop
- **Passing an empty or oversize message** — The encoder throws `AirGapError`; validate before constructing

## Related packages

- [@bsv/sdk](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/sdk) — Transaction and payload construction for the bytes this transport carries
- [@bsv/simple](simple.md) — Wallet facade that can originate air-gapped payloads
- [@bsv/wallet-helper](wallet-helper.md) — Wallet plumbing above the transport

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/air-gap/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/air-gap)
- [npm](https://www.npmjs.com/package/@bsv/air-gap)
