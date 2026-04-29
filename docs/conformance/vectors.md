---
id: conformance-vectors
title: "Vector Catalog"
kind: conformance
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [conformance, vectors, catalog]
---

# Vector Catalog

Browse conformance vectors by domain and specification.

## Vector Format

Each vector is a JSON file with this schema:

```json
{
  "name": "Test case name",
  "description": "What this tests",
  "domain": "sdk/crypto|sdk/keys|wallet/brc100|messaging/brc31|...",
  "spec": "BRC-100|BRC-31|BRC-29|...",
  "inputs": {
    "field1": "value1",
    "field2": "value2"
  },
  "expectedOutput": {
    "result": "expected value"
  },
  "tags": ["happy-path|edge-case|error-handling"]
}
```

## SDK Vectors (80 total)

### Cryptography (sdk/crypto) — 30 vectors
ECDSA signatures, hashing, verification

Location: `conformance/vectors/sdk/crypto/`

- Happy path: Sign and verify message
- Deterministic nonces: Same signature for same input
- Invalid signatures: Rejection of bad signatures
- Edge cases: Empty message, max size message
- Performance: Bulk signing

### Key Derivation (sdk/keys) — 25 vectors
BRC-42 and BIP-32 key paths

Location: `conformance/vectors/sdk/keys/`

- BRC-42 derivation: Public/private key derivation
- BIP-32 paths: m/44'/0'/0'/0/0 style paths
- Hardened keys: ' suffix behavior
- Key matching: Public key from private
- Error handling: Invalid path strings

### Transactions (sdk/transactions) — 15 vectors
Transaction serialization and deserialization

Location: `conformance/vectors/sdk/transactions/`

- UTXO format: Input/output structures
- Script types: P2PKH, P2PK, custom
- Serialization: Hex encoding/decoding
- Large transactions: Multiple inputs/outputs
- Validation: Bad format detection

### Merkle Paths (sdk/merkle) — 10 vectors
Merkle proof computation and verification

Location: `conformance/vectors/sdk/merkle/`

- Path computation: Leaf to root proof
- Path verification: Root matching
- Multiple transactions: Batch proofs
- Edge cases: Single-leaf tree

## Wallet Vectors (90 total)

### BRC-100 Interface (wallet/brc100) — 50 vectors
WalletInterface method behavior

Location: `conformance/vectors/wallet/brc100/`

- getPublicKey: Key retrieval
- createAction: Transaction building
- signAction: Signing behavior
- encrypt/decrypt: Encryption round-trips
- createHmac: Authentication codes
- Determinism: Same inputs = same outputs
- Error handling: Invalid parameters

### BRC-29 Peer Payment (wallet/brc29) — 20 vectors
Payment key derivation

Location: `conformance/vectors/wallet/brc29/`

- Key derivation: Nonce-based derivation
- Determinism: Both parties same key
- Different nonces: Different outputs
- Edge cases: Null nonces, max nonces

### UTXO Management (wallet/utxo) — 15 vectors
UTXO tracking and spending

Location: `conformance/vectors/wallet/utxo/`

- UTXO selection: Change calculation
- Spending: Mark as spent
- Double spend prevention
- Balance calculation

### Action Signing (wallet/actions) — 5 vectors
Transaction action workflow

Location: `conformance/vectors/wallet/actions/`

- Create and sign flow
- Multiple signatures
- Action state transitions

## Messaging Vectors (60 total)

### BRC-31 Auth (messaging/brc31) — 15 vectors
Mutual authentication protocol

Location: `conformance/vectors/messaging/brc31/`

- Handshake completion: Full auth flow
- Signature validation: Correct signatures only
- Nonce exchange: Fresh nonces required
- Replay protection: Same nonce rejected
- Timing: Timestamp validation

### Authsocket (messaging/authsocket) — 20 vectors
WebSocket authentication

Location: `conformance/vectors/messaging/authsocket/`

- Connection handshake
- Message framing
- Signature verification
- Connection state

### Message Box (messaging/messagebox) — 15 vectors
Encrypted message storage

Location: `conformance/vectors/messaging/messagebox/`

- Send message: Happy path
- Receive message: Retrieval
- Encryption: Round-trip
- Metadata: Correct structure

### Paymail (messaging/paymail) — 10 vectors
Paymail protocol compliance

Location: `conformance/vectors/messaging/paymail/`

- Discovery: Getting payment address
- Payment capability: Output generation
- Error handling: Invalid requests

## Regression Vectors (30 total)

Historical bugs and fixes

Location: `conformance/vectors/regressions/`

- Bug ID tracking (e.g., `CVE-2026-1234`)
- Reproduction case
- Fix verification
- Performance benchmarks

## Coverage by BRC

| BRC | Vectors | Status |
|-----|---------|--------|
| BRC-29 | 20 | Stable |
| BRC-31 | 15 | Stable |
| BRC-42 | 25 | Stable |
| BRC-74 | 10 | Stable |
| BRC-100 | 50 | Stable |
| BRC-121 | 5 | Stable |
| Other | 80 | Stable |

## Running Vectors

### Select domain
```bash
pnpm conformance --domain wallet/brc100
pnpm conformance --domain sdk/crypto
```

### Filter by tag
```bash
pnpm conformance --tag happy-path
pnpm conformance --tag edge-case
```

### Specific file
```bash
pnpm conformance conformance/vectors/wallet/brc100/getPublicKey.json
```

## Vector Structure in Repository

```
conformance/vectors/
  sdk/
    crypto/
      sign-happy-path.json
      sign-deterministic.json
      verify-invalid-signature.json
    keys/
      brc42-derivation.json
      bip32-paths.json
    transactions/
      utxo-format.json
  wallet/
    brc100/
      getPublicKey-happy-path.json
      createAction-with-outputs.json
    brc29/
      key-derivation.json
    utxo/
      selection.json
  messaging/
    brc31/
      handshake-complete.json
      nonce-exchange.json
    authsocket/
      websocket-handshake.json
  regressions/
    cve-2026-1234.json
```

## Adding New Vectors

See [Contributing Vectors](./contributing-vectors.md) for detailed instructions on adding test cases.
