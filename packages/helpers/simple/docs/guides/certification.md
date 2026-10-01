# Certification

BSV certificates are cryptographic attestations that a certifier makes about a subject. Think of them as digital stamps of approval that live in the wallet.

## The Certifier Class

`Certifier` is a standalone class that can issue certificates without needing a full wallet.

### Creating a Certifier

```typescript
import { Certifier } from '@bsv/simple/browser'

// Random key (ephemeral certifier)
const certifier = await Certifier.create()

// Specific key (persistent certifier)
const certifier = await Certifier.create({
  privateKey: 'a1b2c3d4...',
  certificateType: Certifier.getCanonicalCertificateType(),
  defaultFields: { role: 'member' },
  includeTimestamp: true
})
```

### Configuration

| Parameter          | Type                     | Default                          | Description                                                                         |
| ------------------ | ------------------------ | -------------------------------- | ----------------------------------------------------------------------------------- |
| `privateKey`       | `string`                 | Random                           | Hex-encoded private key for the certifier                                           |
| `certificateType`  | `string`                 | base64(SHA-256('certification')) | Canonical 32-byte type, or a historical short type to canonicalize for new issuance |
| `defaultFields`    | `Record<string, string>` | `{ certified: 'true' }`          | Fields included in every certificate                                                |
| `includeTimestamp` | `boolean`                | `true`                           | Add timestamp field automatically                                                   |

### Certifier Info

```typescript
const info = certifier.getInfo()
// { publicKey: '02abc...', certificateType: '<32-byte base64>' }
```

New issuance always uses a canonical 32-byte type. For migration tooling,
`Certifier.getLegacyCertificateType()` returns the short pre-0.6 default and
`certifier.getCertificateTypeMigration()` returns the exact canonical/legacy
mapping for this instance.

Do not pass a short legacy identifier to current SDK wallet methods or expose
it from a remote service: current `WalletInterface` validation rejects short
types. Export legacy records with the storage version that created them,
authenticate them offline, and reissue/import a canonical replacement.

## Issuing a Certificate

```typescript
const cert = await certifier.certify(wallet, {
  role: 'admin',
  department: 'engineering'
})

console.log('Serial Number:', cert.serialNumber)
console.log('Subject:', cert.subject)
console.log('Fields:', cert.fields)
// { certified: 'true', timestamp: '1708300800', role: 'admin', department: 'engineering' }
```

`certify()` does two things:

1. Issues a `MasterCertificate` signed by the certifier
2. Acquires the certificate into the subject's wallet

### CertificateData

```typescript
interface CertificateData {
  type: string // Certificate type
  serialNumber: string // Unique serial number
  subject: string // Subject's identity key
  certifier: string // Certifier's public key
  revocationOutpoint: string // Outpoint for revocation
  fields: Record<string, string> // Certificate fields
  signature: string // Certifier's signature
  keyringForSubject: Record<string, string> // Decryption keyring
}
```

## Acquiring from a Remote Server

If the certifier runs on a server, wallets can acquire certificates remotely:

```typescript
const cert = await wallet.acquireCertificateFrom({
  serverUrl: 'https://certifier.example.com',
  replaceExisting: true // revoke old certs from this certifier first
})
```

### Server Requirements

The server must expose two endpoints:

**`GET /api/info`** — Returns certifier metadata:

```json
{ "certifierPublicKey": "02abc...", "certificateType": "<32-byte base64>" }
```

**`POST /api/certify`** — Issues a certificate:

Request body: `{ "identityKey": "02abc..." }`

Response: `CertificateData` JSON

## Listing Certificates

```typescript
const result = await wallet.listCertificatesFrom({
  certifiers: [certifierPublicKey],
  types: [Certifier.getCanonicalCertificateType()],
  limit: 100
})

console.log('Total:', result.totalCertificates)
for (const cert of result.certificates) {
  console.log(cert.serialNumber, cert.fields)
}
```

## Revoking a Certificate

```typescript
await wallet.relinquishCert({
  type: Certifier.getCanonicalCertificateType(),
  serialNumber: cert.serialNumber,
  certifier: certifierPublicKey
})
```

This removes the certificate from the wallet. For BRC-52 revocation operations and explicit status evidence, see the [Credentials Guide](credentials.md).

## Complete Example

```typescript
import { createWallet, Certifier } from '@bsv/simple/browser'

const wallet = await createWallet()

// Create a certifier
const certifier = await Certifier.create({
  defaultFields: { organization: 'Acme Corp' }
})
const info = certifier.getInfo()

// Issue certificate to the connected wallet
const cert = await certifier.certify(wallet, {
  role: 'developer',
  clearanceLevel: '3'
})

// List certificates
const certs = await wallet.listCertificatesFrom({
  certifiers: [info.publicKey],
  types: [info.certificateType]
})
console.log('Certificates:', certs.totalCertificates)

// Revoke when done
await wallet.relinquishCert({
  type: info.certificateType,
  serialNumber: cert.serialNumber,
  certifier: info.publicKey
})
```
