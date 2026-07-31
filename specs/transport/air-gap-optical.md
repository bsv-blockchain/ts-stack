# Air-Gap Optical Transport — wire protocol v1 (BRC-141)

Status: **Experimental** — the wire format is versioned and conformance-fixed,
but no independent second implementation has exercised the shared vectors yet.
Until one has, this protocol must not be described as stable.

Source: `packages/helpers/air-gap` (`@bsv/air-gap`, reference implementation).
Conformance fixtures: `conformance/vectors/transport/air-gap-optical.json`.
Public registration: [BRC-141](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0141.md).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as in RFC 2119.

## 1. Overview

A one-directional, payload-agnostic transport that carries an arbitrary byte
string across an optical air gap: a sender renders an endless sequence of
**parts** (text strings, typically shown as QR codes), and a receiver
reassembles the original bytes from whatever subset of parts a camera manages
to scan, with no back-channel of any kind. Parts are fountain-coded (Luby
transform) rather than index-numbered, so the receiver does not need any
specific frame to come around again.

The transport stops at the byte array. Rendering, camera capture, display
cadence, compression, encryption, authentication and payload semantics all
belong to the layers above or below; the transport imposes nothing about them.

## 2. Terminology

- **Message** — the bytes to transmit, `1..65 536` bytes.
- **Block** — one fixed-size slice of the message; the last block is
  zero-padded. `blockBytes` is `1..2 048` and is _not_ carried on the wire.
- **K** — the source-block count, `ceil(msgLen / blockBytes)`, `1..65 535`.
- **Part** — one wire string: the prefix plus a base64url body encoding a
  header and exactly one block-sized payload.
- **Session** — one encoder's stream, named by an 8-byte `sessionId` chosen at
  encoder construction (random unless the caller supplies one).
- **Systematic prefix** — parts `0..K-1`, which carry the source blocks
  verbatim.

## 3. Part grammar

```
part   = "air-gap:" body
body   = base64url( header ‖ payload )          ; RFC 4648 §5, UNPADDED
header = ver u8 ‖ sessionId 8 bytes ‖ seq u32 ‖ K u16 ‖ msgLen u32 ‖ crc32 u32
```

- All multi-byte integers are **big-endian**. The header is exactly 23 bytes.
- `ver` MUST be `0x01`. A decoder MUST reject any other value.
- `seq` is the part sequence number, a u32. `seq < K` marks a systematic part.
- `msgLen` is the whole message length in bytes; `crc32` is the IEEE CRC-32
  (polynomial `0xedb88320` reflected form; check value `0xcbf43926` for ASCII
  `123456789`) of the whole message and of nothing else.
- The base64url body is unpadded and MUST contain only `A-Z a-z 0-9 - _`.
  Decoders MUST reject padding characters, whitespace anywhere, any other
  alphabet, and any body whose length ≡ 1 (mod 4).
- `payload` is exactly `blockBytes` bytes: source block `seq` verbatim when
  `seq < K`, otherwise the XOR of the source blocks selected by §5.

Because base64url contains lowercase letters, `-` and `_`, QR encoders store a
part in **byte mode** (one symbol byte per character). A part for a given
`blockBytes` renders at exactly
`8 + 4·floor((23+blockBytes)/3) + tail` characters (tail = 0, 2 or 3 for
remainder 0, 1, 2), e.g. 1 639 characters at the default `blockBytes` 1200 —
inside a version-40 QR symbol at error-correction level Q (1 663 bytes), with
44 % headroom at level L (2 953). The `blockBytes` ceiling of 2 048 renders as
2 770 characters, chosen to keep every legal part inside version 40-L.

## 4. Encoding

1. Reject an empty message, a message over 65 536 bytes, a non-integer
   `blockBytes` outside `1..2048`, a configuration needing more than 65 535
   blocks, and a `sessionId` that is not exactly 8 bytes.
2. Zero-pad the message to `K × blockBytes` and slice it into K blocks.
3. `partAt(seq)` MUST be a pure function of
   `(message, blockBytes, sessionId, seq)`: block `seq` verbatim for
   `seq < K`, otherwise the XOR of the blocks chosen by §5 for `(seq, K)`.
4. `seq` is finite (u32). Senders SHOULD loop — re-emitting the systematic
   prefix, e.g. cycling `seq` over a window a few multiples of K wide — until
   the receiver signals success out of band. Looping through the systematic
   prefix is what makes eventual recovery deterministic rather than merely
   probable (§6).

## 5. Part-to-blocks mapping (normative, frozen)

For `seq ≥ K` the selected block set is reconstructed by the receiver from
`seq` and `K` alone. Every operation below is exact integer arithmetic; a
conforming implementation reproduces it bit for bit in any language.

**RNG.** xorshift32 with state `x` (u32):

```
x ^= x << 13 ; x &= 0xffffffff
x ^= x >> 17
x ^= x << 5  ; x &= 0xffffffff
```

Each call returns the new `x`. Seed: `x = (seq × 0x9e3779b1) mod 2^32` —
**32-bit modular multiplication** (`Math.imul` in JavaScript; plain u32
multiplication elsewhere). If the seed is 0 (only `seq = 0`, unreachable on
the wire because `seq < K` is systematic), substitute `0x6d2b79f5`.
A JavaScript port MUST NOT use `(seq * 0x9e3779b1) >>> 0`: doubles lose low
bits from `seq = 3 393 265` onward (e.g. at `seq = 0x7fffffff` the float seed
is 3 788 015 616 where the correct u32 product is 3 788 015 183). The
conformance corpus pins parts on both sides of that boundary and at
`0xffffffff`.

**Draws.** Each draw takes the next RNG output `x` and uses its top 23 bits:
`r = x >> 9`, so `r ∈ [0, 2^23)`.

**Degree.** One draw `r`; then

```
d = floor((2^23 + r) / (r + 1))        ; = ceil(2^23 / (r+1))
if d > K: d = 1
```

This is an exact inverse-CDF sample of the **ideal soliton distribution** over
`1..K` — `ρ(1) = 1/K`, `ρ(d) = 1/(d(d−1))` for `d ≥ 2` — because the
truncated tail `d > K` has total probability ≈ `1/K`, exactly the mass
`ρ(1)` requires. (For `K = 1` every part is block 0.)

**Indices.** A partial Fisher–Yates shuffle of the pool `[0, 1, …, K−1]`:
for `i = 0 .. d−1`, draw `rᵢ`, let `j = i + floor(rᵢ · (K − i) / 2^23)`, swap
`pool[i]` and `pool[j]`. The selected set is `pool[0..d−1]`, **in that order**
(order is irrelevant to XOR but is pinned by the vectors). All products stay
below 2^40, so 64-bit integer or double arithmetic is exact.

## 6. Recovery characteristics (informative, binding on documentation)

Distinct parts are **not** guaranteed to be linearly independent: recovery
from any `K + ε` distinct parts is probabilistic, not absolute, and
documentation of this protocol MUST NOT claim otherwise. Deterministic
example: for `K = 3`, parts `4, 27, 38, 56, 63, 72` all reduce to source
block 0, so six distinct parts leave progress at 1/3 (pinned in the
conformance corpus). Receivers simply keep scanning; senders keep looping.

Measured with the reference implementation (400 deterministic trials per
cell): a repair-only receiver that has missed the entire systematic prefix
completes at ~1.4–1.5 K parts at the median and ~3.8–4.6 K at the 99th
percentile (K = 5..55); a receiver watching a sender that loops `seq` over an
8 K-wide cycle completes within 1.5 K reads at the median and ~2.5 K at the
99th percentile, bounded by the next systematic pass.

## 7. Decoding

A decoder consumes whatever a barcode library reports and MUST be total: no
input may throw, and no partial or unverified bytes may ever be exposed.

**Structural acceptance.** Reject (as a no-op) any read that: lacks the
prefix; is longer than the longest legal part (2 770 characters, §3) — this
check MUST precede base64 decoding so hostile input costs no allocation; is
not valid unpadded base64url; decodes to fewer than 24 or more than 2 071
bytes; has `ver ≠ 1`, `K = 0`, `msgLen = 0`, `msgLen > 65 536`; or fails the
shape agreement `ceil(msgLen / payloadLength) = K`.

**Session identity and locking.** A session is
`(sessionId, K, msgLen, crc32)`. The decoder locks onto the first session it
accepts. A part of a different session MUST NOT disturb the locked session's
progress; only `SESSION_SWITCH_PARTS = 3` _consecutive_ parts of the same
foreign session switch the decoder to it (starting it fresh). A part of the
locked session, or of a different foreign session, resets the run. Unusable
reads do not affect the count. This is what stops a single stray frame — one
photo of somebody else's screen — from erasing progress, while a camera
genuinely re-pointed at a new sender converges within three frames.

**Block-size pin.** The session identity excludes `blockBytes`, so the first
accepted part pins the payload length; later parts of the same session with a
different payload length are rejected. This is what stops one padded or
truncated frame (header intact) from being assembled with honest parts.

**Peeling.** Reduce each accepted part by already-solved blocks; a part left
with one unknown solves that block; each solve re-reduces buffered parts
until no more progress. Duplicate `seq` values are acknowledged without
reprocessing.

**Completion.** Once all K blocks are solved, concatenate, trim to `msgLen`,
and verify `crc32`. On match, expose the bytes; the session is complete and
further parts of it MUST NOT change any state. On mismatch, discard the
entire assembly and reset — the still-looping sender refills from scratch.
The CRC gate means callers never observe corrupt output; corruption costs one
extra sender cycle.

**Resource bounds.** Untrusted-input state MUST be bounded. The reference
bounds (RECOMMENDED values; implementations MAY tune them but MUST bound):

- `MAX_TRACKED_SEQS = 65 536` — duplicate-suppression entries; past the cap,
  new sequence numbers are re-processed instead of remembered (idempotent, so
  correctness is unaffected).
- `MAX_PENDING_PARTS = 1 024` — buffered unsolved mixes; a mix arriving with
  the buffer full is rejected.
- `MAX_PENDING_INDICES = 4 096` — total unresolved block references across
  the buffer; a mix that would exceed it is rejected.

Systematic and degree-1 parts are never buffered, so both rejections preserve
liveness: a looping sender always completes the session through its
systematic prefix. Per-part work is O(K) (index pool) plus O(degree) XOR of
one block; the peeling cascade is bounded by the indices budget.

## 8. Security considerations

- **CRC-32 is integrity, not authenticity.** It catches camera misreads and
  interleaving accidents. An adversary who can show codes to the camera can
  forge any header and any CRC; payloads that matter MUST carry their own
  authentication (signature/MAC) inside the message bytes.
- **The session id is an accident guard, not a security boundary.** 8 random
  bytes make honest cross-talk vanishingly unlikely (birthday bound 2^-32 at
  65 000 simultaneous sessions), but an active optical attacker sees the
  sender's screen and can copy the id. Session locking bounds what such an
  attacker can do to _availability_ (they already control the channel); it
  cannot provide authenticity.
- **Resource exhaustion.** The §7 bounds cap decoder memory at a few MB and
  per-frame work at O(K) against a hostile sender; the pre-decode length gate
  caps allocation for non-part garbage at zero.
- **Confidentiality.** Anyone who can see the screen has the message. Encrypt
  inside the payload when that matters.

## 9. Conformance

`conformance/vectors/transport/air-gap-optical.json` is the normative fixture
set: encoding vectors (including the seed-precision boundary at
`seq = 3 393 265`, `0x7fffffff` and `0xffffffff`), decode and session-locking
vectors, the linear-dependence stall regression, hostile-input rejections,
part-length and CRC check values. The reference implementation's test suite
and the cross-language conformance runner execute the same file. Vectors are
append-only once merged; a change that breaks one is a protocol change and
requires a new `ver` value.

## 10. Relationship to adjacent transports

Not wire-compatible with any of: **BRC-225 TKQR1** (indexed pipe-delimited
frames), **BC-UR** (bytewords/CBOR, different fountain), the legacy
**`bsvpayf2:`** browser fountain (its coding contained a JavaScript-specific
seed-precision bug and a mis-sampled degree distribution that this protocol
deliberately does not reproduce), **PiWalletSV `PW1`** (indexed gzip+CBOR
envelopes), or **Vault Manager `CHUNK`**. Those systems own their migration
paths; the convergence plan — this transport as the shared optical layer, a
separate common envelope owning wallet-state semantics, and explicit adapters
for `PW1`/`CHUNK`/`bsvpayf2` — is tracked in the coordination issue linked
from the package documentation. This transport stays payload-agnostic either
way.
