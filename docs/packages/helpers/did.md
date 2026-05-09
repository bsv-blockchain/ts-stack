---
id: pkg-did
title: "@bsv/did"
kind: package
domain: helpers
version: "0.1.0"
source_repo: "bsv-blockchain/ts-stack"
source_commit: "unknown"
last_updated: "2026-05-07"
last_verified: "2026-05-07"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/did"
repo: "https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/did"
status: beta
tags: [did, sd-jwt, credentials, identity, helpers]
---

# @bsv/did

> SD-JWT VC and optional `did:key` helpers for BSV SDK identity keys.

## Install

```bash
npm install @bsv/did
```

## Quick start

```typescript
import { PrivateKey } from '@bsv/sdk'
import { BsvDid, SdJwtVcIssuer, SdJwtVcHolder, SdJwtVcPresenter, SdJwtVcVerifier } from '@bsv/did'

const issuerPrivateKey = PrivateKey.fromRandom()
const holderPrivateKey = PrivateKey.fromRandom()
const issuer = BsvDid.fromPublicKey(issuerPrivateKey.toPublicKey().toDER() as number[])

const vc = await SdJwtVcIssuer.create({
  issuer,
  issuerPrivateKey,
  holderPublicKey: holderPrivateKey.toPublicKey(),
  vct: 'https://credentials.example.com/identity_credential',
  claims: {
    given_name: 'Alice',
    email: 'alice@example.com',
    is_over_21: true
  },
  disclosureFrame: {
    given_name: true,
    email: true,
    is_over_21: true
  }
})

const presentation = await SdJwtVcHolder.generatePresentation(vc, ['is_over_21'], {
  holderPrivateKey,
  audience: 'https://verifier.example',
  nonce: 'nonce-123'
})

const result = await SdJwtVcVerifier.verify(SdJwtVcPresenter.present(presentation), {
  expectedAudience: 'https://verifier.example',
  expectedNonce: 'nonce-123',
  requireKeyBinding: true
})
```

## What it provides

- **BsvDid** — Generate secp256k1 `did:key` identifiers, DID Documents, and QR codes
- **SdJwtVcIssuer** — Issue SD-JWT VCs with salted Disclosures and holder `cnf.jwk`
- **SdJwtVcHolder** — Store credentials and generate selective presentations
- **SdJwtVcPresenter** — Serialize presentation payloads for transport or QR display
- **SdJwtVcVerifier** — Verify issuer signatures, Disclosures, and KB-JWT holder binding

## Algorithm note

BSV identity keys are secp256k1. JOSE identifies secp256k1 ECDSA as `ES256K`; `ES256` is P-256. This package uses `ES256K` for BSV identity-key compatibility.

Some eIDAS/EUDI profiles might require P-256 `ES256`. Those profiles need a P-256 key mode in addition to BSV identity-key mode.

## Standards

- [RFC 9901: Selective Disclosure for JSON Web Tokens](https://www.rfc-editor.org/rfc/rfc9901.html)
- [SD-JWT-based Verifiable Credentials, draft-ietf-oauth-sd-jwt-vc-16](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-sd-jwt-vc)
- [DID Core v1.0](https://www.w3.org/TR/did-core/)
- [did:key Method v0.9](https://w3c-ccg.github.io/did-key-spec/)

## Related packages

- [@bsv/sdk](../sdk/bsv-sdk.md) — Core keys, signatures, and wallet interfaces
- [@bsv/simple](simple.md) — Higher-level wallet-aware app helpers
