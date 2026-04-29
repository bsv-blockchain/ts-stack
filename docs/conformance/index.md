---
id: conformance-overview
title: "Conformance"
kind: meta
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [conformance, testing, cross-language, vectors]
---

# Conformance Testing

Cross-language conformance testing ensures implementations across TypeScript, Go, and other languages follow the same protocol specifications and can interoperate.

## What is Conformance?

Conformance vectors are standardized test cases that define expected behavior for a protocol or interface. By running the same vectors across different language implementations, we verify that:

- Different implementations produce identical outputs
- Edge cases are handled consistently
- Implementations are compatible for interoperability
- Regressions are caught early

## Coverage

The ts-stack includes **260+ conformance vectors** across three domains:

### SDK Vectors (80 vectors)
- Cryptographic signing and verification
- Key derivation (BRC-42)
- Transaction serialization
- Script validation
- Merkle path computation

### Wallet Vectors (90 vectors)
- BRC-100 WalletInterface methods
- BRC-29 peer payment key derivation
- Action creation and signing
- UTXO management
- Encryption/decryption

### Messaging Vectors (60 vectors)
- BRC-31 authentication handshake
- Message formatting and signing
- Nonce exchange
- Replay protection

### Regression Vectors (30 vectors)
- Historical bug fixes
- Edge cases found in production
- Performance benchmarks

## Test Runners

Two runners execute vectors:

- **TypeScript (Jest)** — `pnpm conformance` — full coverage
- **Go** — `go test ./conformance` — core coverage

## Quick Start

Run conformance tests locally:

```bash
# TypeScript
cd /Users/personal/git/ts-stack
pnpm conformance

# Go
cd conformance/go
go test -v ./...
```

## Vector Format

Vectors are JSON files in `conformance/vectors/`:

```json
{
  "name": "BRC-100 getPublicKey happy path",
  "domain": "wallet/brc100",
  "inputs": {
    "derivationKey": "m/44'/0'/0'/0/0",
    "walletId": "wallet-001"
  },
  "expectedOutput": {
    "publicKey": "02a1b2c3d4e5f6..."
  }
}
```

## Results

Both runners produce JSON reports:

```
conformance/results/
  ts-results-2026-04-28.json
  go-results-2026-04-28.json
```

Comparison tool shows differences:

```bash
pnpm conformance:compare ts-results-*.json go-results-*.json
```

## Next Steps

- **[Vector Catalog](./vectors.md)** — Browse all vectors by domain
- **[TS Runner](./runner-ts.md)** — Run and debug in TypeScript
- **[Go Runner](./runner-go.md)** — Run in Go
- **[Contributing Vectors](./contributing-vectors.md)** — Add new test cases
