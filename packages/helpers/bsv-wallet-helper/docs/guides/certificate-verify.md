# Verifying BSV Certificates

> **Related:** [Nonce Verification (Proof of Key Ownership)](./nonce-verify.md) — certificate verification and nonce verification work together to form a complete auth security model. Certificate verification proves a credential was legitimately issued; nonce verification proves the requester currently holds the private key behind it.

## Overview

The `Certificate` class from `@bsv/sdk` provides a `verify()` method that checks a certifier's cryptographic signature over certificate fields. Use this pattern when you need to confirm that a certificate was legitimately issued by a trusted certifier and belongs to the identity key presented by the caller.

## Three Checks in Order

When a certificate is present in a request, run the following checks before any business logic:

### Check 1 — Subject matches the claimed identity

```ts
if (certificate.subject !== identityKey) {
    return 401; // Certificate subject does not match identity key
}
```

Ensures the certificate belongs to the identity key the caller claims to own. Rejects mismatches immediately — cheap string comparison, no crypto required.

### Check 2 — Certifier is trusted

```ts
const TRUSTED_CERTIFIER_KEY = '...'; // your trusted certifier's compressed public key hex

if (certificate.certifier !== TRUSTED_CERTIFIER_KEY) {
    return 401; // Certificate was not issued by a trusted certifier
}
```

Rejects certificates issued by any other party before performing any cryptographic work.

### Check 3 — Cryptographic signature is valid

```ts
import { Certificate } from '@bsv/sdk';

const cert = new Certificate(
    certificate.type,
    certificate.serialNumber,
    certificate.subject,
    certificate.certifier,
    certificate.revocationOutpoint,
    certificate.fields,
    certificate.signature,
);
const valid = await cert.verify();
if (!valid) {
    return 401; // Certificate signature is invalid
}
```

Constructs a `Certificate` instance and calls `cert.verify()`, which validates the certifier's ECDSA signature over the certificate data. An attacker cannot forge this without the certifier's private key.

## Security Guarantee

An attacker presenting a certificate alongside an identity key must pass all three checks:

| Check | What it prevents |
|---|---|
| Subject = identityKey | Using someone else's certificate for your own key |
| Certifier = TRUSTED_CERTIFIER_KEY | Certificates issued by an untrusted certifier |
| Signature valid | Tampered or entirely fabricated certificate data |

All three checks must pass before the certificate is treated as trusted.
