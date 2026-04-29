# BENCHMARK — @bsv/sdk

> Baselines not yet captured. Run benchmark suite to populate numbers column.
> Per MBGA §1.5: performance regression is a CI failure once baselines exist.

> Coverage baseline captured: Stmts 66.57%, Branch 59.53%, Funcs 74.16%, Lines 66.68% (2026-04-24)

## Hot Paths (Tier 0)

| Operation | Function | Module | Baseline (ops/sec) | Notes |
|-----------|----------|--------|--------------------|-------|
| ECDSA sign | `ECDSA.sign(msg, privKey)` | `src/primitives/ECDSA.ts` | TBD | Core signing path; deterministic k via DRBG |
| ECDSA verify | `ECDSA.verify(msg, sig, pubKey)` | `src/primitives/ECDSA.ts` | TBD | Must be faster than sign |
| Schnorr sign | `Schnorr.sign(msg, privKey)` | `src/primitives/Schnorr.ts` | TBD | Used in auth protocol |
| Schnorr verify | `Schnorr.verify(msg, sig, pubKey)` | `src/primitives/Schnorr.ts` | TBD | Used in auth protocol |
| Key derivation (BRC-42) | `PrivateKey.deriveChild(pubKey, invoiceNumber)` | `src/primitives/PrivateKey.ts` | TBD | Called per payment; hot path in wallet |
| Key derivation (BRC-42 public) | `PublicKey.deriveChild(privKey, invoiceNumber)` | `src/primitives/PublicKey.ts` | TBD | Client-side derivation |
| Transaction serialize | `Transaction.toBinary()` / `Transaction.toHex()` | `src/transaction/Transaction.ts` | TBD | Hot path on every broadcast |
| Transaction deserialize | `Transaction.fromBinary(bytes)` / `Transaction.fromHex(hex)` | `src/transaction/Transaction.ts` | TBD | Hot path on every received tx |
| Transaction ID compute | `Transaction.id('hex')` | `src/transaction/Transaction.ts` | TBD | Double-SHA256; called frequently |
| Script evaluation | `Spend.validate()` | `src/script/Spend.ts` | TBD | Called per input during verification |
| Script assembly (ASM→hex) | `Script.fromASM(asm).toHex()` | `src/script/Script.ts` | TBD | Template compilation |
| P2PKH lock script creation | `new P2PKH().lock(hash)` | `src/script/templates/P2PKH.ts` | TBD | Most common locking script |
| BEEF encode | `Beef.toBinary()` / `Beef.toHex()` | `src/transaction/Beef.ts` | TBD | Envelope format; sent on every payment |
| BEEF decode | `Beef.fromBinary(bytes)` | `src/transaction/Beef.ts` | TBD | Received on every payment |
| MerklePath verify | `MerklePath.verify(txid, chainTracker)` | `src/transaction/MerklePath.ts` | TBD | SPV proof verification |
| SHA-256 hash | `sha256(data)` | `src/primitives/Hash.ts` | TBD | Used everywhere; benchmark as reference |
| Hash-160 (SHA256+RIPEMD160) | `hash160(data)` | `src/primitives/Hash.ts` | TBD | Used in P2PKH address derivation |
| Point scalar multiply | `Point.mul(scalar)` | `src/primitives/Point.ts` | TBD | Underlying EC operation; drives sign/verify cost |

## Benchmark Suite

TODO: add `bench/` directory with a runner (e.g. tinybench or benchmark.js).
Command to run: `npm run bench` (not yet wired).

Suggested runner: [tinybench](https://github.com/tinylibs/tinybench) — zero-dependency, ESM-native.

Example structure:
```
packages/sdk/ts-sdk/bench/
  ecdsa.bench.ts
  keys.bench.ts
  transactions.bench.ts
  scripts.bench.ts
  hash.bench.ts
  run.ts          ← entry point, aggregates results
```

## Regression Gate

Once baselines are captured, a 10% regression in any hot path is a CI failure (MBGA §1.5).

The CI step should:
1. Run `npm run bench` and emit results as JSON.
2. Compare against committed baseline JSON in `bench/baselines/`.
3. Fail if any operation regresses by more than 10%.
