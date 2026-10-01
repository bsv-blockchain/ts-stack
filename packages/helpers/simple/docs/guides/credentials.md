# Encrypted certificate credentials

Simple exports existing BRC-52 certificates using the proposed BRC-203 envelope in `@bsv/did/brc52`. The envelope contains the original certificate binary and its deterministic encrypted credential graph; the explicit disclosure API can add a separately assessed verifier-keyring object. The certifier signature and ciphertext remain unchanged. It contains no invented timestamp, plaintext subject claim, generic proof, or subject/master keyring.

The custom securing mechanism, vocabulary, and outpoint status type are proposed and unregistered. Generic W3C, Data Integrity, JOSE, COSE, SD-JWT, and status-list verifiers cannot be assumed to verify this envelope. Local adapter tests do not establish full external conformance or deployed interoperability.

```typescript
import { verifyBRC52Envelope } from '@bsv/did/brc52'

// Existing envelope JSON received through your application's transport.
function verifyCredential(envelopeJson: string) {
  const result = verifyBRC52Envelope('application/json', envelopeJson)
  if (!result.verified) throw new Error(result.errors.join('; '))
  return result.verifiedDocument
}
```

`envelopeJson` is an application-provided string or UTF-8 bytes, not an arbitrary object with executable accessors. Successful verification returns `verifiedDocument` and `mediaType: 'application/vc'`. It authenticates the original derived BRC-52 signature and requires the entire supplied graph to match its signed certificate. Integrity alone establishes neither issuer trust, disclosure authorization, nor current revocation status.

For an existing connected wallet, `await wallet.acquireCredential(config)` authenticates the remote certificate, binds certifier/subject/type, acquires it through the wallet, then returns a verified envelope. `await wallet.listCredentials({ certifiers, types })` returns verified envelopes from stored certificate cores. Stored keyrings remain in their existing custody boundary and are not exported. Malformed or signature-mismatched cores fail closed; a structured record that cannot reproduce its signed bytes must be recovered from original binary, not re-signed or normalized into a new assertion.

`CredentialSchema` retains its declared field validation, computed fields, canonical 32-byte certificate types, and explicit historical aliases for storage migration. Existing certifier issuance, acquisition, and wallet persistence continue to use BRC-52 operations. `CredentialIssuer.issueCertificate(subjectKey, schemaId, fields)` returns the certificate delivery data for the authenticated certify endpoint. `CredentialIssuer.issue(...)` returns `{ credential, keyringForSubject }`: deliver the encrypted subject keyring only to the authorized subject, separately from the credential graph. Issuance and revocation can perform wallet operations and require explicit application authorization; examples here do not perform them.

The issuer's `verify(envelopeJson)` is the integrity verifier above. It never infers spent status from an absent local revocation secret. `getRevocationRecordStatus(serial)` reports local `retained` or `unknown`; this is not chain status. The handler's status endpoint reports `status: 'unknown'` alongside that local record state. Use the explicit status-source API in `@bsv/did/brc52` for disabled, unknown, current/unspent, and revoked/spent evidence under the verifier's freshness and provider policy.

The HTTP verification route accepts `{ credential: envelopeJson }`, with the original JSON text kept as a string inside the request. Preserve received envelope text; parsing and reserializing it can hide duplicate members. Send the body through the Web `Request` stream so the handler can reject duplicate request members and invalid UTF-8 before use. Custom framework adapters that supply only an already parsed `json()` result must establish strict request decoding themselves. Read `verification.verified`, then apply reliance policy; a successful HTTP response alone is insufficient.

The streamed verify request has a separate 256 KiB strict JSON budget, including its wrapper and escaping. Increasing `maxRequestBytes` does not increase this parser budget. Large valid envelopes can exceed this route's budget once wrapped; use the direct `issuer.verify(originalText)` or `verifyBRC52Envelope` API under the BRC-203 envelope bounds. Other issuance/certification routes retain their configured request limits.

Selective disclosure requires explicit user permission, a chosen verifier, and BRC-100/BRC-103 authentication plus verifier-specific keyring generation. Ciphertext remains in the authenticated graph; plaintext disclosure results and verifier keyrings remain separate. Never export the master keyring or treat wallet field selection as holder authentication. This profile has no zero-knowledge or unlinkable disclosure: stable issuer/subject keys, serial, ciphertext, and outpoint can correlate presentations. Direct status queries can expose verifier interest.

See [migration guidance](identity-credential-migration.md), [the API](../api-reference/credentials.md), and the unified repository guidance for dependency pins and implementation limits.
