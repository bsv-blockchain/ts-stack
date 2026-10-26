# Certification Module

The certification module provides the standalone `Certifier` class for issuing BSV `MasterCertificate` credentials, plus wallet methods for acquiring, listing, and revoking certificates.

**Source:** `src/modules/certification.ts`

## Certifier Class

### Certifier.create()

```typescript
static async create(config?: {
  privateKey?: string
  certificateType?: string
  defaultFields?: Record<string, string>
  includeTimestamp?: boolean
}): Promise<Certifier>
```

Create a new certifier instance.

| Parameter                 | Type                     | Default                            | Description                                                                                                 |
| ------------------------- | ------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `config.privateKey`       | `string`                 | random                             | Hex-encoded private key                                                                                     |
| `config.certificateType`  | `string`                 | base64(SHA-256(`'certification'`)) | Canonical 32-byte type, or a historical short type to canonicalize and retain as an offline-migration alias |
| `config.defaultFields`    | `Record<string, string>` | `{ certified: 'true' }`            | Fields included in every certificate                                                                        |
| `config.includeTimestamp` | `boolean`                | `true`                             | Add `timestamp` field automatically                                                                         |

**Example:**

```typescript
import { Certifier } from '@bsv/simple/browser'

// Random key (ephemeral certifier)
const certifier = await Certifier.create()

// Persistent certifier with specific key
const certifier = await Certifier.create({
  privateKey: 'a1b2c3d4...',
  certificateType: Certifier.getCanonicalCertificateType(),
  defaultFields: { role: 'admin', organization: 'ACME' },
  includeTimestamp: true
})
```

### certifier.getInfo()

```typescript
getInfo(): { publicKey: string; certificateType: string }
```

Returns the certifier's public key and certificate type.

`certificateType` is always a canonical 32-byte identifier and is safe to use
with current SDK wallet and remote-service APIs.

### Certificate type migration

```typescript
Certifier.getCanonicalCertificateType(): string
Certifier.getLegacyCertificateType(): string
certifier.getCertificateTypeMigration(): { canonical: string; legacy: string[] }
```

Pre-0.6 default certifiers used the short base64 encoding of `certification`.
New issuance uses its 32-byte SHA-256 digest. Passing a short historical
`certificateType` to `create()` records it as a legacy alias and derives the
canonical issuance type from its decoded bytes; it never issues a new short
type.

The SDK 4.0.0 compatibility candidate permits bounded historical types in
existing listing, proof and relinquishment calls, while signing/acquisition and
remote issuance metadata remain strictly 32 bytes. Legacy binary use requires
upgraded app and wallet adapters; storage servers must upgrade their SDK for
legacy relinquishment. Older SDKs may reject these references. Do not hash,
pad or rewrite an existing signed type. See the repository protocol contract
at `specs/wallet/legacy-certificate-wire.md`.

### certifier.certify()

```typescript
async certify(
  wallet: WalletCore,
  additionalFields?: Record<string, string>
): Promise<CertificateData>
```

Issue a certificate to a wallet and acquire it into that wallet in one step.

| Parameter          | Type                     | Required | Description                  |
| ------------------ | ------------------------ | -------- | ---------------------------- |
| `wallet`           | `WalletCore`             | Yes      | The wallet to certify        |
| `additionalFields` | `Record<string, string>` | No       | Extra fields beyond defaults |

**Returns:** [`CertificateData`](types.md#certificatedata)

**What happens:**

1. Merges `defaultFields` + `additionalFields` + optional `timestamp`
2. Issues a `MasterCertificate` via `MasterCertificate.issueCertificateForSubject()`
3. Calls `wallet.getClient().acquireCertificate()` to store it in the wallet
4. Returns the full certificate data

```typescript
const cert = await certifier.certify(wallet, { department: 'engineering' })
// cert.fields: { certified: 'true', department: 'engineering', timestamp: '1706...' }
```

## Wallet Methods

### acquireCertificateFrom()

```typescript
async acquireCertificateFrom(config: {
  serverUrl: string
  replaceExisting?: boolean
  fetch?: typeof fetch
}): Promise<CertificateData>
```

Acquire a certificate from a remote certification server.

| Parameter                | Type           | Default              | Description                                                         |
| ------------------------ | -------------- | -------------------- | ------------------------------------------------------------------- |
| `config.serverUrl`       | `string`       | _required_           | Credential-free public HTTPS service URL without query or fragment  |
| `config.replaceExisting` | `boolean`      | `true`               | Import the authenticated replacement, then relinquish older serials |
| `config.fetch`           | `typeof fetch` | restricted transport | Explicitly trusted override for controlled tests/local development  |

**What happens:**

1. Fetches `?action=info` under a deadline, response limit, redirect refusal, and same-public-origin policy
2. POSTs to `?action=certify` with the wallet's canonical identity key
3. Authenticates and binds the certificate signature, certifier, type, and subject
4. Requires the wallet's exact acquisition result
5. If `replaceExisting`, relinquishes only older serials after successful import

**Server API contract:**

- `GET ?action=info` returns `{ certifierPublicKey: string, certificateType: string }`, where `certificateType` encodes exactly 32 bytes
- `POST ?action=certify` accepts `{ identityKey: string }`, returns `CertificateData`

### listCertificatesFrom()

```typescript
async listCertificatesFrom(config: {
  certifiers: string[]
  types: string[]
  limit?: number
}): Promise<{ totalCertificates: number; certificates: any[] }>
```

List certificates from specific certifiers.

| Parameter           | Type       | Default    | Description                                         |
| ------------------- | ---------- | ---------- | --------------------------------------------------- |
| `config.certifiers` | `string[]` | _required_ | Array of certifier public keys                      |
| `config.types`      | `string[]` | _required_ | Array of canonical 32-byte certificate type strings |
| `config.limit`      | `number`   | `100`      | Maximum results                                     |

### relinquishCert()

```typescript
async relinquishCert(args: {
  type: string
  serialNumber: string
  certifier: string
}): Promise<void>
```

Revoke/relinquish a certificate from the wallet.

| Parameter           | Type     | Description               |
| ------------------- | -------- | ------------------------- |
| `args.type`         | `string` | Certificate type          |
| `args.serialNumber` | `string` | Certificate serial number |
| `args.certifier`    | `string` | Certifier's public key    |
