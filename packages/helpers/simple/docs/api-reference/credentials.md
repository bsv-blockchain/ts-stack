# Credential API

The proposed BRC-203 bridge preserves original BRC-52 signatures and encrypted fields. It does not emit a generic W3C proof or unsigned presentation.

| API                                                     | Result / behavior                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `new CredentialSchema(config)`                          | Declared-field validation, computed fields, type metadata                                |
| `CredentialIssuer.create(config)`                       | Existing authorized issuer setup and revocation-store configuration                      |
| `issuer.issueCertificate(subjectKey, schemaId, fields)` | `Promise<CertificateData>` for BRC-52 delivery/acquisition                               |
| `issuer.issue(subjectKey, schemaId, fields)`            | `Promise<IssuedCredential>`: `{ credential: BRC52Envelope, keyringForSubject }`          |
| `issuer.verify(input: string                            | Uint8Array)`                                                                             | `BRC52VerificationResult`, authenticates envelope integrity only |
| `issuer.revoke(serialNumber)`                           | Existing authorized hash-lock spend, deletes local secret only after successful result   |
| `issuer.getRevocationRecordStatus(serialNumber)`        | `Promise<'retained'                                                                      | 'unknown'>`, local secret retention only                         |
| `issuer.getInfo()`                                      | Public identity key, identity-key DID, schema/type metadata                              |
| `wallet.acquireCredential(config)`                      | `Promise<BRC52Envelope>`, remote BRC-52 acquisition with original signature verification |
| `wallet.listCredentials({ certifiers, types, limit? })` | `Promise<BRC52Envelope[]>`, signature-authenticated stored certificate cores             |

`CredentialSchema` still supports `validate`, `computeFields`, `getInfo`, `getConfig`, `getCertificateTypeMigration`, `getCanonicalCertificateType`, and `getLegacyCertificateType`. Historical short type aliases are for existing data migration; they do not make a record encodable as canonical BRC-52 binary.

`MemoryRevocationStore` and server-only `FileRevocationStore` retain existing persistence interfaces. Missing local records are unknown chain status. Status, disclosure authorization, issuer trust, and challenge-bound holder control are independent evidence.

`createCredentialIssuerHandler` retains authorized certify/issue/revoke routing. Certify delivers `CertificateData`; issue delivers `{ success: true, credential, keyringForSubject }`; verify accepts `{ credential: envelope }` and returns the integrity result. The status endpoint reports local `revocationRecordStatus` and chain `status: 'unknown'`.

See the [guide](../guides/credentials.md) and [breaking migration](../guides/identity-credential-migration.md).
