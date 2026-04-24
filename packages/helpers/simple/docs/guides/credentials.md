# Verifiable Credentials

`@bsv/simple` supports W3C Verifiable Credentials backed by BSV `MasterCertificate` cryptography. Credentials can be issued, verified, and revoked on-chain.

## Overview

| Component | Role |
|-----------|------|
| `CredentialSchema` | Defines the fields, validation, and computed values for a credential type |
| `CredentialIssuer` | Issues, verifies, and revokes credentials |
| `MemoryRevocationStore` | Stores revocation secrets in memory (browser/tests) |
| `FileRevocationStore` | Stores revocation secrets on disk (server only) |
| `toVerifiableCredential()` | Wraps a BSV certificate into W3C VC format |
| `toVerifiablePresentation()` | Wraps VCs into a W3C VP |

## Defining a Schema

```typescript
import { CredentialSchema } from '@bsv/simple/browser'

const schema = new CredentialSchema({
  id: 'employee-badge',
  name: 'EmployeeBadge',
  description: 'Company employee verification',
  fields: [
    { key: 'name', label: 'Full Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'department', label: 'Department', type: 'select', options: [
      { value: 'engineering', label: 'Engineering' },
      { value: 'design', label: 'Design' },
      { value: 'sales', label: 'Sales' }
    ]},
    { key: 'startDate', label: 'Start Date', type: 'date' }
  ],
  validate: (values) => {
    if (!values.email?.includes('@')) return 'Invalid email'
    return null
  },
  computedFields: (values) => ({
    ...values,
    issuedAt: new Date().toISOString(),
    verified: 'true'
  })
})
```

### Schema Methods

```typescript
// Validate field values
const error = schema.validate({ name: '', email: 'bad' })
// 'Full Name is required'

// Add computed fields
const all = schema.computeFields({ name: 'Alice', email: 'alice@co.com' })
// { name: 'Alice', email: 'alice@co.com', issuedAt: '2024-...', verified: 'true' }

// Get info
const info = schema.getInfo()
// { id: 'employee-badge', name: 'EmployeeBadge', certificateTypeBase64: '...', fieldCount: 4 }
```

### Field Types

| Type | Description |
|------|-------------|
| `text` | Free-form text |
| `email` | Email address |
| `date` | Date string |
| `number` | Numeric value |
| `textarea` | Multi-line text |
| `checkbox` | Boolean flag |
| `select` | Dropdown with predefined options |

## Creating an Issuer

```typescript
import { CredentialIssuer, MemoryRevocationStore } from '@bsv/simple/browser'

const issuer = await CredentialIssuer.create({
  privateKey: issuerPrivateKeyHex,
  schemas: [schema.getConfig()],
  revocation: {
    enabled: true,
    wallet: walletInstance.getClient(),    // for creating revocation UTXOs
    store: new MemoryRevocationStore()
  }
})

console.log('Issuer DID:', issuer.getInfo().did)
console.log('Schemas:', issuer.getInfo().schemas)
```

### Issuer Configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `privateKey` | `string` | Yes | Hex-encoded private key |
| `schemas` | `CredentialSchemaConfig[]` | No | Schema definitions |
| `revocation.enabled` | `boolean` | No | Enable on-chain revocation |
| `revocation.wallet` | `WalletInterface` | If enabled | Wallet for creating revocation UTXOs |
| `revocation.store` | `RevocationStore` | No | Custom store (default: MemoryRevocationStore) |

## Issuing a Credential

```typescript
const vc = await issuer.issue(
  subjectIdentityKey,
  'employee-badge',
  { name: 'Alice Smith', email: 'alice@company.com', department: 'engineering' }
)

console.log('VC type:', vc.type)
// ['VerifiableCredential', 'EmployeeBadge']

console.log('Subject:', vc.credentialSubject.id)
// 'did:bsv:02abc...'

console.log('Issuer:', vc.issuer)
// 'did:bsv:03def...'
```

### What Happens During Issuance

1. Fields are validated against the schema
2. Computed fields are merged in
3. If revocation is enabled:
   - A random 32-byte secret is generated
   - The SHA-256 hash of the secret creates a hash-lock script: `OP_SHA256 <hash> OP_EQUAL`
   - A 1-satoshi UTXO is created with this script
   - The secret is saved to the revocation store
4. A `MasterCertificate` is issued using the BSV SDK
5. The certificate is wrapped in a W3C Verifiable Credential envelope

### Verifiable Credential Structure

```typescript
{
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential', 'EmployeeBadge'],
  issuer: 'did:bsv:03def...',
  issuanceDate: '2024-02-01T12:00:00.000Z',
  credentialSubject: {
    id: 'did:bsv:02abc...',
    name: 'Alice Smith',
    email: 'alice@company.com',
    department: 'engineering',
    issuedAt: '2024-02-01T12:00:00.000Z',
    verified: 'true'
  },
  credentialStatus: {
    id: 'bsv:txid123.0',
    type: 'BSVHashLockRevocation2024'
  },
  proof: {
    type: 'BSVMasterCertificateProof2024',
    created: '2024-02-01T12:00:00.000Z',
    proofPurpose: 'assertionMethod',
    verificationMethod: 'did:bsv:03def...#key-1',
    signatureValue: 'signature_hex'
  },
  _bsv: {
    certificate: { /* full CertificateData */ }
  }
}
```

## Verifying a Credential

```typescript
const result = await issuer.verify(vc)

console.log('Valid:', result.valid)
console.log('Revoked:', result.revoked)
console.log('Errors:', result.errors)
console.log('Issuer:', result.issuer)
console.log('Subject:', result.subject)
```

Verification checks:
1. W3C `@context` is present
2. `VerifiableCredential` type is present
3. Proof and signature are present
4. BSV certificate data is present
5. Revocation status (if applicable)

## Revoking a Credential

```typescript
const { txid } = await issuer.revoke(cert.serialNumber)
console.log('Revoked, txid:', txid)
```

Revocation spends the hash-lock UTXO by revealing the secret. Once spent, the credential is permanently revoked on-chain.

```typescript
// Check revocation status
const isRevoked = await issuer.isRevoked(cert.serialNumber)
console.log('Is revoked:', isRevoked)
```

## Wallet-Side: Acquiring Credentials

Wallets acquire credentials from remote issuers:

```typescript
const vc = await wallet.acquireCredential({
  serverUrl: 'https://issuer.example.com',
  schemaId: 'employee-badge',
  fields: { name: 'Alice', email: 'alice@co.com' },
  replaceExisting: true
})
```

### List Credentials

```typescript
const vcs = await wallet.listCredentials({
  certifiers: [issuerPublicKey],
  types: [schema.getInfo().certificateTypeBase64]
})

for (const vc of vcs) {
  console.log(vc.credentialSubject)
}
```

### Create a Presentation

Bundle credentials for sharing:

```typescript
const presentation = wallet.createPresentation(vcs)

console.log('Holder:', presentation.holder)
console.log('Credentials:', presentation.verifiableCredential.length)
```

## Server-Side Revocation Store

For production servers, use `FileRevocationStore` to persist secrets to disk:

```typescript
const { FileRevocationStore } = await import('@bsv/simple/server')

const issuer = await CredentialIssuer.create({
  privateKey: key,
  schemas: [schema.getConfig()],
  revocation: {
    enabled: true,
    wallet: serverWallet.getClient(),
    store: new FileRevocationStore('.revocation-secrets.json')
  }
})
```

> **Important:** Add `.revocation-secrets.json` to `.gitignore`. These secrets control credential revocation.

## Complete Example

```typescript
import { createWallet, CredentialSchema, CredentialIssuer, MemoryRevocationStore } from '@bsv/simple/browser'

const wallet = await createWallet()

// Define schema
const schema = new CredentialSchema({
  id: 'age-check',
  name: 'AgeVerification',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'over18', label: 'Over 18', type: 'checkbox', required: true }
  ]
})

// Create issuer (in production, this runs on a server)
const issuer = await CredentialIssuer.create({
  privateKey: 'a1b2c3...',
  schemas: [schema.getConfig()],
  revocation: { enabled: false }
})

// Issue credential
const vc = await issuer.issue(
  wallet.getIdentityKey(),
  'age-check',
  { name: 'Alice', over18: 'true' }
)

// List from wallet
const vcs = await wallet.listCredentials({
  certifiers: [issuer.getInfo().publicKey],
  types: [schema.getInfo().certificateTypeBase64]
})

// Create presentation
const vp = wallet.createPresentation(vcs)
console.log('Presentation holder:', vp.holder)
```
