# @bsv/air-gap

[![npm version](https://img.shields.io/npm/v/@bsv/air-gap)](https://www.npmjs.com/package/@bsv/air-gap)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/air-gap)](https://www.npmjs.com/package/@bsv/air-gap)

One-directional optical air-gap transport for arbitrary bytes — the reference implementation of the **experimental** [BRC-141](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0141.md) wire protocol, v1. `@bsv/air-gap` turns a byte array into a deterministic sequence of fountain-coded parts to display as QR codes, and reassembles the original bytes from a camera feed with no back-channel of any kind. Because the parts are fountain-coded rather than numbered chunks, a receiver that misses frames — and at several frames per second it will — simply keeps watching instead of waiting for one specific index to come round again: with high probability, `K + ε` distinct parts reconstruct the message, and the looping systematic prefix makes eventual recovery certain. The package is payload-agnostic and has zero runtime dependencies; what the bytes mean, how they are rendered, and how fast they are shown are all decisions for the layer above.

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
const cycle = encoder.blockCount * 64
const timer = setInterval(() => {
  renderQrCode(encoder.partAt(seq)) // e.g. 5 frames per second
  seq = (seq + 1) % cycle // loop: re-running the systematic prefix guarantees recovery
}, 200)
```

`partAt(seq)` is a pure function of `(message, blockBytes, sessionId, seq)`, so the same part can be re-rendered as often as needed. A single-block message needs no animation at all: display `partAt(0)` and never advance `seq`. The sequence number is a u32 — finite, which is one more reason to loop rather than count upward forever.

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

`accept` never throws and never emits a partial message — a camera hands it stray reads, other people's QR codes and half-decoded frames, and every one of those is an ordinary `{ ok: false }` that changes nothing. Oversize strings are rejected before any decoding work, and the decoder's memory is bounded no matter what the camera feeds in. `message()` returns the payload only once every block is recovered _and_ the CRC-32 matches; on a mismatch it discards the assembly and resets itself, so a still-looping sender refills it without the application having to manage a retry.

## Wire format (BRC-141, v1)

A part is the prefix followed by unpadded base64url of a fixed 23-byte big-endian header and exactly one block:

```
air-gap: + base64url( ver ‖ sessionId ‖ seq ‖ K ‖ msgLen ‖ crc32 ‖ block )
```

| Field       | Size         | Meaning                                                                                                   |
| ----------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `ver`       | u8           | Wire protocol version, `1`. Any other value is rejected.                                                  |
| `sessionId` | 8 bytes      | Names this encoder's stream. Random by default; explicit for deterministic vectors or session resumption. |
| `seq`       | u32          | Part sequence number. `seq < K` is source block `seq` verbatim (the systematic prefix).                   |
| `K`         | u16          | Source block count, `ceil(msgLen / blockBytes)`.                                                          |
| `msgLen`    | u32          | Length of the whole payload in bytes.                                                                     |
| `crc32`     | u32          | IEEE CRC-32 of the whole original payload, and of nothing else. Integrity only — never authenticity.      |
| `block`     | `blockBytes` | One source block, or an XOR mix of several. The last source block is zero-padded.                         |

The block size is deliberately **not** on the wire: the decoder infers it from the payload length (and pins it per session), which keeps every part exactly the same size and lets each application pick its own symbol density up to `MAX_BLOCK_BYTES` (2,048). Points worth knowing:

- **Session identity** is `(sessionId, K, msgLen, crc32)`. The decoder locks onto the first session it accepts: one stray frame from another sender is rejected, and only `SESSION_SWITCH_PARTS` (3) consecutive parts of the same new session switch it over.
- **The block size is pinned** by the first part accepted into a session. Later parts that disagree are rejected, which is what stops one padded or truncated frame from being assembled with honest parts.
- **Determinism is the contract.** Mixes are chosen by an xorshift32 RNG seeded with the exact u32 product `seq × 0x9e3779b1` (`Math.imul`, never float multiplication) and an exact-integer ideal-soliton degree draw, so a decoder rebuilds each part's block set from `seq` alone. The frozen strings any implementation must reproduce live in the repository-root corpus at `conformance/vectors/transport/air-gap-optical.json`, including seeds on both sides of the JavaScript float-precision boundary.
- **Recovery is probabilistic, not absolute.** Distinct parts can be linearly dependent (for `K = 3`, parts `4, 27, 38, 56, 63, 72` all reduce to block 0 — pinned as a regression vector). Median cost for a receiver that missed the whole systematic pass is ≈1.4–1.5 K parts, the 99th percentile ≈4–4.6 K; a sender that loops its sequence bounds the worst case by the next systematic pass. See §6 of the [wire spec](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/transport/air-gap-optical.md).

## API

| Export                                    | Purpose                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AirGapEncoder`                           | `new AirGapEncoder(message, { blockBytes?, sessionId? })`; `partAt(seq)` renders a part string. Read-only `blockCount`, `blockBytes`, `messageLength`, `sessionId`. |
| `AirGapDecoder`                           | `accept(text)` feeds one scan and returns `{ ok, done, have, total }`; `message()` returns the verified payload or `null`; `reset()` abandons the current scan.     |
| `AirGapProgress` / `AirGapEncoderOptions` | The types of what `accept` returns and what the encoder constructor takes.                                                                                          |
| `crc32(bytes)`                            | IEEE CRC-32 as an unsigned 32-bit number.                                                                                                                           |
| `isAirGapPart(text)`                      | Cheap prefix test, for routing camera reads before decoding them.                                                                                                   |
| `estimatePartCharLength(blockBytes?)`     | Exact character length of every part for a block size, for sizing against a QR version's **byte-mode** capacity.                                                    |
| `AirGapError`                             | Thrown by the encoder on a message or configuration it cannot send. The decoder never throws.                                                                       |
| `AIR_GAP_PREFIX`                          | `'air-gap:'`                                                                                                                                                        |
| `AIR_GAP_WIRE_VERSION`                    | `1`                                                                                                                                                                 |
| `SESSION_ID_BYTES`                        | `8`                                                                                                                                                                 |
| `SESSION_SWITCH_PARTS`                    | `3` — consecutive foreign parts that switch the decoder to a new session                                                                                            |
| `DEFAULT_BLOCK_BYTES`                     | `1200`                                                                                                                                                              |
| `MAX_BLOCK_BYTES`                         | `2048`                                                                                                                                                              |
| `MAX_MESSAGE_BYTES`                       | `65536`                                                                                                                                                             |

## Defaults and tunables

`DEFAULT_BLOCK_BYTES` is 1,200, which renders as a 1,639-character part. base64url text contains lowercase letters, `-` and `_`, so QR encoders store parts in **byte mode** (one symbol byte per character), never the smaller alphanumeric mode: 1,639 bytes fits a version-40 QR symbol at every error-correction level up to Q (1,663) and leaves 44% headroom at level L (2,953) for a camera that is not square-on to the screen. Lower it for smaller, more forgiving symbols at the cost of more parts; raise it — up to `MAX_BLOCK_BYTES`, the largest block whose part still fits version 40-L — only if the receiving camera really can resolve the density. `estimatePartCharLength` gives the exact part length for any block size before an encoder is built.

`MAX_MESSAGE_BYTES` is 65,536. At five parts per second and the default block size that is already 15 to 30 seconds of two people holding phones together, which is the practical limit of the medium; a larger payload is a sign the layer above should send a reference instead of the bytes.

Display cadence is not this package's concern and is not configurable here — no frame interval is exported. The application owns its own animation loop.

## Hostile-input bounds

The decoder is the untrusted surface of this package, and its resources are bounded regardless of what a camera — or a hostile sender — feeds it: scanned strings longer than any legal part are rejected before base64 decoding, duplicate tracking is capped (`65,536` sequence numbers), and buffered mixes are budgeted (`1,024` parts / `4,096` unresolved block references). Systematic and degree-1 parts are never buffered, so a looping honest sender always completes even against a full buffer. The CRC is an integrity check only: an adversary who can show codes to your camera can forge any header, so **authenticate the payload inside the payload** (signature or MAC) whenever it matters.

## Prior art

Not wire-compatible with any of these; listed because they solve the same problem:

- **BRC-225 TKQR1** — fixed-order indexed chunks; a peer alternative with no shared framing.
- **BC-UR** (`ur:`) — fountain-coded QR for crypto air-gaps; different framing and coding.
- **bsv-browser `fountain.ts`** (`bsvpayf2:`) — the direct algorithm ancestor of this package. Its coding contained a JavaScript float-precision seed bug and a mis-sampled degree distribution, which BRC-141 v1 deliberately corrects rather than reproduces; neither its prefix nor its parts are accepted.
- **PiWalletSV `PW1`**, **Vault Manager `CHUNK`** — indexed transports in adjacent wallet projects; the convergence and adapter plan is tracked in the coordination issue linked from the [package documentation](https://github.com/bsv-blockchain/ts-stack/blob/main/docs/packages/helpers/air-gap.md).

## Non-goals

QR rendering, camera and barcode-scanner integration, animation timing, compression, encryption, authentication beyond the payload CRC, and payload schemas of any kind — payments, signing requests, BRC-100 blobs — all live above this transport, not in it.

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
