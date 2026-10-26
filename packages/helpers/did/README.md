# @bsv/did

`@bsv/did` supplies the proposed BRC-202 identity-key DID profile and BRC-203
signature-preserving bridge for existing encrypted BRC-52 certificates. It also
retains independent SD-JWT VC helpers. The BRC bridge preserves the original
certificate signature and ciphertext; SD-JWT issuance creates its own JOSE
signature. Choose the format explicitly.

This is proposed source support for the 0.3 migration; it is not evidence of npm
publication, deployed service interoperability or W3C registration. See the
[unified identity/DID/VC guide](../../../docs/guides/identity-did-vc.md) for
integration, issuer practices, discovery/trust and the exact reviewed proposal
heads. BRC-203 depends on the unmerged BRC-202 proposal and foundation corrections
in [BRC PR 290](https://github.com/bsv-blockchain/BRCs/pull/290), pinned to
`61404d6aaa55d698a975a967495488f74c622d18`.

## Standards

- [RFC 9901: Selective Disclosure for JSON Web Tokens](https://www.rfc-editor.org/rfc/rfc9901.html)
- [SD-JWT-based Verifiable Credentials](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-sd-jwt-vc) — independent IETF format; the existing helpers' implementation basis is draft 16, without a claim of conformance to later drafts
- [DID Core v1.0](https://www.w3.org/TR/did-core/)
- [did:key Method v0.9](https://w3c-ccg.github.io/did-key-spec/)
- [BRC-202 proposal](https://github.com/bsv-blockchain/BRCs/blob/d4cc8a186cb354d689287387c36c86d2458bc3db/peer-to-peer/0202.md) — reviewed at `d4cc8a186cb354d689287387c36c86d2458bc3db`
- [BRC-203 proposal](https://github.com/bsv-blockchain/BRCs/blob/ff78f14d997d3c90fbb2cc501750c301e903875c/peer-to-peer/0203.md) — reviewed at `ff78f14d997d3c90fbb2cc501750c301e903875c`

## Separate securing mechanisms

JOSE `ES256` means ECDSA over P-256. BSV identity keys are secp256k1, so this package emits `ES256K`.

That statement applies to the SD-JWT APIs. BRC-203 uses BRC-52's derived
certificate-signature verification over the exact original unsigned binary
prefix, rather than JOSE, COSE or an embedded Data Integrity proof. Its custom
mechanism, vocabulary and outpoint status type are proposed and unregistered.
Generic W3C verifiers must explicitly implement this mechanism; a W3C-shaped
object or matching signature alone does not establish generic conformance.

## Install

```sh
pnpm add @bsv/did
```

## Identity-key DID

```ts
import { BsvDid, verificationMethodForDid } from '@bsv/did'

// Public synthetic key, never a production identity.
const identityKey = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const did = BsvDid.fromPublicKey(identityKey)
const resolution = BsvDid.resolve(did)
const representation = BsvDid.resolveRepresentation(did, {
  accept: 'application/did+ld+json'
})
const method = BsvDid.dereference(verificationMethodForDid(did))
```

In wallet applications obtain the identity key through
`getPublicKey({ identityKey: true })`. Encoding accepts valid 33-byte compressed
secp256k1 points and produces canonical `did:key:z` with multicodec `e7 01`.
Resolution is offline and deterministic. The `Multikey` document carries no
discovery attributes, trust score, history, network or service endpoint; it
cannot prove live private-key control. `resolve` reports explicit invalid,
unsupported-method or unsupported-representation metadata with a null document.
Only the exact verification-method DID URL can be dereferenced.

`update`, `rotate`, `recover` and `deactivate` report `operationNotSupported`.
Changing the identity key changes the DID. A revoked certificate's subject DID
still resolves; matching account strings do not establish key continuity.

## Export and verify an existing BRC-52 certificate

```ts
import { exportBRC52Envelope, verifyBRC52Envelope } from '@bsv/did/brc52'

export function verifyExistingCertificate(originalCertificateBinary: Uint8Array) {
  const envelope = exportBRC52Envelope(originalCertificateBinary)
  const input = new TextEncoder().encode(JSON.stringify(envelope))
  const verification = verifyBRC52Envelope('application/json', input)
  if (!verification.verified || verification.verifiedDocument === null) {
    throw new Error(verification.errors.join('; '))
  }
  return verification.verifiedDocument
}
```

The envelope transports the original complete binary including DER signature,
an exact deterministic encrypted credential graph and optional unsigned
recipient-specific `disclosure`. Verification returns `mediaType: 'application/vc'`
and the computed graph, without keyrings or plaintext, as `verifiedDocument`.
It rejects added/rewritten claims, alternative contexts, duplicate members,
malformed UTF-8, keys, lengths, signatures or noncanonical Base64. Failure
returns false, a null document and errors.

Keep original signed bytes and field ordering. Historical locale-dependent
field serialization, Base64 field text and UTF-8 lengths are part of the
preimage. `exportBRC52StructuredCertificate` supports structured-only storage
only after its compatible local serialization authenticates under the existing
signature. It fails when those signed bytes cannot be recovered; it does not
reorder and re-sign. The root issuer identity key alone is not the derived
certificate ECDSA verification key.

`BRC52_LIMITS` exposes finite limits: 65536 certificate bytes, 262144 JSON
bytes, 256 fields, 50 UTF-8 bytes per field name and 16384 bytes per encoded
field value. Oversized input fails rather than being truncated.

## Selective revelation and relying policy

`produceBRC52Disclosure` takes original bytes, the holder wallet, intended
verifier identity key, purpose, selected fields and a required `authorize`
callback. Obtain informed user permission for that exact choice before wallet
operations. The adapter verifies the certificate and wallet subject binding,
then obtains exactly the selected recipient keyring through BRC-100
`proveCertificate`. The trusted wallet must validate its stored master keyring.
The adapter exports no master keyring, generates no certificate and creates no
issuer signature.

Deliver the complete exact envelope inside a fresh authenticated BRC-103
application payload, with BRC-104 when using HTTP. Bind signed operation/routing
and purpose to the request. Authentication is separate from confidentiality;
use suitable encrypted transport when required.

`receiveBRC52Disclosure` requires a locally trusted `BRC52AuthenticationPort`,
nonce store, trusted clock, positive `maxRequestAgeMs` at most 300000 and an
`assessReliance` callback. The authentication port must verify actual BRC-103/104
dispatcher evidence for the complete exact incoming bytes, subject peer,
receiving verifier, operation, purpose, nonce and freshness context. The SDK Peer
callback exposes authenticated peer/payload, not protocol nonce/session/time.
The integration must verify signed application nonce/session/issued-at context
before constructing a receipt; local dispatch time alone cannot make a delayed
message fresh. Caller booleans,
unsigned headers and public discovery are insufficient. The adapter specifies
no alternate authentication wire format or generic presentation proof.

Repeated nonces are rejected across routes and sessions for the same
peer/recipient. `BRC52MemoryNonceStore` is bounded and process-local; production
workers/restarts need shared atomic replay storage preserving the accepted age
window. Policy must assess issuer trust, field schema, disclosure permissions,
purpose and status freshness before decryption. It returns an explicit decision
and status associated with the original signed outpoint. Policy cannot bypass
issuer-tracking status restrictions.

Verifier field-key decryption uses `[2, 'certificate field encryption']`, key ID
`serialNumber + ' ' + fieldName` and the subject counterparty. Keys must be
exactly 32 bytes; field ciphertext uses a 32-byte IV and 16-byte AES-GCM tag.
GCM authentication and strict UTF-8 must succeed for every selected field. Any
failure rejects without returning partial plaintext.

Return `disclosedFields` separately from `verifiedDocument`, with source,
recipient, authenticated request and status evidence. AES-GCM supplies no
general key-commitment guarantee, and field keys are outside the issuer
signature. Do not claim unique issuer-intended plaintext binding stronger than
the original certificate's issuance/encryption assumptions. This selective
revelation is linkable, without zero-knowledge predicates or unlinkability.

## Outpoint status

`evaluateBRC52Status` requires original bytes and an explicit local network,
source, evidence-validation, freshness, confirmations, unconfirmed-spend,
reorganization and privacy policy. It supports verifier-local chain views or
reviewed batching/cache retrieval, without installing a provider. The adapter
gets only the signed outpoint and locally selected network.

Results distinguish `notRevokedAsOf`, `revoked`, `unknown` and the disabled
all-zero outpoint sentinel. Unknown is insufficient for a policy requiring
current certification. The sentinel causes no query and supplies no claim of
present account control. Signature success, missing provider records, provider
errors, old inclusion proofs and identity-overlay presence do not prove an
existing unspent output. A provider assertion remains an assertion; evidence
labels do not independently verify chain proofs.

Retrieval that directly or indirectly lets the issuer track interest in a
holder returns unknown without querying. Report separate third-party correlation
limitations. Do not attach DIDs, certificate fields, the credential, verifier
identity, nonce or operation to a status query.

For public discovery use the existing BRC-189 `tm_identity` / `ls_identity`
semantics and the user's selected certifiers and contacts. No DID overlay or
on-chain registration is needed to resolve this identity-key DID. Public
revelation, credential revocation and deletion from local wallet use have
different effects; none erases previously disclosed plaintext.

## Independent SD-JWT VC format

The following APIs retain their existing JOSE `ES256K`/SD-JWT behavior. They
are not a BRC-52 signature-preserving conversion and do not inherit BRC-203
status evaluation or W3C mechanism support.

### Issue an SD-JWT VC

```ts
import { PrivateKey } from '@bsv/sdk'
import { BsvDid, SdJwtVcIssuer } from '@bsv/did'

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
    family_name: 'Ng',
    email: 'alice@example.com',
    is_over_21: true
  },
  disclosureFrame: {
    given_name: true,
    email: true,
    is_over_21: true
  }
})
```

The issued `vc.sdJwt` contains the issuer-signed JWT, all Disclosures, and a final `~`, following RFC 9901 section 4.

### Present selectively

```ts
import { SdJwtVcHolder, SdJwtVcPresenter } from '@bsv/did'

const presentation = await SdJwtVcHolder.generatePresentation(vc, ['given_name', 'is_over_21'], {
  holderPrivateKey,
  audience: 'https://verifier.example',
  nonce: 'verifier-nonce',
  verificationOptions: {
    expectedIssuer: issuer,
    expectedVct: 'https://credentials.example.com/identity_credential'
  }
})

const wirePayload = SdJwtVcPresenter.present(presentation)
```

When `holderPrivateKey` is supplied, the holder creates a KB-JWT with `sd_hash`, `aud`, `nonce`, and `iat`.

### Verify the SD-JWT presentation

```ts
import { SdJwtVcVerifier } from '@bsv/did'

const result = await SdJwtVcVerifier.verify(wirePayload, {
  expectedIssuer: issuer,
  expectedVct: 'https://credentials.example.com/identity_credential',
  expectedAudience: 'https://verifier.example',
  expectedNonce: 'verifier-nonce',
  requireKeyBinding: true
})

if (result.verified) {
  console.log(result.disclosedClaims)
}
```

If the issuer is a `did:key`, the verifier derives the signing key from `iss` and rejects a configured key that does not match it. Otherwise, pass an `issuerPublicKey` obtained from a local trust policy. A JWT's own `jwk`, `jku`, or certificate header is never an issuer trust anchor.

`verified` means that the signed issuer identity, credential type, validity window, disclosures, and requested Key Binding policy all passed. A self-certifying `did:key` proves which key signed; it does not by itself authorize that issuer for an application. Set `expectedIssuer` and `expectedVct`, or apply an equivalent local allowlist, before granting access. If `aud` is present in the credential itself, set `expectedCredentialAudience`.

For replay-safe authorization, Key Binding requires both the verifier's exact audience and a transaction-specific nonce. The high-level verifier enforces both whenever Key Binding is required; the low-level helpers continue to accept legacy KB-JWTs with omitted `aud` or `nonce`, but those unbound tokens must not be used to authorize a transaction. KB-JWTs are rejected when their `iat` is in the future or older than five minutes by default; `clockToleranceSeconds`, `maxKeyBindingAgeSeconds`, and `now` allow bounded policy and deterministic tests. Supplying an expected audience or nonce automatically requires Key Binding.

The verifier validates `iat`, `nbf`, and `exp`, but it does not retrieve or evaluate a credential status list or type-metadata document. A signed `status` claim remains application input: check it under the relevant credential policy before authorization.

The Holder validates the issuer-signed credential and all supplied Disclosures before it selects claims or creates a KB-JWT. For non-`did:key` issuers, provide the trusted issuer key through `verificationOptions`. The Holder also proves that the supplied holder private key matches the signed `cnf.jwk`. Nested disclosure requests use full dotted paths such as `address.locality`; unknown or ambiguous paths fail rather than disclosing claims with the same short name elsewhere.

## Input and ownership limits

The BRC202 profile uses exactly 35 multicodec-plus-key bytes. The generic
Base58 utility retains an inherited one-megabyte defensive input guard, but
that guard is not a guarantee that the SDK can process the maximum: on Node24
the zero-byte maximum encounters an SDK string-construction `RangeError`.
Large generic Base58 payloads remain unqualified; this does not affect the
fixed-size identity-key vectors.

Compact JWT, JSON, disclosure count/size/depth, identifier, in-memory store, and QR inputs have fixed defensive limits. JSON must be strict UTF-8 without duplicate keys, accessors, sparse arrays, cycles, non-finite numbers, or unpaired Unicode surrogates. SD-JWT processing rejects duplicate digest placement, cleartext/disclosed-name collisions, reserved claim names, nested `_sd_alg`, malformed array placeholders, and disconnected Disclosures. RFC 9901 recursive object and array Disclosures are processed with their complete ancestor chain.

Returned payloads, Disclosure arrays, stored credentials, keys, and JWK-derived objects are owned copies. `SdJwtVcHolder.store` is only a bounded process-local convenience store; adding a credential does not make its issuer trusted and it is not durable storage. QR colors are restricted to hexadecimal CSS colors so generated SVG cannot contain external paint-server URLs.

## Public API

- `BsvDid`
- `exportBRC52Envelope`, `exportBRC52StructuredCertificate`, `verifyBRC52CertificateBinary`, `verifyBRC52Envelope`, `parseBRC52Envelope`
- `produceBRC52Disclosure`, `receiveBRC52Disclosure`, `BRC52MemoryNonceStore`
- `evaluateBRC52Status`, `BRC52_LIMITS`, `BRC52_ENVELOPE_PROFILE`, `BRC52_DISABLED_OUTPOINT`, `BRC52_VOCABULARY`
- `BRC52Envelope`, `BRC52CredentialGraph`, `BRC52VerificationResult`, disclosure/authentication options and status policy/evidence types
- `SdJwtVcIssuer`
- `SdJwtVcHolder`
- `SdJwtVcPresenter`
- `SdJwtVcVerifier`
- `publicKeyToJwk`, `privateKeyToJwk`, `jwkToPublicKey`
- `parseSdJwt`, `serializeSdJwt`, `parseDisclosure`, `disclosureDigest`

## Validation scope

Offline synthetic vectors test identity-key encoding/resolution, retained
signature bytes, graph rejection, authorization, recipient-scoped derivation
and GCM decryption, replay/freshness limits and status/privacy behavior. Mocked
authentication/evidence ports are integration-boundary tests, without a claim
of full deployed BRC-103/104 or issuer conformance. Complete external W3C and
JSON-LD conformance, extension registration, production transport/evidence
integration and anti-correlation review remain outside those tests.

Independent SD-JWT tests remain required. Run package `test`, `typecheck`,
`lint`, `build`, packed-consumer and browser checks along with repository gates
before publication. Source/API removals require coordinated migration while
preserving existing wallet data, certificate bytes and contact history.

## License

Open BSV License Version 6. See [LICENSE.txt](./LICENSE.txt).

See the [coordinated migration map](../../../docs/guides/identity-did-vc-migration.md) for retired serial-DID and copied-proof APIs.

Use `@bsv/did/brc52` for BRC52 envelope, disclosure and status APIs; `@bsv/did` retains the corrected identity-key DID and distinct SD-JWT surface. The optional entry is separately qualified in browser and packed consumers.
