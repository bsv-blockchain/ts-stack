# @bsv/air-gap

[![npm version](https://img.shields.io/npm/v/@bsv/air-gap)](https://www.npmjs.com/package/@bsv/air-gap)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/air-gap)](https://www.npmjs.com/package/@bsv/air-gap)

One-directional optical air-gap transport for arbitrary bytes. `@bsv/air-gap` turns a byte array into an endless, deterministic sequence of fountain-coded parts to display as QR codes, and reassembles the original bytes from a camera feed with no back-channel of any kind. Because the parts are fountain-coded rather than numbered chunks, any `K + ε` distinct parts reconstruct the message: a receiver that misses frames — and at several frames per second it will — simply keeps watching instead of waiting for one specific index to come round again. The package is payload-agnostic and has zero runtime dependencies; what the bytes mean, how they are rendered, and how fast they are shown are all decisions for the layer above.

## Install

```bash
npm install @bsv/air-gap
```

No peer dependencies. Works in browsers and in Node 22 or newer.

## Quick start

### Sending: display parts

```ts
import { AirGapEncoder } from '@bsv/air-gap'

const encoder = new AirGapEncoder(payloadBytes)

// The encoder holds no cursor — you own the sequence number and the cadence.
let seq = 0
const timer = setInterval(() => {
  renderQrCode(encoder.partAt(seq++)) // e.g. 5 frames per second
}, 200)
```

`partAt(seq)` is a pure function of `(message, blockBytes, seq)`, so `seq` may grow without bound and the same part can be re-rendered as often as needed. A single-block message needs no animation at all: display `partAt(0)` and never advance `seq`.

### Receiving: accept scans

```ts
import { AirGapDecoder } from '@bsv/air-gap'

const decoder = new AirGapDecoder()

onBarcodeScan(text => {
  const { ok, done, have, total } = decoder.accept(text)
  if (ok) showProgress(have, total)
  if (!done) return

  const payload = decoder.message()
  if (payload) finish(payload) // verified bytes, exactly as they were sent
})
```

`accept` never throws and never emits a partial message — a camera hands it stray reads, other people's QR codes and half-decoded frames, and every one of those is an ordinary `{ ok: false }` that changes nothing. `message()` returns the payload only once every block is recovered *and* the CRC-32 matches; on a mismatch it discards the assembly and resets itself, so a still-looping sender refills it without the application having to manage a retry.

## Wire format

A part is the prefix followed by unpadded base64url of a fixed 14-byte big-endian header and exactly one block:

```
air-gap: + base64url( seq ‖ K ‖ msgLen ‖ crc32 ‖ block )
```

| Field | Size | Meaning |
|-------|------|---------|
| `seq` | u32 | Part sequence number, unbounded. `seq < K` is source block `seq` verbatim (the systematic prefix). |
| `K` | u16 | Source block count, `ceil(msgLen / blockBytes)`. |
| `msgLen` | u32 | Length of the whole payload in bytes. |
| `crc32` | u32 | IEEE CRC-32 of the whole original payload, and of nothing else. |
| `block` | `blockBytes` | One source block, or an XOR mix of several. The last source block is zero-padded. |

The block size is deliberately **not** on the wire: the decoder infers it from the payload length, which keeps every part exactly the same size and lets each application pick its own symbol density. Three consequences worth knowing:

- **Session identity** is `(K, msgLen, crc32)`. A part with different values is a different message, and adopting it resets the decoder.
- **The block size is pinned** by the first part accepted into a session. Later parts that disagree are rejected, which is what stops two senders — or one mangled frame — from being assembled together.
- **Determinism is the contract.** The mixes are chosen by an xorshift32 RNG seeded from `seq` with an ideal-soliton degree, so a decoder rebuilds each part's block set from `seq` alone. `tests/vectors.test.ts` freezes the exact strings any implementation must reproduce.

## API

| Export | Purpose |
|--------|---------|
| `AirGapEncoder` | `new AirGapEncoder(message, blockBytes?)`; `partAt(seq)` renders a part string. Read-only `blockCount`, `blockBytes`, `messageLength`. |
| `AirGapDecoder` | `accept(text)` feeds one scan and returns `{ ok, done, have, total }`; `message()` returns the verified payload or `null`; `reset()` abandons the current scan. |
| `AirGapProgress` | Type of what `accept` returns. |
| `crc32(bytes)` | IEEE CRC-32 as an unsigned 32-bit number. |
| `isAirGapPart(text)` | Cheap prefix test, for routing camera reads before decoding them. |
| `estimatePartCharLength(blockBytes?)` | Exact character length of every part for a block size, for sizing against a QR version's capacity. |
| `AirGapError` | Thrown by the encoder on a message or configuration it cannot send. The decoder never throws. |
| `AIR_GAP_PREFIX` | `'air-gap:'` |
| `DEFAULT_BLOCK_BYTES` | `1200` |
| `MAX_MESSAGE_BYTES` | `65536` |

## Defaults and tunables

`DEFAULT_BLOCK_BYTES` is 1,200, which renders as a 1,627-character part — inside a version-40 QR symbol with margin for a camera that is not square-on to the screen. Lower it for smaller, more forgiving symbols at the cost of more parts; raise it only if the receiving camera really can resolve the density.

`MAX_MESSAGE_BYTES` is 65,536. At five parts per second and the default block size that is already 15 to 30 seconds of two people holding phones together, which is the practical limit of the medium; a larger payload is a sign the layer above should send a reference instead of the bytes.

Display cadence is not this package's concern and is not configurable here — no frame interval is exported. The application owns its own animation loop.

## Prior art

Not wire-compatible with any of these; listed because they solve the same problem:

- **BRC-225 TKQR1** — fixed-order indexed chunks; a peer alternative with no shared framing.
- **BC-UR** (`ur:`) — fountain-coded QR for crypto air-gaps; different framing and coding.
- **bsv-browser `fountain.ts`** (`bsvpayf2:`) — the direct algorithm ancestor of this package, from which the coding is ported bit-for-bit. This is its payload-agnostic evolution; the legacy prefix is not accepted.

## Non-goals

QR rendering, camera and barcode-scanner integration, animation timing, compression, encryption, authentication beyond the payload CRC, and payload schemas of any kind — payments, signing requests, BRC-100 blobs — all live above this transport, not in it.

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
