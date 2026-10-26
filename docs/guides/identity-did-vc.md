---
id: identity-did-vc
title: 'Identity, DIDs and Signature-Preserving Credentials'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: experimental
tags: [guide, identity, did, certificates, privacy, brc-189, brc-202, brc-203]
---

# Integrate identity, DIDs and encrypted credentials

Use a wallet's identity key as the common reference across authenticated peer
exchange, attributed certificates, public discovery and the proposed DID/VC
adapters. Keep each layer's evidence and authority visible. Encoding a key,
finding a public certificate and accepting an issuer's claim are separate steps.

This guide describes draft implementation support in TS Stack. It does not
install an overlay, appoint a certifier, issue a credential, publish attributes
or change a provider's configuration. Package publication and service deployment
are separate operations. Existing BRC-52/BRC-100 applications continue to use
their certificate and wallet interfaces.

## Specification revisions and dependencies

The implementation targets these reviewed proposal revisions, rather than an
unqualified moving `master` reference:

| Proposal                                                                           | Reviewed revision                                                                                                                                       | Role                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [BRC-189 / PR 282](https://github.com/bsv-blockchain/BRCs/pull/282)                | [`cd0142441b3d2ed6744445f1d1b535c68103f603`](https://github.com/bsv-blockchain/BRCs/blob/cd0142441b3d2ed6744445f1d1b535c68103f603/wallet/0189.md)       | Identity discovery, public revelation and personal trust |
| [BRC-200 / PR 286](https://github.com/bsv-blockchain/BRCs/pull/286)                | [`a8d878357103108c1599a4f48ae45f8a1a0ea59a`](https://github.com/bsv-blockchain/BRCs/blob/a8d878357103108c1599a4f48ae45f8a1a0ea59a/peer-to-peer/0200.md) | Certifier operating practices                            |
| [BRC-201 / PR 287](https://github.com/bsv-blockchain/BRCs/pull/287)                | [`1b09f71b65f889b266ee287d46466c5a36cc8624`](https://github.com/bsv-blockchain/BRCs/blob/1b09f71b65f889b266ee287d46466c5a36cc8624/peer-to-peer/0201.md) | Existing Email, X and Discord type semantics             |
| [BRC-202 / PR 288](https://github.com/bsv-blockchain/BRCs/pull/288)                | [`d4cc8a186cb354d689287387c36c86d2458bc3db`](https://github.com/bsv-blockchain/BRCs/blob/d4cc8a186cb354d689287387c36c86d2458bc3db/peer-to-peer/0202.md) | Immutable identity-key `did:key` profile                 |
| [BRC-203 / PR 289](https://github.com/bsv-blockchain/BRCs/pull/289)                | [`ff78f14d997d3c90fbb2cc501750c301e903875c`](https://github.com/bsv-blockchain/BRCs/blob/ff78f14d997d3c90fbb2cc501750c301e903875c/peer-to-peer/0203.md) | Signature-preserving encrypted certificate envelope      |
| [Foundation corrections / PR 290](https://github.com/bsv-blockchain/BRCs/pull/290) | [`61404d6aaa55d698a975a967495488f74c622d18`](https://github.com/bsv-blockchain/BRCs/tree/61404d6aaa55d698a975a967495488f74c622d18)                      | Proposed BRC-2/29/52/69 clarifications                   |

These are proposals; the foundation corrections remain unmerged dependencies.
BRC-203 depends on BRC-202 and the proposed BRC-52/BRC-2 serialization and
encryption clarifications. Recheck compatibility when a proposal changes. A
source implementation or a passing local vector does not establish adoption by
other implementations or live service conformance.

The VC vocabulary, custom securing mechanism and outpoint status type are
proposed and unregistered. The W3C VC Data Model v2.0 is a Recommendation; this
BRC mechanism does not acquire W3C endorsement, registration or complete
conformance merely by expressing its graph in that model. Generic Data Integrity,
JOSE, COSE, SD-JWT and status-list verifiers require their own formats and cannot
automatically verify this envelope.

## Choose the evidence needed for an operation

| Question                                      | Evidence and API                                                                              | Limit                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Which public key does this DID encode?        | `BsvDid.fromPublicKey`, `resolve`, `resolveRepresentation`, `dereference`                     | No live control, names, history or issuer trust                             |
| Which key is the current peer?                | Fresh operation-bound BRC-103 authentication; BRC-104 for HTTP                                | Authentication alone does not establish informed consent or truth of claims |
| Who signed these encrypted certificate facts? | `exportBRC52Envelope`, `verifyBRC52Envelope`                                                  | Integrity and attribution, without application reliance                     |
| Which fields may this verifier read?          | `produceBRC52Disclosure`, `receiveBRC52Disclosure` with wallet permissions and relying policy | Plaintext remains a separate disclosure result                              |
| What public assertions can describe a key?    | BRC-100 discovery; `tm_identity` / `ls_identity`                                              | Discovery is neither live authentication nor current certificate status     |
| May this claim authorize this operation now?  | Issuer/schema/purpose policy, status evidence and freshness                                   | A valid signature or familiar badge is insufficient                         |

## Obtain and resolve the identity-key DID

A wallet application obtains the identity key through
`getPublicKey({ identityKey: true })`. Use that identity key, rather than a child
key, address, transaction ID or certificate serial. `BsvDid.fromPublicKey`
requires a valid 33-byte compressed secp256k1 key. It encodes `e7 01 || key` as
canonical base58btc with prefix `did:key:z`; this is multicodec encoding, not
Bitcoin CompactSize or an address checksum.

This offline example uses a public test key with a known private scalar:

```ts
import { BsvDid, verificationMethodForDid } from '@bsv/did'

const identityKey = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const did = BsvDid.fromPublicKey(identityKey)
const resolved = BsvDid.resolve(did)
const representation = BsvDid.resolveRepresentation(did, {
  accept: 'application/did+ld+json'
})
const verificationMethod = BsvDid.dereference(verificationMethodForDid(did))

if (resolved.didDocument === null) throw new Error('Unsupported or invalid DID')
```

The document is deterministic, with one `Multikey` method and authentication,
assertion, capability invocation and capability delegation references to that
method. It has no `keyAgreement`, service endpoint, certified name, trust score,
network or creation history. Discovery must not enrich this document with new
issuer-secured claims. Resolution makes no network request and does not fetch
replacement contexts or remote documents.

`resolve` reports `invalidDid`, `methodNotSupported` or
`representationNotSupported` through metadata and a null document. Only the
exact verification-method fragment can be dereferenced. `update`, `rotate`,
`recover` and `deactivate` return `operationNotSupported`. A new identity key
creates a new DID. Certificate revocation does not make that DID stop resolving;
matching names do not establish continuity between different keys.

## Export and verify an existing certificate

Prefer the original signed `CertificateBinary`. Preserve its field order,
UTF-8 bytes, Base64 field text and DER signature. BRC-52's historical TypeScript
serializer used host-dependent `localeCompare`; a bytewise sort, JSON
stringification or Unicode normalization can change the preimage. If storage
retains only structured data, `exportBRC52StructuredCertificate` permits export
only when the local serialization verifies under the existing signature. Failure
requires recovering authentic source evidence, rather than silently re-signing.

```ts
import { exportBRC52Envelope, verifyBRC52Envelope } from '@bsv/did/brc52'

export function inspectExistingCertificate(originalCertificateBinary: Uint8Array) {
  const envelope = exportBRC52Envelope(originalCertificateBinary)
  const payload = new TextEncoder().encode(JSON.stringify(envelope))
  const result = verifyBRC52Envelope('application/json', payload)
  if (!result.verified || result.verifiedDocument === null) {
    throw new Error(result.errors.join('; '))
  }
  return { payload, verifiedDocument: result.verifiedDocument }
}
```

Transport uses `application/json`. The envelope contains the exact profile,
canonical Base64 original signed binary and the closed computed encrypted graph;
an optional `disclosure` carries a separate verifier keyring. Successful
verification returns `mediaType: 'application/vc'` and only the computed graph
as `verifiedDocument`; failure returns false, null document and errors. Display
that verified result, rather than the incoming graph.

The verifier parses and authenticates the exact retained unsigned prefix using
the BRC-derived certificate signing key and `[2, 'certificate signature']`,
with key ID `type + ' ' + serialNumber` and certifier counterparty semantics.
The issuer root key is not the certificate's direct ECDSA verification key.
There is no new issuer signing operation, JOSE conversion or embedded
`DataIntegrityProof`.

The graph identifies the issuer and subject through their identity-key DIDs,
retains the complete encrypted field map, type, serial and signed outpoint, and
uses fixed locally interpreted contexts. Added plaintext, dates, network names,
provider URLs or alternative contexts fail graph matching. No universal issuance
date or expiry can be inferred from the core.

Current limits are 65536 certificate bytes, 262144 JSON bytes, 256 fields,
50 UTF-8 bytes per field name and 16384 bytes per encoded field value. A verifier
keyring ciphertext is exactly 80 decoded bytes: 32-byte IV, encrypted 32-byte
field revelation key and 16-byte tag. Oversized, duplicate, malformed or
noncanonical input fails; input is not truncated.

## Authorize and receive selected fields

`produceBRC52Disclosure` takes original certificate bytes, a wallet implementing
`getPublicKey` and `proveCertificate`, a receiving verifier identity key, a
purpose, selected fields and an `authorize` callback. The callback must obtain
informed permission for that exact recipient, purpose and selection before any
wallet operation. The producer verifies the core, checks the wallet identity
equals its subject, calls BRC-100 `proveCertificate`, and rejects substituted
certificates, recipient changes or additional/missing selected keys. The trusted
wallet must validate its applicable stored master keyring. No master keyring is
exported by this adapter.

Send the complete exact returned envelope within a fresh BRC-103 authenticated
application payload with the receiving verifier; use BRC-104 for HTTP. The
signed routing/operation context and purpose must cover the intended action.
Authentication does not itself encrypt application messages; provide suitable
confidential transport when the interaction requires it.

`receiveBRC52Disclosure` requires a locally trusted `BRC52AuthenticationPort`, a
nonce store, a trusted clock, an age limit, and `assessReliance`. The port must
verify real authenticated dispatcher evidence for the exact payload and peer,
and validate recipient, operation, purpose, nonce, freshness and session context.
The SDK Peer callback exposes authenticated identity and payload; it does not
expose protocol nonce/session/time as a complete receipt. Such an integration
must verify bounded signed application nonce, session and issued-at context
before constructing the receipt. `authenticatedAt` is trusted local dispatch
time, not a signed protocol timestamp; stamping a delayed valid callback with
the current time does not establish freshness.
A caller's `authenticated: true`, unverified HTTP header or copied public
certificate is insufficient. This port defines no alternate wire encoding or
presentation proof.

The receiver binds the receipt to the exact incoming envelope bytes, certificate
subject, selected receiving identity and intended context. It rejects future or
expired requests and repeated nonces across routes/sessions for the same
peer/recipient. Its age limit is explicit, positive and at most five minutes,
and freshness is checked again after policy/identity work. `BRC52MemoryNonceStore`
defaults to 10000 entries, fails closed at capacity and rejects clock regression.
It is process-local: production workers or restarts need an appropriate shared
atomic store preserving the replay window.

`assessReliance` must decide acceptable issuers and schema, selected fields,
purpose, status and freshness before wallet decryption. It returns an explicit
authorization decision and `BRC52StatusResult` associated with the exact signed
outpoint. The receiver rejects issuer-tracking status retrieval even if a caller
tries to authorize it. A policy requiring current certification must deny unknown,
revoked or otherwise insufficient status.

Wallet decryption uses `[2, 'certificate field encryption']`, key ID
`serialNumber + ' ' + fieldName`, counterparty equal to the certificate subject.
Each recovered field key must be exactly 32 bytes. Field decryption validates
the BRC AES-256-GCM framing and tag and decodes strict UTF-8. Any failure rejects
the operation without returning partial plaintext. Empty keyrings reveal nothing.

The result has separate `verifiedDocument`, `disclosedFields`, source,
recipient, authenticated request and status evidence. Do not insert plaintext
into the graph or describe it as a new issuer plaintext signature. Field keys
are not signed, and AES-GCM provides no general key-commitment guarantee: the
bridge preserves the existing BRC issuance/encryption assumptions rather than
proving stronger unique issuer-intended plaintext binding.

## Evaluate status with explicit evidence and privacy policy

`evaluateBRC52Status(originalBytes, policy)` verifies the certificate and uses a
locally selected network, evidence source, maximum age, confirmation,
unconfirmed-spend and reorganization policy. A supplied retrieval adapter must
describe its privacy protection and actual evidence-validation procedure. It
receives only `{ outpoint, network }`; do not attach the credential, DIDs,
subject, verifier, operation or presentation nonce.

| Result           | Meaning                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `notRevokedAsOf` | Accepted current-state evidence says the real output exists and is unspent at the reported time |
| `revoked`        | Accepted chain-policy evidence establishes its spend                                            |
| `unknown`        | Missing, stale, unavailable, wrong-context or insufficient evidence                             |
| `disabled`       | The signed all-zero transaction ID and output zero sentinel; no query occurs                    |

A Merkle inclusion proof alone does not prove that an output remains unspent.
Missing database rows, provider errors, signature success and overlay admission
cannot become `notRevokedAsOf`. A `provider-assertion` is an assertion; an evidence
label does not turn remote JSON into independently validated chain proof.
Disabled revocation supplies no evidence of present account control or permanent
truth of an assertion.

Use a verifier-local chain view or a reviewed batching/cache approach that
prevents the issuer learning interest in a particular holder. Issuer tracking,
including indirect tracking through a provider, yields `unknown` without a
retrieval attempt. It cannot be waived by an application's acceptance policy.
Report any separate third-party correlation limitation. Do not claim compliant
status privacy from a per-presentation issuer query.

## Discover public attributes through BRC-189 identity semantics

The dedicated DID overlay is retired. An immutable identity-key DID needs no
on-chain DID registration or lookup. For separately authorized public certified
attributes, use existing `tm_identity` publication and `ls_identity` lookup.
The BRC-203 JSON envelope is not the public identity token format.

A public identity output carries the complete signed encrypted certificate core
and only its selected anyone-verifier keyring, plus a separate subject signature
over the exact public JSON bytes under `[1, 'identity']`, key ID `'1'`, anyone
counterparty. Anyone can decrypt that selected subset. Admission validates
the subject's publication authority, issuer signature and public decryptability;
it does not appoint trusted issuers, reserve exclusive names or establish current
certificate revocation status. Public publication requires its own informed
authorization and can be copied indefinitely.

Applications normally ask the wallet through `discoverByIdentityKey` or
`discoverByAttributes`, with explicit `seekPermission`, and apply the current
user-selected trust policy. An empty selected issuer set is a local no-trust
decision, not an empty or unfiltered overlay issuer query. Certifier selection,
registry-publisher preference, overlay-provider choice and application permissions
have distinct meanings, even where a wallet shares settings between them.

Raw `ls_identity` lookup returns an `output-list` with transaction evidence and
actual output indexes. Validate and bind it to the intended query; no host row,
friendly display name or first result establishes the intended recipient. Serial
queries take precedence over other selectors and do not enforce an accompanying
certifier filter. Named/`any` searches can be fuzzy or use the host's documented
full-text profile; compare authenticated values under type-specific rules before
calling a match exact. Preserve ambiguity, pagination limits and evidence source.

Weighted wallet discovery counts each distinct contributing selected issuer once
per subject. Duplicate publications/certificates do not multiply trust. A
threshold is that user's discovery policy, not a probability or proof that every
issuer certified every field. Keep each certificate's attribution and reapply
changed trust settings to cached evidence. Personal contacts can express the
user's directly accepted association; they must retain that local attribution
and must not be fabricated as issuer-signed certificates.

Withdrawal of a subject-controlled public revelation, issuer certificate
revocation, wallet `relinquishCertificate`, and removal of a contact/trust anchor
have different effects. Participating identity indexes track authenticated
revelation withdrawals, including equivalent copies, under their declared
withdrawal profile. Current indexes, caches and legacy hosts can differ in
availability or freshness. Withdrawal cannot erase historical chain data or
plaintext learned by a recipient.

## Certifier operations and Social account claims

An issuer adopting BRC-200 publishes an attributable, versioned operating
statement: exact issuer keys/types/networks, checked evidence, authorization,
freshness, key protection, delivery, retention, revocation authority, incident
response and continuity. Validate the actual plaintext corresponding to every
encrypted field before signing. Authenticate subject authority and resource
access separately and bind both to the exact issuance. Record the applicable
policy version; an unsigned policy document cannot retroactively add signed
time, expiry or assurance facts. Distinguish signature creation, subject receipt,
transaction submission and accepted revocation evidence.

BRC-201 documents existing Social-family types:

| Type    | Exact 32-byte Base64 identifier                | Exact field set            |
| ------- | ---------------------------------------------- | -------------------------- |
| Email   | `exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=` | `email`                    |
| X       | `vdDWvftf1H+5+ZprUw123kjHlywH+v20aPQTuXgMpNc=` | `userName`, `profilePhoto` |
| Discord | `2TgqRC35B1zehGmB21xveZNc7i5iqHc0uxMb+1NMPW4=` | `userName`, `profilePhoto` |

Preserve exact field case and checked strings. Mailbox access and authenticated
provider responses support an issuer's observed account association, without
legal identity, unique-human status, exclusive name ownership or permanent
account control. These schemas contain no certified observation time, expiry
or stable provider account ID. `profilePhoto` certifies an observed HTTPS URL
string under the proposed rules, not immutable image contents. Render all
external strings safely and make remote image fetches a privacy choice.

Separate account verification, wallet acquisition and optional public revelation.
Do not add unknown fields, require publication for private holding, request
unrelated provider access or install a trust anchor during acquisition. New key
or account attributes require explicit continuity/evidence checks and new
subject-bound issuance. This integration does not deploy SocialCert services
or claim their operational conformance.

## Implementation and migration limits

The identity-key codec is validated at its exact 35-byte multicodec/key size.
Generic large Base58 payloads are separate: the inherited one-megabyte guard
does not prove maximum-size SDK support, and Node24 string construction can
fail at that boundary. No maximum-size generic-codec support claim is made.

The BRC-203 adapter implements export, strict verification, holder disclosure,
receiver integration and status evaluation; application policy and trusted
transport/evidence adapters remain explicit integration responsibilities. Frozen
synthetic vectors exercise original signatures, derivation and decryption.
Mocked authentication/evidence ports do not establish full deployed BRC-103/104
interoperability, issuer operations or external W3C/JSON-LD conformance.

Field names, ciphertext lengths, subject/issuer keys, type, serial, signature and
outpoint remain visible and linkable. This is selective revelation without
zero-knowledge predicates or unlinkable presentations. A verifier can retain
plaintext and keys; revocation or permission withdrawal cannot erase them.

The independent `SdJwtVcIssuer`, `SdJwtVcHolder`, `SdJwtVcPresenter` and
`SdJwtVcVerifier` APIs remain a separate JOSE `ES256K`/SD-JWT format. They create
and verify their own JWT signatures and are not the BRC-203 exporter. The
signature-preserving bridge neither relabels existing SD-JWTs nor claims that
their status and type-metadata evaluation is supplied by these BRC status APIs.

The coordinated source migration proposes major SDK/overlay-topics versions,
`@bsv/did` 0.3 and `@bsv/simple` 0.7 for incompatible removals and API changes.
Update consumers before publication under the
[versioning policy](../about/versioning.md). Retain existing wallet data,
certificates, signed source evidence and contact history; removal of obsolete
source paths is not production data deletion. See the helper
[README](../packages/helpers/did.md) for the public API and the
[registry guide](./registry-metadata.md) for optional metadata boundaries.

## Migration

Use the [API and service migration map](identity-did-vc-migration.md) before updating consumers or retiring a deployed legacy service.

BRC52 credential adapters are an explicit optional `@bsv/did/brc52` import. The root `@bsv/did` entry provides the corrected identity-key DID profile and separately named SD-JWT helpers. Importing the DID entry does not load the credential envelope, disclosure or status adapter. Both entries have separate packed browser composition checks and finite budgets.
