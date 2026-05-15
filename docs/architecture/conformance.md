---
id: architecture-conformance
title: Conformance Pipeline
kind: meta
version: "n/a"
last_updated: "2026-05-14"
last_verified: "2026-05-14"
review_cadence_days: 30
status: stable
tags: ["architecture", "conformance", "cross-language"]
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

The corpus metadata is in `conformance/META.json`: file count, vector count, BRC coverage, and regression index.

## Current Coverage

The current corpus (as of 2026-05-14) contains **6,625 vectors across 72 JSON files**:

| Area                        | Size                          | Notes |
|-----------------------------|-------------------------------|-------|
| `sdk/scripts/evaluation.json` | 5,116 vectors                | BRC-14 — Script parsing, encoding, sighash, and full evaluation parity with SV Node + Teranode (normalized hex fixtures) |
| `wallet/brc100/`            | 27 files, ~950 vectors        | Full `WalletInterface` (getPublicKey, create/verify HMAC+Signature, encrypt/decrypt, key linkage, create/sign/abortAction, listActions/Outputs, certificates, discover*, state methods). Many stateful success paths are marked `intended` pending funded mock-chain harness. |
| `sdk/crypto/`               | 8 files                       | AES-GCM, ECDSA, ECIES, HMAC, SHA-256, RIPEMD-160, Hash160, Signature |
| `sdk/keys/`                 | 3 files                       | BRC-42 HD derivation, PrivateKey / PublicKey behavior |
| `sdk/transactions/`         | 2 files                       | MerklePath (BRC-74) + Transaction serialization / BEEF / EF (BRC-62) |
| `sdk/compat/`               | 1 file                        | BRC-77 BSM compatibility |
| `regressions/`              | 12 files, 36 vectors          | Historical cross-SDK bugs (go-sdk#306, ts-sdk#31, etc.). Special regression format with `regression.issue` metadata. |
| Protocol domains            | ~15 files                     | auth (BRC-31), broadcast (ARC + Merkle service), messaging (authsocket + message-box), overlay (submit/lookup/topic mgmt), payments (BRC-29/121), storage (UHRP), sync (GASP + BRC-40) |

`conformance/META.json` is the single source of truth for exact file counts, vector counts, and the `brc_coverage` mapping. The corpus was recently cleaned up (legacy format files normalized, regression handling improved in the structural runner) to make it a reliable contract for new language implementations.

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
- **[Porting Guide](../conformance/PORTING_GUIDE.md)** — Essential reading when aligning another language implementation
- [BRC Standards Index](../reference/brc-index.md)
