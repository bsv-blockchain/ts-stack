---
id: architecture-conformance
title: Conformance Pipeline
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["architecture", "conformance", "cross-language"]
---

# Conformance Pipeline

The TypeScript stack is the **canonical reference implementation** for the BSV protocol ecosystem. This page explains how that role works in practice.

## What "Canonical Reference" Means

Every protocol operation that the TS SDK performs is expressed as a JSON test vector: a structured record of inputs and the expected outputs that a correct implementation must produce. These vectors are committed to `conformance/vectors/` and represent the ground truth for the protocol.

Other language implementations (Go, Python, Rust) validate their own correctness by running the same vectors and comparing outputs. A divergence indicates a protocol-level incompatibility.

This means:

- A transaction built by a Go wallet is guaranteed to be valid to a TypeScript overlay
- A BEEF encoded by a Rust implementation is guaranteed to parse in TypeScript
- Key derivation in Python produces identical keys to key derivation in TypeScript

## Pipeline Flow

```
TypeScript SDK (canonical)
        │
        │  produces
        ▼
conformance/vectors/*.json
        │
        ├──► TypeScript Jest runner  (conformance/runner/ts/runner.test.ts)
        │         validates TS SDK against its own vectors
        │
        ├──► Go runner               (bsv-blockchain/go-sdk, consuming these vectors)
        │         validates Go SDK
        │
        ├──► Python runner           (planned)
        │
        └──► Rust runner             (planned)
```

All runners consume the same vector corpus from this repository (via sparse checkout or published artifact). A passing run means the implementation is protocol-compatible with TypeScript.

## Vector Format

Each vector is a JSON file at `conformance/vectors/<domain>/<operation>.json`, validated against `conformance/schema/vector.schema.json` (JSON Schema 2020-12):

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
    "publicKey": "02a1b2c3d4e5f6..."
  }
}
```

The corpus metadata is in `conformance/META.json`: total vectors, BRC coverage map, regression index.

## Coverage

260 vectors across 33 files, organized by domain:

- `sdk/keys/` — BRC-42 key derivation
- `sdk/crypto/` — Signatures and hashing
- `sdk/transactions/` — BRC-74 Merkle paths
- `sdk/scripts/` — Script interpreter edge cases
- `sdk/compat/` — BRC-77 Bitcoin Signed Message compatibility
- `wallet/brc100/` — `getPublicKey`, `createHmac`, `createSignature`, `encrypt`
- `wallet/brc29/` — BRC-29 payment key derivation
- `messaging/brc31/` — BRC-31 authrite signature format
- `regressions/` — 12 historical bugs fixed across TS and Go implementations

## Running the TypeScript Suite

```bash
# From the repo root
pnpm conformance
```

Runs `conformance/runner/ts/runner.test.ts` via Jest. Reports land in `conformance/runner/reports/`.

## Adding Vectors

See [Contributing Vectors](../conformance/contributing-vectors.md). The general principle: when a new protocol behavior is added to the TS SDK, a vector must accompany it. Cases pending vectorization are tracked in `conformance/REGRESSION_QUEUE.md`.

## Language Implementations

| Language | Status | Repository |
|----------|--------|------------|
| TypeScript | Reference (canonical) | `bsv-blockchain/ts-stack` |
| Go | Available, runner migrating to go-sdk repo | `bsv-blockchain/go-sdk` |
| Python | Planned | — |
| Rust | Planned | — |

## Related

- [Conformance Testing](../conformance/index.md) — Detailed runner docs
- [BRC Standards Index](../reference/brc-index.md) — What each BRC covers in the conformance corpus
