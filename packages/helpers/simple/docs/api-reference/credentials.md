# Credentials Module

The credentials module provides W3C Verifiable Credentials backed by BSV `MasterCertificate` cryptography. It includes schema definition, credential issuance/verification/revocation, and wallet-side acquisition.

**Source:** `src/modules/credentials.ts`

## CredentialSchema

Defines the fields, validation, and computed values for a credential type.

### Constructor

```typescript
new CredentialSchema(config: CredentialSchemaConfig)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.id` | `string` | Unique schema identifier |
| `config.name` | `string` | Human-readable name |
| `config.description` | `string?` | Optional description |
| `config.certificateTypeBase64` | `string?` | Custom certificate type (default: base64 of `id`) |
| `config.fields` | `CredentialFieldSchema[]` | Field definitions |
| `config.fieldGroups` | `{ key, label }[]?` | Optional field grouping |
| `config.validate` | `(values) => string \| null` | Custom validation function |
| `config.computedFields` | `(values) => Record<string, string>` | Add/transform fields at issuance |

### schema.validate()

```typescript
validate(values: Record<string, string>): string | null
```

Validate field values. Returns `null` if valid, or an error message string.

Checks:
1. Required fields are present and non-empty
2. Custom `validate` function (if provided)

### schema.computeFields()

```typescript
computeFields(values: Record<string, string>): Record<string, string>
```

Merge computed fields into values. Returns a new object with original values plus computed additions.

### schema.getInfo()

```typescript
getInfo(): {
  id: string
  name: string
  description?: string
  certificateTypeBase64: string
  fieldCount: number
}
```

### schema.getConfig()

```typescript
getConfig(): CredentialSchemaConfig
```

Returns the full configuration object. Used when creating a `CredentialIssuer`.

## CredentialIssuer

Issues, verifies, and revokes Verifiable Credentials.

### CredentialIssuer.create()

```typescript
static async create(config: CredentialIssuerConfig): Promise<CredentialIssuer>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config.privateKey` | `string` | Yes | Hex-encoded private key |
| `config.schemas` | `CredentialSchemaConfig[]` | No | Schema definitions |
| `config.revocation.enabled` | `boolean` | No | Enable on-chain revocation |
| `config.revocation.wallet` | `WalletInterface` | If enabled | Wallet for creating revocation UTXOs |
| `config.revocation.store` | `RevocationStore` | No | Storage backend (default: `MemoryRevocationStore`) |

**Throws:** `CredentialError` if revocation is enabled but no wallet is provided.

### issuer.issue()

```typescript
async issue(
  subjectIdentityKey: string,
  schemaId: string,
  fields: Record<string, string>
): Promise<VerifiableCredential>
```

Issue a Verifiable Credential.

| Parameter | Type | Description |
|-----------|------|-------------|
| `subjectIdentityKey` | `string` | Subject's compressed public key |
| `schemaId` | `string` | ID of a registered schema |
| `fields` | `Record<string, string>` | Field values |

**What happens:**
1. Validates fields against the schema
2. Merges computed fields
3. If revocation enabled: creates a hash-lock UTXO (`OP_SHA256 <hash> OP_EQUAL`, 1 satoshi), saves secret to store
4. Issues a `MasterCertificate`
5. Wraps in W3C Verifiable Credential format

**Throws:** `CredentialError` if schema not found or validation fails.

### issuer.verify()

```typescript
async verify(vc: VerifiableCredential): Promise<VerificationResult>
```

Verify a Verifiable Credential.

**Returns:**

```typescript
{
  valid: boolean      // true if all checks pass
  revoked: boolean    // true if credential has been revoked
  errors: string[]    // list of validation errors
  issuer?: string     // issuer DID
  subject?: string    // subject DID
  type?: string       // credential types joined
}
```

**Checks:**
1. W3C `@context` is present
2. `VerifiableCredential` type is present
3. Proof and signature are present
4. BSV certificate data is present
5. Revocation status (checks if secret still exists in store)

### issuer.revoke()

```typescript
async revoke(serialNumber: string): Promise<{ txid: string }>
```

Revoke a credential by spending its hash-lock UTXO.

| Parameter | Type | Description |
|-----------|------|-------------|
| `serialNumber` | `string` | Certificate serial number |

**What happens:**
1. Loads the revocation record (secret + outpoint) from the store
2. Creates an unlocking script with the secret
3. Spends the hash-lock UTXO
4. Deletes the record from the store

**Throws:** `CredentialError` if revocation is not enabled, or the certificate is not found/already revoked.

### issuer.isRevoked()

```typescript
async isRevoked(serialNumber: string): Promise<boolean>
```

Check if a credential has been revoked. Returns `true` if the revocation record no longer exists in the store.

### issuer.getInfo()

```typescript
getInfo(): {
  publicKey: string
  did: string
  schemas: { id: string; name: string }[]
}
```

## Revocation Stores

### MemoryRevocationStore

In-memory storage for browser and tests.

```typescript
import { MemoryRevocationStore } from '@bsv/simple/browser'
const store = new MemoryRevocationStore()
```

### FileRevocationStore

File-based storage for Node.js servers.

```typescript
const { FileRevocationStore } = await import('@bsv/simple/server')
const store = new FileRevocationStore()                        // default: .revocation-secrets.json
const store = new FileRevocationStore('/path/to/secrets.json') // custom path
```

> Add the secrets file to `.gitignore`.

### RevocationStore Interface

Both stores implement:

```typescript
interface RevocationStore {
  save(serialNumber: string, record: RevocationRecord): Promise<void>
  load(serialNumber: string): Promise<RevocationRecord | undefined>
  delete(serialNumber: string): Promise<void>
  has(serialNumber: string): Promise<boolean>
  findByOutpoint(outpoint: string): Promise<boolean>
}
```

## Standalone Utilities

### toVerifiableCredential()

```typescript
function toVerifiableCredential(
  cert: CertificateData,
  issuerKey: string,
  options?: { credentialType?: string }
): VerifiableCredential
```

Wrap a BSV `CertificateData` into a W3C Verifiable Credential envelope.

### toVerifiablePresentation()

```typescript
function toVerifiablePresentation(
  credentials: VerifiableCredential[],
  holderKey: string
): VerifiablePresentation
```

Wrap an array of VCs into a W3C Verifiable Presentation.

## Wallet Methods

### acquireCredential()

```typescript
async acquireCredential(config: {
  serverUrl: string
  schemaId?: string
  fields?: Record<string, string>
  replaceExisting?: boolean
}): Promise<VerifiableCredential>
```

Acquire a Verifiable Credential from a remote issuer server.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.serverUrl` | `string` | *required* | Issuer server base URL |
| `config.schemaId` | `string` | — | Schema to request |
| `config.fields` | `Record<string, string>` | — | Field values to submit |
| `config.replaceExisting` | `boolean` | `true` | Revoke existing certs first |

### listCredentials()

```typescript
async listCredentials(config: {
  certifiers: string[]
  types: string[]
  limit?: number
}): Promise<VerifiableCredential[]>
```

List wallet certificates wrapped as Verifiable Credentials.

### createPresentation()

```typescript
createPresentation(credentials: VerifiableCredential[]): VerifiablePresentation
```

Wrap Verifiable Credentials into a Verifiable Presentation. **Synchronous**.
