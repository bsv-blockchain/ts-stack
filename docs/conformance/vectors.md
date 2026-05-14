---
id: conformance-vectors
title: "Vector Catalog"
kind: conformance
version: "1.0.0"
last_updated: "2026-05-14"
last_verified: "2026-05-14"
review_cadence_days: 30
status: stable
tags: [conformance, vectors, catalog]
---

# Vector Catalog

The conformance corpus is the shared test fixture set for TypeScript and other implementations. It is intentionally implementation-neutral: each JSON file defines inputs, expected outputs, metadata, and the specification area it exercises.

Current corpus: **6,625 vectors across 72 JSON files**, last indexed on 2026-05-14 in `conformance/META.json`.

## Repository Layout

```text
conformance/vectors/
  auth/brc31-handshake.json
  broadcast/{arc-submit,merkle-path-validation,merkle-service}.json
  messaging/{authsocket,brc31/authrite-signature,message-box-http}.json
  overlay/{lookup,submit,topic-management}.json
  payments/{brc121,brc29-payment-protocol}.json
  regressions/*.json (12 files)
  sdk/compat/bsm.json
  sdk/crypto/{aes,ecdsa,ecies,hash160,hmac,ripemd160,sha256,signature}.json
  sdk/keys/{key-derivation,private-key,public-key}.json
  sdk/scripts/evaluation.json (5,116 vectors)
  sdk/transactions/{merkle-path,serialization}.json
  storage/uhrp-http.json
  sync/{brc40-user-state,gasp-protocol}.json
  wallet/brc100/*.json (27 files)
  wallet/brc29/payment-derivation.json
  wallet/storage/adapter-conformance.json
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
| `sdk/crypto` + `sdk/keys` | ~140 | AES, ECDSA, ECIES, HMAC, hashes, BRC-42 derivation, PrivateKey/PublicKey |
| `sdk/transactions` | 31 | BRC-62 serialization, BEEF, EF, BRC-74 MerklePath |
| `sdk/scripts` | 5,116 | Full script engine parity (parsing, encoding, sighash, evaluation with SV Node + Teranode fixtures) |
| `sdk/compat` | 9 | BRC-77 BSM |
| `wallet/brc100` | ~950 | Complete WalletInterface coverage across 27 files (many stateful methods marked `intended`) |
| `wallet/brc29` + `wallet/storage` | 45 | BRC-29 derivation + storage adapter conformance |
| `messaging` + `auth` + `overlay` + `broadcast` + `payments` + `storage` + `sync` | ~200 | Full protocol shape validation for BRC-31, BRC-29/121, BRC-62/20/22, BRC-26, GASP, etc. |
| `regressions` | 36 | 12 historical cross-implementation bug reproductions |

## Wallet BRC-100

Current BRC-100 conformance coverage is focused on deterministic crypto and key methods:

| File | Vectors | Methods |
|---|---:|---|
| `wallet/brc100/*.json` (25 files) | 950 | Full `WalletInterface`: getPublicKey, create/verifyHmac/Signature, encrypt/decrypt, revealKeyLinkage*, create/sign/abortAction, listActions, internalizeAction, list/relinquishOutputs, acquire/list/prove/relinquishCertificates, discover*, isAuthenticated, waitForAuthentication, getHeight/Header/Network/Version (100% coverage) |

Use the [BRC-100 wallet method reference](../specs/brc-100-wallet.md) for the full interface shape. Use this catalog to see which parts already have portable fixtures.

## Coverage By BRC

| BRC | Current Vector Areas | Status |
|---|---|---|
| BRC-29 | `wallet/brc29/payment-derivation.json` | available |
| BRC-31 | `messaging/brc31/authrite-signature.json` | available |
| BRC-42 | `sdk/keys/key-derivation.json`, key fixtures | available |
| BRC-74 | `sdk/transactions/merkle-path.json` | available |
| BRC-77 | `sdk/compat/bsm.json` | available |
| BRC-100 | `wallet/brc100/*.json` (25 files) | full (100%) |
| BRC-14 | `sdk/scripts/evaluation.json` | available, including SV Node and Teranode fixtures |

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
5. For node-derived script fixtures, consume the normalized hex fields; original node ASM is retained for provenance.
6. Add new vectors to the corpus first when you find a behavioral ambiguity, then update each runner.
