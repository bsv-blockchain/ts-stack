---
id: identity-did-vc-migration
title: 'Identity, DID and credential migration'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: experimental
tags: [identity, did, credentials, migration]
---

# Identity, DID and credential migration

This is a coordinated source proposal. SDK 3.0.0 removes public legacy DID-token
exports; overlay-topics 2.0.0 removes the serial DID overlay; DID 0.3.0 and Simple
0.7.0 change their pre-1.0 contracts. Publication and service deployment require
separate reviewed release decisions. Proposed BRC dependencies and registration
limits are pinned in [integration guidance](identity-did-vc.md).

| Retired API or component                                                                                                      | Replacement and migration                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@bsv/did-client`, `DIDClient`, serial-number `did:bsv` token mint/resolve/revoke                                             | `BsvDid.fromPublicKey(identityKey)` and `BsvDid.resolve(did)` from `@bsv/did`; resolution is deterministic and offline. This changes identifier meaning; do not mechanically relabel a legacy serial DID.                                                                                                                        |
| `DIDTopicManager`, `DIDLookupService`, storage/query types and `tm_did`/`ls_did`                                              | Remove registration and clients. Use existing BRC189 `tm_identity`/`ls_identity` certificate discovery only when explicitly configured and qualified. A DID document is derived from its identity key; overlay responses never amend it or automatically confer trust.                                                           |
| SDK `DID_TOKEN_PROTOCOL`, `MAX_DID_SERIAL_BYTES`, `normalizeDIDSerialNumber`, `decodeCanonicalDIDToken`, `CanonicalDIDToken`  | Removed without a codec alias: legacy token structure cannot establish issuer/subject identity. Existing valid certificate and identity primitives remain.                                                                                                                                                                       |
| Simple `DID.create`, lifecycle/query/provider/proxy APIs, `DIDError`, resolver configuration/types and remote server handlers | `DID.fromIdentityKey` returns the canonical DID string; `DID.resolve` returns a resolution result; `wallet.getDID` returns the immutable identity-key document. Mutable lifecycle operations have no equivalent; select a new key/DID under separately authenticated application policy.                                         |
| `toVerifiableCredential`, `toVerifiablePresentation`, copied `proof` wrappers                                                 | `exportBRC52Envelope(originalBinary)` preserves authentic original BRC52 bytes/ciphertext/signature. No second credential signature, plaintext claim copy, or invented issuance date.                                                                                                                                            |
| Structured certificates without original bytes                                                                                | `exportBRC52StructuredCertificate(core)` is an explicit compatibility path. It exports only if SDK serialization verifies the existing signature; historical field ordering may require recovering the original bytes. Never re-sign to disguise incompatibility.                                                                |
| Simple `CredentialIssuer.issue` returning a generic wrapper                                                                   | Returns `{ credential, keyringForSubject }`; keep acquisition keys separate and private. `issueCertificate` remains available for native certificate delivery.                                                                                                                                                                   |
| Simple `CredentialIssuer.verify(object)` boolean-style reliance                                                               | Pass the actual JSON string or UTF-8 transport. Inspect the structured `BRC52VerificationResult`; then independently apply issuer/schema/purpose, holder control, freshness, authorization and status policy.                                                                                                                    |
| Simple HTTP verifier receiving `{ credential: parsedEnvelope }`                                                               | Send `{ credential: originalEnvelopeJson }`. Preserve the original envelope text as a string; duplicate envelope members must reach the strict verifier unchanged. The Web request reader rejects duplicate request members and invalid UTF-8. Custom parsed-body adapters must establish strict request decoding independently. |
| Local missing-revocation-secret inferred as revoked                                                                           | `getRevocationRecordStatus` is only `retained`/`unknown`. Chain status comes from `evaluateBRC52Status`, with disabled/unknown/revoked/notRevokedAsOf distinctions and explicit source/time/evidence policy.                                                                                                                     |
| Uncompressed or normalized identity public-key input                                                                          | Supply the exact 33-byte canonical compressed secp256k1 identity key. Resolution rejects malformed/noncanonical points and external document/service overrides.                                                                                                                                                                  |

## Before and after

```ts
// Before: serial-token authority and unsigned wrapper claims were misleading.
// const client = new DIDClient(wallet)
// const document = await client.resolve(serialNumber)
// const vc = toVerifiableCredential(certificate)
```

```ts
import { BsvDid } from '@bsv/did'
import { exportBRC52Envelope, verifyBRC52Envelope } from '@bsv/did/brc52'

// These inputs are obtained through your existing native certificate/key path.
const did = BsvDid.fromPublicKey(identityPublicKey)
const resolution = BsvDid.resolve(did)
const envelope = exportBRC52Envelope(originalCertificateBytes)
const result = verifyBRC52Envelope('application/json', JSON.stringify(envelope))
if (!result.verified) throw new Error(result.errors.join('; '))
// Decide trust and reliance separately before using any disclosed information.
```

The exact-tarball [compiled examples](compiled-package-examples.md) provide
executable offline variants. SD-JWT remains available under its own explicitly
named issuer/holder/presenter/verifier APIs. It is a distinct signed format and
cannot replace an original BRC52 signature through a silent conversion.

## Existing records, privacy and rollback

The source retirement removes no persisted database rows, issued credentials,
private keys, revocation secrets, or on-chain records. Operators must separately
inventory legacy clients/services and retained records; archive or stop obsolete
service registration under their own operational change process. Do not advertise
that old serial identifiers have become identity-key DIDs. Preserve application
mappings only as separately authenticated assertions with their own consent and
provenance. Keep old immutable npm releases available for deliberate rollback;
never unpublish to simulate migration.

A stable identity-key DID and certificate serial/outpoint/ciphertext are
correlators. BRC52 selected-field keyrings and authenticated control are not zero
knowledge, unlinkability, or automatic mutable identity continuity. Do not query
an issuer for status on every presentation. Configure a local or protected batched
status adapter with explicit evidence validation, confirmation and reorganization
rules, and disclose residual third-party correlation. `unknown` and disabled status
are not assertions that a credential is current or trusted.

First-party SDK consumers should retain their supported SDK2 peer floor and add
SDK3 after qualifying the new advertised SDK3 contract and retained SDK2 consumer
behavior. Preserve and report immutable reference-version failures explicitly. Changing a packed peer manifest needs
its own candidate version, but does not justify dropping a working SDK2 contract.
Active wallet/overlay additive candidates must be reconciled with this separate
major proposal before release; source branch numbers and snapshots are not an
approved cascade publication plan.

## Compatibility evidence and known reference limits

The offline consumer matrix uses immutable published SDK2.8.11 and the isolated
SDK3 candidate with normal npm peer resolution and lifecycle scripts disabled.
All 1,661 advertised Node runtime entries and strict ESM/CommonJS declarations
pass for SDK3. SDK2.8.11 retains nine pre-existing cold-import failures: the two
BasePoint/JacobianPoint leaf spellings in ESM/CommonJS and native ESM `./umd`.
Its other 1,646 runtime imports, strict declarations and exact documentation
examples pass. Published SDK2 bytes are not patched or represented as entirely
green; the separate SDK2.9 program remains independently owned.

Both matrices compile all nine actual governed example fences and execute the
offline identity/original-envelope examples. SDK3's corrected leaf initialization
is retained by both browser bundlers; the final packed classic/global/module
fixtures pass all 21 cases in a real Chromium browser. The two-family Metro and
Hermes builds also pass their existing budgets. This samples SDK2.8.11 rather
than every historical peer-floor version and does not qualify a physical mobile
wallet, a deployed provider, complete external interoperability or W3C registry
conformance. Hosted exact-head checks remain a separate qualification step.
