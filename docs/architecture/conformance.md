---
id: architecture-conformance
title: Conformance Pipeline
kind: meta
version: "n/a"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
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

The current corpus has **260 vectors across 33 files**:

- `sdk/crypto/` — 99 vectors
- `sdk/keys/` — 43 vectors
- `sdk/transactions/` — 31 vectors
- `sdk/scripts/` — 20 vectors
- `sdk/compat/` — 9 vectors
- `wallet/brc100/` — 15 vectors
- `wallet/brc29/` — 3 vectors
- `messaging/brc31/` — 4 vectors
- `regressions/` — 36 vectors

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
- [BRC Standards Index](../reference/brc-index.md)
