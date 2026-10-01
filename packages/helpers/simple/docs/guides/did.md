# Identity-key DIDs

Simple implements the proposed BRC-202 identity-key subset of `did:key` through `@bsv/did`. It encodes the user's selected compressed secp256k1 identity key and resolves offline. A DID document supplies a deterministic key representation, not proof of live control, issuer trust, a legal identity, or authorization.

```typescript
import { DID } from '@bsv/simple'

// Public synthetic specification vector, never a production identity.
const identityKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const did = DID.fromIdentityKey(identityKey)
const result = DID.resolve(did)
console.log(result.didDocument?.id)
// did:key:zQ3shVc2UkAfJCdc1TR8E66J85h48P43r93q8jGPkPpjF9Ef9
```

For an already connected Simple wallet, `wallet.getDID()` returns its identity-key DID document. `wallet.resolveDID(did)` returns the same resolution result as `DID.resolve(did)` and performs no provider call or transaction. Invalid profile inputs produce `invalidDid`; other syntactically valid methods produce `methodNotSupported`. Paths, queries, and fragments cannot be passed as identity DIDs. Use `BsvDid.dereference` from `@bsv/did` for the exact verification-method DID URL.

The document contains a Multikey and authentication, assertionMethod, capabilityInvocation, and capabilityDelegation references. It adds neither service endpoints nor a keyAgreement relationship. Obtain the identity key using the wallet's `getPublicKey({ identityKey: true })` permission flow; do not substitute a certificate serial, transaction identifier, address, child key, or overlay-host key.

Authenticate live control separately with an appropriate challenge-bound BRC-103 flow. BRC-52 certificates use their original derived certificate-signature verification rather than ordinary root-key signing of W3C bytes. BRC-189 discovery and user-selected certifier trust remain separate; deterministic resolution installs no service and selects no trust anchor.

Changing the identity key changes the DID. This profile has no in-place creation transaction, update, recovery, rotation, or deactivation. Certificate revocation does not stop its subject DID resolving. Reusing an identity key links contexts; spelling it as a DID adds no unlinkability.

See [migration guidance](identity-credential-migration.md) and the [API reference](../api-reference/did.md). The profile is proposed, and passing its local vectors is not W3C certification or general DID-method interoperability.
