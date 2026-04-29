---
id: conformance-overview
title: "Conformance"
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: [conformance, testing, cross-language, vectors]
---

# Conformance Testing

The TypeScript stack is the **canonical reference implementation** for the BSV ecosystem. Conformance vectors are derived from this codebase and define expected behavior for every supported protocol. Other language implementations (Go, Python, Rust) consume the same vectors to verify cross-language compatibility.

## How It Works

1. The TypeScript SDK generates expected outputs for each supported protocol operation.
2. These outputs are committed as JSON vectors in `conformance/vectors/`.
3. The TypeScript Jest runner validates that the current TS codebase produces results matching the vectors.
4. Implementations in other languages (Go, Python, Rust) run the same vectors against their own code and compare outputs.
5. Any divergence indicates a protocol-level incompatibility that must be resolved.

## Coverage

**260 vectors across 33 files** (see `conformance/META.json` for the authoritative corpus metadata).

| Domain | BRCs covered | Vector path |
|--------|-------------|-------------|
| SDK — keys | BRC-42 | `conformance/vectors/sdk/keys/` |
| SDK — crypto | BRC-42 signatures | `conformance/vectors/sdk/crypto/` |
| SDK — transactions | BRC-74 (MerklePath) | `conformance/vectors/sdk/transactions/` |
| SDK — scripts | Script engine | `conformance/vectors/sdk/scripts/` |
| SDK — compat | BRC-77 (BSM) | `conformance/vectors/sdk/compat/` |
| Wallet — BRC-100 | `getPublicKey`, `createHmac`, `createSignature`, `encrypt` | `conformance/vectors/wallet/brc100/` |
| Wallet — BRC-29 | Payment key derivation | `conformance/vectors/wallet/brc29/` |
| Messaging — BRC-31 | Authrite signature | `conformance/vectors/messaging/brc31/` |
| Regressions | 12 historical bug fixes | `conformance/vectors/regressions/` |

## Running Tests

```bash
# TypeScript — runs all vectors against the current @bsv/sdk build
pnpm conformance
```

The runner is at `conformance/runner/ts/runner.test.ts` and uses Jest.

Reports land in `conformance/runner/reports/` after each run.

## Vector Format

Each vector is a JSON file validated against `conformance/schema/vector.schema.json` (JSON Schema 2020-12):

```json
{
  "id": "brc42-key-derivation-happy-path",
  "parity_class": "BRC-42",
  "domain": "sdk/keys",
  "inputs": {
    "rootKey": "...",
    "derivationPath": "m/44'/0'/0'/0/0"
  },
  "expectedOutput": {
    "publicKey": "02a1b2c3..."
  }
}
```

See `conformance/VECTOR-FORMAT.md` for the complete schema specification.

## Cross-Language Implementations

The same vector corpus is consumed by:

- **Go** — `bsv-blockchain/go-sdk` (runner migrating from ts-stack into the go-sdk repo)
- **Python** — planned
- **Rust** — planned

When a new protocol feature lands in the TS SDK, adding conformance vectors for it is part of the PR checklist (see `conformance/REGRESSION_QUEUE.md` for cases pending vectorization).

## Contributing Vectors

See [Contributing Vectors](./contributing-vectors.md) for the contribution workflow and the `VECTOR-FORMAT.md` spec.

## Regression Tracking

12 regression vectors (in `conformance/vectors/regressions/`) trace historical bugs across both the TS and Go implementations. The `regression_index` in `META.json` maps each to its source issue.

## Next Steps

- **[Vector Catalog](./vectors.md)** — Browse all vectors by domain
- **[TS Runner](./runner-ts.md)** — Run and debug the TypeScript test suite
- **[Contributing Vectors](./contributing-vectors.md)** — Add new test cases
