# @bsv/did

`@bsv/did` is a BSV SDK compatibility layer for SD-JWT VC credentials and optional `did:key` identifiers.

It does not change the SDK. It uses BSV secp256k1 keys as JOSE `ES256K` keys, exposes those keys as `cnf.jwk` holder-binding material, and produces SD-JWT VC presentations with optional Key Binding JWTs.

## Standards

- [RFC 9901: Selective Disclosure for JSON Web Tokens](https://www.rfc-editor.org/rfc/rfc9901.html)
- [SD-JWT-based Verifiable Credentials, draft-ietf-oauth-sd-jwt-vc-16](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-sd-jwt-vc)
- [DID Core v1.0](https://www.w3.org/TR/did-core/)
- [did:key Method v0.9](https://w3c-ccg.github.io/did-key-spec/)

## Important Algorithm Note

JOSE `ES256` means ECDSA over P-256. BSV identity keys are secp256k1, so this package emits `ES256K`.

That is the correct JOSE algorithm for BSV keys. Some EUDI/eIDAS profiles might require P-256 `ES256`; those profiles will need a P-256 holder/issuer key mode in addition to BSV identity-key mode.

## Install

```sh
pnpm add @bsv/did
```

## DID Key

```ts
import { PrivateKey } from '@bsv/sdk'
import { BsvDid } from '@bsv/did'

const privateKey = PrivateKey.fromRandom()
const did = BsvDid.fromPublicKey(privateKey.toPublicKey().toDER() as number[])
const didDocument = BsvDid.toDidDocument(did)
const qrSvg = BsvDid.generateQrCode(did, 'did')
```

## Issue an SD-JWT VC

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

## Present Selectively

```ts
import { SdJwtVcHolder, SdJwtVcPresenter } from '@bsv/did'

const presentation = await SdJwtVcHolder.generatePresentation(
  vc,
  ['given_name', 'is_over_21'],
  {
    holderPrivateKey,
    audience: 'https://verifier.example',
    nonce: 'verifier-nonce'
  }
)

const wirePayload = SdJwtVcPresenter.present(presentation)
```

When `holderPrivateKey` is supplied, the holder creates a KB-JWT with `sd_hash`, `aud`, `nonce`, and `iat`.

## Verify

```ts
import { SdJwtVcVerifier } from '@bsv/did'

const result = await SdJwtVcVerifier.verify(wirePayload, {
  expectedAudience: 'https://verifier.example',
  expectedNonce: 'verifier-nonce',
  requireKeyBinding: true
})

if (result.verified) {
  console.log(result.disclosedClaims)
}
```

If the issuer is a `did:key`, the verifier can derive the issuer public key from `iss`. Otherwise pass `issuerPublicKey`.

## Public API

- `BsvDid`
- `SdJwtVcIssuer`
- `SdJwtVcHolder`
- `SdJwtVcPresenter`
- `SdJwtVcVerifier`
- `publicKeyToJwk`, `privateKeyToJwk`, `jwkToPublicKey`
- `parseSdJwt`, `serializeSdJwt`, `parseDisclosure`, `disclosureDigest`
