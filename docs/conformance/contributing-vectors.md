---
id: conformance-contributing
title: "Contributing Vectors"
kind: conformance
version: "1.0.0"
last_updated: "2026-05-14"
last_verified: "2026-05-14"
review_cadence_days: 30
status: stable
tags: [conformance, contributing, vectors]
---

# Contributing Conformance Vectors

Add vectors when a behavior must be portable across SDKs, wallets, or language implementations. Bug fixes should include a regression vector whenever the bug can be reproduced with deterministic inputs.

## When To Add Vectors

Required:

- bug fixes that affect serialized output, cryptography, keys, scripts, transactions, wallet method behavior, or BRC behavior
- new protocol features
- edge cases that other languages are likely to implement independently
- clarified behavior where previous docs/specs were ambiguous

Usually unnecessary:

- documentation-only changes
- internal refactors with no behavior change
- dependency updates that do not change public behavior

## File Format

Every vector file is a JSON object with metadata and a `vectors` array:

```json
{
  "$schema": "../../../schema/vector.schema.json",
  "id": "wallet.brc100.getpublickey",
  "name": "BRC-100 WalletInterface.getPublicKey",
  "brc": ["BRC-100"],
  "version": "1.0.0",
  "reference_impl": "ts-sdk@2.0.14",
  "parity_class": "required",
  "vectors": [
    {
      "id": "wallet.brc100.getpublickey.1",
      "description": "identityKey=true returns the wallet identity key",
      "input": {
        "root_key": "0000000000000000000000000000000000000000000000000000000000000001",
        "args": { "identityKey": true }
      },
      "expected": {
        "publicKey": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
      },
      "tags": ["happy-path", "brc-100", "identity"]
    }
  ]
}
```

Use `input` and `expected`, not `inputs` and `expectedOutput`.

## Naming Rules

File-level IDs use dot-separated namespaces:

```text
sdk.crypto.ecdsa
sdk.keys.key-derivation
wallet.brc100.getpublickey
wallet.brc29.payment-derivation
```

Vector IDs should be stable and unique within the file. Existing IDs should not be renamed after publication.

## Directory Selection

Use an existing directory where possible. Current layout (as of 2026-05-14):

```text
conformance/vectors/
  auth/brc31-handshake.json
  broadcast/*.json
  messaging/{authsocket,brc31/,message-box-http}.json
  overlay/{lookup,submit,topic-management}.json
  payments/{brc121,brc29-payment-protocol}.json
  regressions/ (12 files — special format with regression.issue metadata)
  sdk/compat/bsm.json
  sdk/crypto/ (8 files: aes, ecdsa, ecies, hash160, hmac, ripemd160, sha256, signature)
  sdk/keys/ (3 files)
  sdk/scripts/evaluation.json (5,116 vectors)
  sdk/transactions/ (2 files)
  storage/uhrp-http.json
  sync/ (2 files)
  wallet/brc100/ (27 files)
  wallet/brc29/
  wallet/storage/
```

**All new vectors must follow the modern format** defined in `VECTOR-FORMAT.md` (`$schema`, `brc` as array, `parity_class` one of `required`/`intended`/`best-effort`/`unsupported`). Legacy-format files were normalized in May 2026; new contributions should not reintroduce the old shape.

Create a new directory only when the behavior does not fit an existing domain. If you add a new file, update `conformance/META.json` in the same PR.

## Adding A Vector To An Existing File

1. Open the relevant JSON file.
2. Append a new object to the `vectors` array.
3. Use deterministic test inputs only.
4. Generate the expected value from the reference TypeScript implementation.
5. Add tags that explain the BRC, method, and case type.
6. Run validation:

```bash
pnpm conformance --validate-only
```

7. If the TypeScript/Jest runner supports the category, run:

```bash
pnpm --filter @bsv/conformance-runner-ts test
```

## Adding A Regression Vector

Regression vectors live under `conformance/vectors/regressions/`. Include enough metadata in the file to explain:

- the original issue or bug ID
- the previous incorrect behavior
- the expected fixed behavior
- the BRC or subsystem affected

Then update the `regression_index` in `conformance/META.json`.

## Review Checklist

- The vector can be understood without reading implementation code.
- All binary values use the encoding already used by that vector file.
- No production private keys, mnemonics, credentials, or funded keys are included.
- The vector ID and file ID are stable.
- `pnpm conformance --validate-only` passes.
- The relevant package tests or TypeScript/Jest conformance runner pass when applicable.
