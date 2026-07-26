# Compact cryptography and worker benchmark — 2026-07-23

This retained run covers the compact BDK ABI, generic secp256k1 primitives,
opportunistic SDK composition, lazy multi-worker scheduling, and verification
table snapshotting. All figures are medians of 25 samples.

## Environment and artifacts

- MacBook Pro, Apple M3 Max, 128 GB RAM
- macOS 26.5.1 (25F80), arm64, 16 logical cores
- Node v25.9.0, pnpm 10.33.2
- Emscripten 4.0.23 pinned macOS/arm64 builder
- Full ESM/worker WASM: 257,008 bytes,
  SHA-256 `35bb36ee9732ff0432ca3b194f69b132aa4d555ba81fc28c6d922b38cd914189`
- Slim UMD WASM: 256,335 bytes,
  SHA-256 `a840c115b4f9297d33423712983ee95e294adf1056a946dd27c94f93253ceb75`
- Complete classic payload: 297,505 bytes (15,905-byte wrapper +
  25,265-byte loader + 256,335-byte WASM)

The preceding artifact was 3,013,717 bytes. The complete classic payload is now
90.1% smaller while retaining transaction/Spend verification, packed batches,
the generic cryptographic primitives below, and automatic SDK integration.
Worker-only scheduling and table-snapshot glue stays out of the classic build.

## Generic and composed cryptography

Command: `pnpm --filter @bsv/verifast bench:crypto`

| Operation                     | SDK JavaScript |  BDK WASM | Speedup |
| ----------------------------- | -------------: | --------: | ------: |
| Deterministic ECDSA sign      |      0.9780 ms | 0.0347 ms |  28.19x |
| ECDSA verify                  |      0.8971 ms | 0.0490 ms |  18.32x |
| Compressed public key         |      0.0420 ms | 0.0269 ms |   1.56x |
| BRC-42 public derivation      |      0.5138 ms | 0.1773 ms |   2.90x |
| BRC-42 symmetric derivation   |      1.4948 ms | 0.1614 ms |   9.26x |
| `ProtoWallet.createSignature` |      0.9812 ms | 0.0375 ms |  26.17x |
| `ProtoWallet.verifySignature` |      0.9143 ms | 0.0555 ms |  16.48x |

An isolated private BRC-42 derivation was deliberately left on the existing
TypeScript scalar-add path: crossing into WASM did not repay its fixed overhead.
The private-tweak primitive remains available to callers that can amortize it,
and signing still accelerates after the TypeScript derivation.

The generic deterministic signature, compressed public key, BRC-42 public,
symmetric, wallet-signature, and P2PKH transaction results were compared
byte-for-byte with the SDK. Generic verification accepts the SDK's high-S form;
transaction script policy continues to enforce `LOW_S` independently.

## Packed signature batch

The same 250 valid P2PKH digest/public-key/signature tuples were verified through
each lane:

| Lane                          | Complete batch | Relative to SDK JS |
| ----------------------------- | -------------: | -----------------: |
| SDK JavaScript loop           |     224.082 ms |              1.00x |
| Packed BDK, one instance      |      12.099 ms |             18.52x |
| Packed BDK, four warm workers |       3.343 ms |             67.02x |

Four workers improve the one-instance BDK batch by 3.62x. They are never used
for a single verification and are created only by `preloadBatch()` or a
qualifying batch.

## Transaction and Spend worker scheduling

Command: `pnpm --filter @bsv/verifast bench:batch`

| Items | Spend 1 worker | Spend 4 workers |  Gain | EF 1 worker | EF 4 workers |  Gain |
| ----: | -------------: | --------------: | ----: | ----------: | -----------: | ----: |
|     1 |       0.098 ms |        0.089 ms | 1.11x |    0.072 ms |     0.064 ms | 1.11x |
|    10 |       0.620 ms |        0.578 ms | 1.07x |    0.537 ms |     0.533 ms | 1.01x |
|    50 |       2.797 ms |        0.921 ms | 3.04x |    2.684 ms |     0.805 ms | 3.34x |
|   250 |      13.718 ms |        4.088 ms | 3.36x |   13.006 ms |     3.553 ms | 3.66x |

The configured threshold was 32, so the 1- and 10-item rows stay on one WASM
instance. The small differences there are normal run-to-run noise rather than
worker dispatch.

A real 250-transaction dependent P2PKH graph was also signed and verified
through `Transaction.verify`, including recursive source-transaction discovery
and one batched graph verdict. One WASM instance took 13.644 ms; four workers
took 3.781 ms, a 3.61x throughput gain. This exercises the same public SDK path
used for deep BEEF validation rather than calling the packed ABI directly.

## Verification-table warm-up

Command: `pnpm --filter @bsv/verifast bench:warmup`

The full libsecp256k1 W15 verification state is exactly 1,048,576 bytes. Four
independent worker generations plus the main instance took 9.830 ms. Generating
once in the main instance and importing the snapshot into all four workers took
5.320 ms, including snapshot export and worker imports: 45.9% less warm-up wall
time (1.85x).

Each isolated WASM memory still needs its own table copy. A `SharedArrayBuffer`
avoids four JS-side copies when available; structured cloning is the compatible
fallback. The snapshot is runtime-only and does not add 1 MiB to the package.

## EF serialization

| Script |  EF bytes | Legacy `number[]` | Typed cold | Cached typed | Cold gain |
| -----: | --------: | ----------------: | ---------: | -----------: | --------: |
|  1 KiB |     1,233 |          0.020 ms |   0.003 ms |   <0.0001 ms |     6.73x |
| 64 KiB |    65,746 |          1.003 ms |   0.013 ms |   <0.0001 ms |    75.55x |
|  1 MiB | 1,048,786 |         15.929 ms |   0.095 ms |    0.0002 ms |   167.94x |
|  4 MiB | 4,194,514 |         66.922 ms |   0.318 ms |    0.0002 ms |   210.56x |

The worker protocol and primitive ABI use packed typed arrays throughout, so
the faster cryptography does not expose a new `number[]`, JSON, or per-item
marshalling bottleneck.
