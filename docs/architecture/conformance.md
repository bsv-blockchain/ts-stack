---
id: architecture-conformance
title: Conformance Pipeline
kind: meta
version: 'n/a'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
status: stable
tags: ['architecture', 'conformance', 'cross-language']
---

# Conformance Pipeline

The TypeScript stack is the reference implementation for this repository's portable SDK and wallet behavior. Conformance vectors are the bridge from that implementation to other languages.

## What "Reference" Means

A behavior becomes portable when it is captured as a deterministic JSON vector. Each vector contains inputs, expected outputs, BRC metadata, and stable IDs. A new SDK implementation can read the same file and prove that it produces the same result.

This is most useful for behavior that must match byte-for-byte:

- key derivation and public key generation
- hashes, HMACs, signatures, encryption outputs
- transaction and MerklePath serialization
- BRC-29 payment derivation
- BRC-100 wallet crypto method behavior

## Pipeline Flow

```text
TypeScript reference behavior
        |
        | captured as deterministic fixtures
        v
conformance/vectors/*.json
        |
        +--> Node structural runner
        |    conformance/runner/src/runner.js
        |    validates JSON shape and writes reports
        |
        +--> TypeScript/Jest behavior runner
        |    conformance/runner/ts/runner.test.ts
        |    dispatches supported vectors into @bsv/sdk
        |
        +--> Other language runners
             consume the same JSON corpus and compare outputs
```

Corpus totals and BRC metadata are in `conformance/META.json`; file-level
classifications are generated in `conformance/PARITY_MATRIX.json`.

## Current Coverage

Current totals and structural runner outcomes are generated on
[Generated Stack Facts](../reference/stack-facts.md). The durable coverage
shape is:

| Area                          | Size                                                         | Notes                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk/scripts/evaluation.json` | 5,116 vectors                                                | BRC-14 — Script parsing, encoding, sighash, and full evaluation parity with SV Node + Teranode (normalized hex fixtures)                                                            |
| `wallet/brc100/`              | Method-level corpus                                          | `WalletInterface` crypto, action, output, certificate, discovery, authentication, chain, and network behavior. Stateful gaps are explicitly governed rather than counted as passes. |
| `sdk/crypto/`                 | 8 files                                                      | AES-GCM, ECDSA, ECIES, HMAC, SHA-256, RIPEMD-160, Hash160, Signature                                                                                                                |
| `sdk/keys/`                   | 3 files                                                      | BRC-42 HD derivation, PrivateKey / PublicKey behavior                                                                                                                               |
| `sdk/transactions/`           | 2 files                                                      | MerklePath (BRC-74) + Transaction serialization / BEEF / EF (BRC-62)                                                                                                                |
| `sdk/compat/`                 | 1 file                                                       | BRC-77 BSM compatibility                                                                                                                                                            |
| `regressions/`                | Historical regressions                                       | Cross-SDK bugs with stable IDs and source-issue metadata.                                                                                                                           |
| Protocol domains              | Auth, broadcast, messaging, Overlay, payments, storage, sync | Includes BRC-20/21/22/26/29/31/40/121/136 and related HTTP or message contracts.                                                                                                    |

`pnpm docs:facts:check` rejects drift among metadata, the generated parity
matrix, and the corpus. `pnpm test:governance` separately owns all runner skips
and intended behaviors. A structural vector count is never a claim that all
vectors execute against every implementation.

## Running The Pipeline

Run structural validation and report generation:

```bash
pnpm conformance
```

Run only structural validation:

```bash
pnpm conformance --validate-only
```

Run a subset directory:

```bash
pnpm conformance --vectors conformance/vectors/wallet/brc100
```

Run the TypeScript/Jest dispatcher:

```bash
pnpm --filter @bsv/conformance-runner-ts test
```

## Adding Vectors

When a protocol behavior is added or clarified, add a vector in the same PR as the behavior change. When a bug is fixed, add a regression vector that would have failed before the fix.

See [Contributing Vectors](../conformance/contributing-vectors.md) for the file format and review checklist.

## Related

- [Conformance Testing](../conformance/index.md)
- [Vector Catalog](../conformance/vectors.md)
- **[Porting Guide](https://github.com/bsv-blockchain/ts-stack/blob/main/conformance/PORTING_GUIDE.md)** — Essential reading when aligning another language implementation
- [BRC Standards Index](../reference/brc-index.md)
