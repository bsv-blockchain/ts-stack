---
id: spec-air-gap-optical
title: Air-Gap Optical Transport (BRC-141)
kind: spec
version: '1.0.0'
last_updated: '2026-07-30'
last_verified: '2026-07-30'
review_cadence_days: 30
status: experimental
tags: ['spec', 'transport', 'air-gap', 'qr', 'optical']
---

# Air-Gap Optical Transport (BRC-141)

> A one-directional, payload-agnostic transport that carries arbitrary bytes across an optical air gap: a sender renders fountain-coded text parts (typically as animated QR codes) and a receiver reassembles the exact bytes from a camera feed, with no back-channel of any kind. Wire protocol v1.

## At a glance

| Field           | Value                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format          | Markdown wire spec ([`specs/transport/air-gap-optical.md`](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/transport/air-gap-optical.md))            |
| Version         | 1.0.0 (wire `ver` byte = 1)                                                                                                                                     |
| Status          | experimental — no independent second implementation has exercised the shared vectors yet                                                                        |
| BRC             | [BRC-141](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0141.md)                                                                              |
| Implementations | [@bsv/air-gap](../packages/helpers/air-gap.md) (reference)                                                                                                      |
| Conformance     | [`conformance/vectors/transport/air-gap-optical.json`](https://github.com/bsv-blockchain/ts-stack/blob/main/conformance/vectors/transport/air-gap-optical.json) |

## What problem this solves

**Moving bytes between devices with no shared network.** An air-gapped signer, an offline vault, or two phones with no connectivity can only communicate through a screen and a camera. A single QR code caps out far below realistic payload sizes, so the payload must be split across an animated sequence — and a camera _will_ miss frames.

**Missed frames without a retry protocol.** Because parts are fountain-coded (Luby transform with a systematic prefix) rather than index-numbered chunks, the receiver does not wait for any specific frame to come around again: it uses whatever distinct parts arrive, in any order.

**A shared wire format.** BRC-225 (TKQR1), BC-UR, `bsvpayf2:`, PiWalletSV `PW1` and Vault Manager `CHUNK` all solve this problem with mutually incompatible framings. BRC-141 is the versioned, conformance-fixed transport intended as the convergence point, while remaining strictly payload-agnostic.

## Wire format summary

```
air-gap: + base64url( ver u8 ‖ sessionId 8B ‖ seq u32 ‖ K u16 ‖ msgLen u32 ‖ crc32 u32 ‖ block )
```

Header is 23 bytes, big-endian, `ver = 1`. Parts `0..K-1` carry the source blocks verbatim (one clean camera cycle decodes with zero overhead); later parts are deterministic XOR mixes reconstructed from `seq` alone via xorshift32 (`Math.imul` u32 seeding) and an exact-integer ideal-soliton degree draw. Recovery from `K + ε` distinct parts is probabilistic, not guaranteed — receivers keep scanning and senders keep looping. The full normative text, including decoder resource bounds, session locking, and the seed-precision boundary vectors, lives in [`specs/transport/air-gap-optical.md`](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/transport/air-gap-optical.md).

## Key decoder guarantees

- `accept()` is total: hostile camera input never throws and oversize strings are rejected before any allocation
- No partial or unverified bytes escape; output is CRC-gated and a mismatch discards the assembly
- The decoder locks onto one session; a single stray frame cannot erase progress, and three consecutive frames of a new session switch to it
- Memory and work are bounded against a hostile sender (tracked-seq, pending-part and pending-index budgets)

## Related

- [@bsv/air-gap package documentation](../packages/helpers/air-gap.md)
- [BRC-225 TKQR1](https://github.com/bsv-blockchain/BRCs/blob/master/peer-to-peer/0225.md) — indexed-chunk peer alternative, no shared framing
