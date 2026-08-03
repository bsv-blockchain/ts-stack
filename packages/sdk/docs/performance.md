# Performance Benchmarks

## Repeated BEEF dependency sorting (August 2026)

Wallet transaction creation can ask the same unchanged BEEF for its dependency
order more than once while preparing known transaction IDs, merging proofs, and
serializing the final result. The mutation-aware sort cache retains the public
ordering while avoiding another complete graph partition and topological sort.

```bash
BEEF_SORT_TXS=20000 node benchmarks/beef-sort-cache-bench.js
```

Against unmodified commit `c212b5ee7`, seven same-host samples on Apple Silicon
with Node.js v24.18.0 produced a 235.86 ms median for 50 unchanged sorts. The
optimized build took 9.72 ms after validating directly reachable dependency
state, a 24.3x improvement. The cold sort remained about
7–8 ms; transaction or proof mutation invalidates the cache, and callers receive
new result arrays so consumer mutation cannot alter the cached order.

## Transaction and BEEF pipeline (July 2026)

The transaction pipeline benchmark uses built ESM artifacts and is intentionally runnable against another build through `SDK_DIST_ROOT`. Measurements below were taken on the same Apple Silicon host with Node.js v25.9.0. Each comparison uses identical generated transactions and benchmark code.

Commands:

```bash
# 4.17 MB Atomic BEEF, 1,000-transaction spend chain
CHAIN_DEPTH=1000 SCRIPT_BYTES=4096 BENCH_SAMPLES=5 \
  node benchmarks/transaction-pipeline-bench.js

# 1,000-input P2PKH transaction
CHAIN_DEPTH=10 SCRIPT_BYTES=1 WIDE_INPUTS=1000 BENCH_SAMPLES=3 \
  node benchmarks/transaction-pipeline-bench.js
```

| Workload (median) | `main` | Optimized | Improvement |
| --- | ---: | ---: | ---: |
| 4.17 MB cold Atomic BEEF serialize | 150.80 ms | 16.11 ms | 89.3% faster |
| 4.17 MB warm Atomic BEEF serialize | 132.47 ms | 1.46 ms | 98.9% faster |
| 4.17 MB copy-safe structural parse | 3.77 ms | 0.95 ms | 74.8% faster |
| 4.17 MB zero-copy structural parse | unavailable | 0.51 ms | 86.4% faster than baseline copy-safe parse |
| 4.17 MB linked Atomic BEEF parse | 13.60 ms | 12.62 ms | 7.2% faster |
| 1,000-link spend-chain verification | 1.82 ms | 0.73 ms | 60.0% faster |
| 4.17 MB parse and topological sort | 12.40 ms | 5.71 ms | 54.0% faster |
| 1,000-input P2PKH sign | 1,266.19 ms | 1,161.64 ms | 8.3% faster |
| 1,000-input P2PKH verify | 2,090.32 ms | 1,213.03 ms | 42.0% faster |

The default 2,000-link, 4.24 MB workload completes cold serialization, zero-copy structural parsing, linked parsing, verification, and sorting in roughly 69 ms of measured median/one-shot work on the optimized build. The same workload overflows the JavaScript stack on `main`; the iterative implementation is also regression-tested at 3,000 links.

### Large-data wallet and serialization paths

The retained large-data benchmark measures an 8 MiB generic payload against an
unmodified build from commit `a9a432fbc` and the optimized build on the same
Apple Silicon host with Node.js v25.9.0:

```bash
WALLET_BENCH_BYTES=8388608 BENCH_SAMPLES=7 \
  node benchmarks/large-data-wallet-bench.js
```

| Workload (median) | Baseline | Optimized | Improvement |
| --- | ---: | ---: | ---: |
| 8 MiB direct `Script.fromHex` | 171.49 ms | 23.52 ms | 86.3% faster |
| 8 MiB warm `Beef.toUint8ArrayAtomic` | 1.701 ms | 0.0067 ms | 99.6% faster |
| 8 MiB Wallet Wire `internalizeAction` round trip | 68.88 ms | 1.41 ms | 98.0% faster |

The subsequent zero-copy Wallet Wire pass was measured separately against its
immediate branch base (`af70681d9`) with nine samples on the same host. It
pre-sizes the request/response writers and hands their written views directly
to the compact-byte transport:

| 8 MiB Wallet Wire workload (median) | Immediate base | Zero-copy handoff | Improvement |
| --- | ---: | ---: | ---: |
| `internalizeAction` round trip | 1.407 ms | 0.471 ms | 66.5% faster |
| `createAction` BEEF request plus signable BEEF response | 2.905 ms | 0.712 ms | 75.5% faster |

The benchmark accepts `SDK_DIST_ROOT` to run the exact same code against
another built SDK. Atomic BEEF caching is mutation-aware, so graph changes
invalidate the cached bytes before reuse.

Wallet Wire retains its required `number[]` method for compatibility and adds an
optional `Uint8Array` lane. The transceiver selects compact bytes only when the
transport advertises support; the processor and HTTP binary transport implement
both forms. Other wallet substrates keep their existing JSON, structured-clone,
or native-bridge contracts. No BRC-100 arguments, results, or transport
protocols change.

Large binary values therefore follow the cheapest representation supported by
each existing substrate:

| Wallet client substrate | Large-data behavior |
| --- | --- |
| Cicada / HTTP Wallet Wire | Compact `Uint8Array` frames end to end; legacy `number[]` implementations remain compatible. |
| Direct Wallet Wire processor | Compact `Uint8Array` frames with no transport serialization. |
| XDM | Browser structured clone carries `Uint8Array` values without SDK-side JSON conversion or boxing. |
| `window.CWI` | Direct BRC-100 delegation; arguments and results are not reserialized by the SDK. |
| HTTP JSON | Existing JSON wire representation is preserved. |
| React Native WebView | Existing stringified native-bridge representation is preserved. |

XDM does not transfer ownership of caller buffers because doing so would detach
application-owned BRC-100 arguments. The JSON and native-bridge substrates do
not substitute a binary encoding because that would change their protocols.

Wallet Toolbox has a separate reproducible frontier benchmark:

```bash
node ../wallet/wallet-toolbox/benchmarks/ancestor-fetch-bench.mjs
```

With 32 independent ancestors and a fixed 10 ms mock service latency, sequential `main` takes 358.55 ms. The bounded eight-way implementation takes 54.34 ms (84.8% faster, 6.6x throughput) while preserving deterministic merge order. Negotiated base64 JSON-RPC reduces a representative 1 MiB binary payload from 3,743,755 bytes to 1,398,147 bytes, a 62.7% wire-size reduction; legacy peers continue to receive numeric arrays.

### Signature-hash cache lifetime

`Spend` invalidates its internally owned signature-hash cache at the start of every validation, so a standalone instance remains safe to reuse after transaction fields are mutated. A `SignatureHashCache` supplied to `Spend` is externally owned and may be shared across inputs only for a single immutable signing or verification pass. Callers must create a fresh cache after mutating prevouts, sequences, outputs, or any other signed transaction field.

## BigNumber Benchmarks

The benchmark scripts measure extremely large number operations and script number serialization performance.

All results below were gathered on Node.js v22.16.0 using the `dist` build of the SDK. Each benchmark was executed with 200,000-digit inputs to stress the implementation.

## Addition and Multiplication

Command:

```bash
node benchmarks/bignumber-bench.js 200000 1 1
```

| Branch | mul large numbers | add large numbers |
| --- | --- | --- |
| master (pre-May-2025) | 6364.11ms | 13.04ms |
| fix-mem (May-2025) | 13.60ms | 2.64ms |

## Serialization

Command:

```bash
node benchmarks/serialization-bench.js 200000 1
```

| Branch | toSm big | toSm little | fromSm big | fromSm little | fromScriptNum |
| --- | --- | --- | --- | --- | --- |
| master (pre-May-2025) | 6.12ms | 10.11ms | 6.35ms | 12.56ms | 3.39ms |
| fix-mem (May-2025) | 8.46ms | 8.12ms | 27.77ms | 11.16ms | 10.31ms |

## Transaction Verification

Command:

```bash
node benchmarks/transaction-bench.js
```

| Branch | deep chain verify | wide transaction verify | large tx verify | nested inputs verify |
| --- | --- | --- | --- | --- |
| fix-mem (May-2025) | 3335.76ms | 2930.86ms | 1534.36ms | 1198.08ms |

## SymmetricKey Encryption/Decryption

Command:

```bash
node benchmarks/symmetric-key-bench.js
```

| Branch | encrypt large 2MB | decrypt large 2MB | encrypt 50 small | decrypt 50 small | encrypt 200 medium | decrypt 200 medium |
| --- | --- | --- | --- | --- | --- | --- |
| fix-mem baseline | 8609.78ms | 8372.23ms | 34.02ms | 48.58ms | 859.38ms | 960.16ms |
| optimized AESGCM (round 1) | 7678.65ms | 7619.82ms | 60.23ms | 35.21ms | 871.89ms | 763.13ms |
| optimized AESGCM (round 2) | 2026.89ms | 1793.35ms | 15.01ms | 7.88ms | 213.35ms | 169.37ms |

## Reader/Writer Operations

Command:

```bash
node benchmarks/reader-writer-bench.js
```

| Branch | mixed ops | large payloads | 3000 small payloads | 400 medium payloads |
| --- | --- | --- | --- | --- |
| fix-mem baseline | 9.93ms | 127.49ms | 27.86ms | 41.71ms |
| optimized utils.ts | 5.02ms | 91.93ms | 19.04ms | 53.80ms |
