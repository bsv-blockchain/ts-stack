---
id: conformance-overview
title: "Conformance"
kind: meta
version: "n/a"
last_updated: "2026-05-14"
last_verified: "2026-05-14"
review_cadence_days: 30
status: stable
tags: [conformance, testing, cross-language, vectors]
---

# Conformance Testing

The TypeScript stack is the reference source for portable BSV behavior. The conformance corpus turns that behavior into language-neutral JSON fixtures that SDKs, wallets, and infrastructure clients can reuse.

Current corpus: **6,625 vectors across 72 JSON files** (as of 2026-05-14). `conformance/META.json` is the authoritative index.

## How It Works

1. A protocol behavior is captured as a JSON vector under `conformance/vectors/`.
2. The vector records deterministic inputs and expected outputs.
3. The structural runner validates that vector files are well formed and emits reports.
4. The TypeScript/Jest runner dispatches supported vectors into `@bsv/sdk` behavior.
5. Other implementations can read the same JSON files and compare their outputs.

## Runner Entry Points

| Command | What It Does |
|---|---|
| `pnpm conformance` | Runs `conformance/runner/src/runner.js`; validates vector structure and writes reports |
| `pnpm conformance --validate-only` | Validates vector JSON only |
| `pnpm conformance --vectors conformance/vectors/wallet/brc100` | Runs the structural runner against a subset directory |
| `pnpm --filter @bsv/conformance-runner-ts test` | Runs the TypeScript/Jest dispatcher for SDK categories it recognizes |

Reports from the structural runner land in `conformance/runner/reports/`.

## Coverage

| Domain | BRCs Covered | Vector Path |
|---|---|---|
| SDK keys + crypto | BRC-42 + general primitives (AES, ECDSA, ECIES, hashes, HMAC, signatures) | `conformance/vectors/sdk/{keys,crypto}/` (8 files) |
| SDK transactions | BRC-74 MerklePath + BRC-62 serialization / BEEF / EF | `conformance/vectors/sdk/transactions/` |
| SDK scripts | BRC-14 Script parsing, encoding, sighash, evaluation (SV Node + Teranode fixtures) | `conformance/vectors/sdk/scripts/evaluation.json` (5,116 vectors) |
| SDK compat | BRC-77 BSM compatibility | `conformance/vectors/sdk/compat/bsm.json` |
| Wallet BRC-100 | Full `WalletInterface` (27 method files, ~950 vectors) | `conformance/vectors/wallet/brc100/` |
| Wallet BRC-29 | Payment key derivation | `conformance/vectors/wallet/brc29/payment-derivation.json` |
| Messaging BRC-31 | Authrite signature format + authsocket | `conformance/vectors/messaging/{brc31,authsocket}.json` |
| Auth / Overlay / Broadcast / Payments / Storage / Sync | BRC-31 handshake, BRC-62/20/22, BRC-29/121, BRC-26 UHRP, GASP, etc. | Multiple files under each domain |
| Regressions | 12 historical cross-SDK bug reproductions (go-sdk#306, ts-sdk#31, etc.) | `conformance/vectors/regressions/` (36 vectors) |

## Vector Format

Each vector file uses one metadata envelope with a `vectors` array:

```json
{
  "$schema": "../../../schema/vector.schema.json",
  "id": "wallet.brc100.getpublickey",
  "name": "BRC-100 WalletInterface.getPublicKey",
  "brc": ["BRC-100"],
  "version": "1.0.0",
  "reference_impl": "ts-sdk@2.0.14",
  "parity_class": "required",
  "vectors": [
    {
      "id": "wallet.brc100.getpublickey.1",
      "input": {
        "args": { "identityKey": true }
      },
      "expected": {
        "publicKey": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
      },
      "tags": ["happy-path", "brc-100"]
    }
  ]
}
```

See `conformance/VECTOR-FORMAT.md` and [Contributing Vectors](./contributing-vectors.md) before adding new fixtures.

## Testing Another Implementation

For a non-TypeScript SDK or wallet:

1. Read vector files directly from `conformance/vectors/`.
2. Preserve file IDs and vector IDs in your runner output.
3. Start with deterministic SDK vectors (`sdk/crypto`, `sdk/keys`) before stateful wallet vectors.
4. Compare your actual output to each vector's `expected` object.
5. Track unsupported categories explicitly rather than silently ignoring them.

## Recent Improvements (May 2026)

- All legacy-format vector files were normalized to the modern schema-compliant shape (`brc` as array, correct `parity_class` enum, relative `$schema`).
- The structural runner (`conformance/runner/src/runner.js`) was updated to cleanly support the special regression vector format with no warning spam.
- The corpus is now in a robust state for cross-language ports (Go, Rust, Python).

## Next Steps

- [Vector Catalog](./vectors.md) — Current vector files and method coverage
- [TypeScript Runner](./runner-ts.md) — Runner commands and limitations
- [Contributing Vectors](./contributing-vectors.md) — Add or refine fixtures
- [Architecture View](../architecture/conformance.md) — High-level overview for port planning teams
- **[Porting Guide](../conformance/PORTING_GUIDE.md)** — Practical guide for aligning Go, Rust, Python, or other language implementations (including known deviations and conformance tiers)
