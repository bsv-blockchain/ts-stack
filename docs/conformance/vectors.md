---
id: conformance-vectors
title: "Vector Catalog"
kind: conformance
version: "1.0.0"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
review_cadence_days: 30
status: stable
tags: [conformance, vectors, catalog]
---

# Vector Catalog

The conformance corpus is the shared test fixture set for TypeScript and other implementations. It is intentionally implementation-neutral: each JSON file defines inputs, expected outputs, metadata, and the specification area it exercises.

Current corpus: **260 vectors across 33 JSON files**, last indexed on 2026-04-28 in `conformance/META.json`.

## Repository Layout

```text
conformance/vectors/
  messaging/brc31/authrite-signature.json
  regressions/*.json
  sdk/compat/bsm.json
  sdk/crypto/{aes,ecdsa,ecies,hash160,hmac,ripemd160,sha256,signature}.json
  sdk/keys/{key-derivation,private-key,public-key}.json
  sdk/scripts/evaluation.json
  sdk/transactions/{merkle-path,serialization}.json
  wallet/brc100/{createhmac,createsignature,encrypt,getpublickey}.json
  wallet/brc29/payment-derivation.json
```

## Vector Format

Vector files use one top-level object with metadata and a `vectors` array. A typical file looks like this:

```json
{
  "metadata": {
    "name": "BRC-100 WalletInterface.getPublicKey",
    "domain": "wallet",
    "spec": "BRC-100",
    "version": "1.0.0"
  },
  "vectors": [
    {
      "id": "brc100-getpublickey-identity",
      "description": "Returns the wallet identity key",
      "input": { "args": { "identityKey": true } },
      "expected": { "publicKey": "..." },
      "tags": ["wallet", "brc100"]
    }
  ]
}
```

Always inspect the target JSON file before porting a vector to another language; some files include fixtures, deterministic keys, expected errors, or protocol-specific notes.

## Coverage By Directory

| Directory | Vector Count | What It Covers |
|---|---:|---|
| `sdk/crypto` | 99 | AES, ECDSA, ECIES, HMAC, hash160, RIPEMD-160, SHA-256, signatures |
| `sdk/keys` | 43 | BRC-42 derivation, private key behavior, public key behavior |
| `sdk/transactions` | 31 | Transaction serialization and BRC-74 merkle paths |
| `sdk/scripts` | 20 | Script evaluation edge cases |
| `sdk/compat` | 9 | BRC-77 BSM compatibility |
| `messaging/brc31` | 4 | Authrite/BRC-31 signatures |
| `wallet/brc29` | 3 | BRC-29 payment derivation |
| `wallet/brc100` | 15 | BRC-100 method fixtures currently available |
| `regressions` | 36 | Reproductions for historical bugs across SDK implementations |

## Wallet BRC-100

Current BRC-100 conformance coverage is focused on deterministic crypto and key methods:

| File | Vectors | Methods |
|---|---:|---|
| `wallet/brc100/getpublickey.json` | 4 | `getPublicKey` |
| `wallet/brc100/createhmac.json` | 4 | `createHmac`, `verifyHmac` |
| `wallet/brc100/createsignature.json` | 4 | `createSignature`, `verifySignature` |
| `wallet/brc100/encrypt.json` | 3 | `encrypt`, `decrypt` |

Use the [BRC-100 wallet method reference](../specs/brc-100-wallet.md) for the full interface shape. Use this catalog to see which parts already have portable fixtures.

## Coverage By BRC

| BRC | Current Vector Areas | Status |
|---|---|---|
| BRC-29 | `wallet/brc29/payment-derivation.json` | available |
| BRC-31 | `messaging/brc31/authrite-signature.json` | available |
| BRC-42 | `sdk/keys/key-derivation.json`, key fixtures | available |
| BRC-74 | `sdk/transactions/merkle-path.json` | available |
| BRC-77 | `sdk/compat/bsm.json` | available |
| BRC-100 | `wallet/brc100/*.json` | partial |

## Regression Fixtures

Regression files reproduce bugs found in TypeScript or other SDKs so new implementations can prove they do not repeat them.

| Regression | Source Issue |
|---|---|
| `beef-v2-txid-panic` | `go-sdk#306` |
| `privatekey-modular-reduction` | `ts-sdk#31` |
| `merkle-path-odd-node` | `go-sdk#298` |
| `uhrp-url-parity` | `go-sdk#310` |
| `script-lshift-truncation` | `ts-sdk#493` |
| `script-shift-endianness` | `ts-sdk#377` |
| `tx-sequence-zero-sighash` | `ts-sdk#371` |
| `script-writebin-empty` | `ts-sdk#336` |
| `script-fromasm-numeric-token` | `ts-sdk#42` |
| `fee-model-mismatch` | `go-sdk#267` |
| `bip276-hex-decode` | `go-sdk#286` |
| `beef-isvalid-hydration` | `go-sdk#167` |

## Running Vectors

Run the complete corpus:

```bash
pnpm conformance
```

Validate JSON structure only:

```bash
pnpm conformance --validate-only
```

Run a directory subset:

```bash
pnpm conformance --vectors conformance/vectors/wallet/brc100
```

Write a JUnit report:

```bash
pnpm conformance --report conformance/runner/reports/results.xml
```

## Porting To Another Implementation

1. Read `conformance/META.json` to confirm the corpus version and current vector list.
2. Start with deterministic SDK vectors before stateful wallet vectors.
3. Treat `wallet/brc100` as method-level fixtures, not as a complete wallet behavior test suite yet.
4. Preserve vector IDs and expected error semantics when adding a runner for another language.
5. Add new vectors to the corpus first when you find a behavioral ambiguity, then update each runner.
