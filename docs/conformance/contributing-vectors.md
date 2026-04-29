---
id: conformance-contributing
title: "Contributing Vectors"
kind: conformance
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [conformance, contributing, vectors]
---

# Contributing Conformance Vectors

New test vectors are required for bug fixes to the SDK or wallet packages. This ensures regressions are caught in the future.

## When to Add Vectors

Required for:
- **Bug fixes** — Prevent regression
- **New features** — Define expected behavior
- **Edge cases** — Ensure consistent handling
- **Performance issues** — Benchmark the fix

Optional for:
- Documentation changes
- Refactoring (no behavior change)
- Dependency updates

## Vector Format

Create a JSON file with this schema:

```json
{
  "name": "Test case name",
  "description": "What this tests and why",
  "domain": "sdk/crypto|sdk/keys|wallet/brc100|wallet/brc29|wallet/utxo|messaging/brc31|messaging/authsocket|...",
  "spec": "BRC-100|BRC-31|BRC-29|BRC-42|...",
  "inputs": {
    "field1": "value1",
    "field2": 123,
    "field3": true,
    "field4": {
      "nested": "object"
    }
  },
  "expectedOutput": {
    "result": "expected value",
    "or": "multiple fields"
  },
  "tags": ["happy-path|edge-case|error-handling|performance"],
  "notes": "Optional notes about the test"
}
```

### Required Fields
- `name` — Short, descriptive test name
- `domain` — Which subsystem it tests
- `inputs` — Test input data
- `expectedOutput` — Expected result

### Optional Fields
- `description` — Longer explanation
- `spec` — BRC standard if applicable
- `tags` — Categories (happy-path, edge-case, etc.)
- `notes` — Implementation notes

## File Naming

Use kebab-case, descriptive names:

```
good:
  getPublicKey-happy-path.json
  createAction-no-outputs.json
  brc31-nonce-mismatch.json

bad:
  test1.json
  vector.json
  foo.json
```

## Directory Structure

Place vectors in the appropriate domain directory:

```
conformance/vectors/
  sdk/
    crypto/
      sign-happy-path.json
      sign-invalid-key.json
      verify-good-signature.json
      verify-bad-signature.json
    keys/
      brc42-derivation.json
      bip32-path.json
    transactions/
      ...
  wallet/
    brc100/
      getPublicKey-happy-path.json
      createAction-invalid-outputs.json
    brc29/
      key-derivation.json
    utxo/
      ...
  messaging/
    brc31/
      ...
    authsocket/
      ...
```

## Example: Bug Fix Vectors

When fixing a bug, add vectors that would have caught it.

**Bug**: `createAction` doesn't validate satoshis are positive

**Vector file**: `conformance/vectors/wallet/brc100/createAction-negative-satoshis.json`

```json
{
  "name": "createAction rejects negative satoshis",
  "description": "Ensure createAction validates output satoshis are positive (GH-1234)",
  "domain": "wallet/brc100",
  "spec": "BRC-100",
  "inputs": {
    "walletId": "test-wallet",
    "description": "Test transaction",
    "outputs": [
      {
        "script": "76a91412345678901234567890123456789012345678ab88ac",
        "satoshis": -1000
      }
    ]
  },
  "expectedOutput": {
    "error": "ValidationError",
    "message": "Output satoshis must be positive"
  },
  "tags": ["edge-case", "validation"],
  "notes": "Bug fix for GH-1234: negative satoshis should be rejected"
}
```

## Example: Feature Vectors

When adding a new feature, define its behavior.

**Feature**: Add `getBalance()` method to BRC-100 WalletInterface

**Vector file**: `conformance/vectors/wallet/brc100/getBalance-happy-path.json`

```json
{
  "name": "getBalance returns total wallet balance",
  "description": "New BRC-100 method to get total balance across all keys",
  "domain": "wallet/brc100",
  "spec": "BRC-100",
  "inputs": {
    "walletId": "test-wallet"
  },
  "expectedOutput": {
    "balanceSatoshis": 5000000,
    "unconfirmedSatoshis": 100000,
    "confirmedSatoshis": 4900000
  },
  "tags": ["happy-path", "new-feature"],
  "notes": "New BRC-100 method, PR #456"
}
```

## Running Your New Vectors

### TypeScript
```bash
pnpm conformance conformance/vectors/wallet/brc100/createAction-negative-satoshis.json
```

### Go
```bash
cd conformance/go
go test -v ./wallet/brc100 -run TestCreateActionNegativeSatoshis
```

## Validation

Before committing, validate your vector:

```bash
pnpm conformance:validate conformance/vectors/wallet/brc100/createAction-negative-satoshis.json
```

Checks:
- Valid JSON syntax
- Required fields present
- Domain and tags are recognized
- Input/output structure matches schema

## PR Requirements

When submitting a PR with vector changes:

1. **Add vectors for bug fixes** — Required
2. **Add vectors for new features** — Required
3. **Verify tests pass** — `pnpm conformance` must pass 100%
4. **Run both runners** — TS and Go must both pass
5. **Update vector count** — Update spec pages if new domain

## Vector Coverage Goals

- SDK: 80+ vectors (currently complete)
- Wallet: 90+ vectors (currently complete)
- Messaging: 60+ vectors (currently complete)
- Regressions: 30+ vectors (growing as issues found)

## Troubleshooting

### Vector not running
Check domain is in `conformance/vectors/` directory:

```bash
ls conformance/vectors/wallet/brc100/
```

### Type mismatch errors
Ensure input types match expected types in implementation.

Go is type-strict; use proper types:

```json
{
  "satoshis": 1000,        // number
  "active": true,           // boolean
  "message": "hello",       // string
  "values": [1, 2, 3]      // array
}
```

### Test passes TS but fails Go (or vice versa)
This indicates a compatibility issue. Investigate and fix the implementation.

## Next Steps

- [Vector Catalog](./vectors.md) — Browse existing vectors
- [TS Runner](./runner-ts.md) — Run and debug
- [Go Runner](./runner-go.md) — Run in Go
