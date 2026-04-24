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

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.privateKey` | `string` | random | Hex-encoded private key |
| `config.certificateType` | `string` | base64(`'certification'`) | Certificate type identifier |
| `config.defaultFields` | `Record<string, string>` | `{ certified: 'true' }` | Fields included in every certificate |
| `config.includeTimestamp` | `boolean` | `true` | Add `timestamp` field automatically |

**Example:**

```typescript
import { Certifier } from '@bsv/simple/browser'

// Random key (ephemeral certifier)
const certifier = await Certifier.create()

// Persistent certifier with specific key
const certifier = await Certifier.create({
  privateKey: 'a1b2c3d4...',
  certificateType: Utils.toBase64(Utils.toArray('my-cert-type', 'utf8')),
  defaultFields: { role: 'admin', organization: 'ACME' },
  includeTimestamp: true
})
```

### certifier.getInfo()

```typescript
getInfo(): { publicKey: string; certificateType: string }
```

Returns the certifier's public key and certificate type.

### certifier.certify()

```typescript
async certify(
  wallet: WalletCore,
  additionalFields?: Record<string, string>
): Promise<CertificateData>
```

Issue a certificate to a wallet and acquire it into that wallet in one step.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `wallet` | `WalletCore` | Yes | The wallet to certify |
| `additionalFields` | `Record<string, string>` | No | Extra fields beyond defaults |

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
}): Promise<CertificateData>
```

Acquire a certificate from a remote certification server.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.serverUrl` | `string` | *required* | Base URL of the certification server |
| `config.replaceExisting` | `boolean` | `true` | Revoke existing certificates from this certifier first |

**What happens:**
1. Fetches `{serverUrl}/api/info` to get `certifierPublicKey` and `certificateType`
2. If `replaceExisting`, lists and relinquishes existing certs from this certifier
3. POSTs to `{serverUrl}/api/certify` with the wallet's identity key
4. Acquires the returned certificate into the wallet

**Server API contract:**
- `GET /api/info` returns `{ certifierPublicKey: string, certificateType: string }`
- `POST /api/certify` accepts `{ identityKey: string }`, returns `CertificateData`

### listCertificatesFrom()

```typescript
async listCertificatesFrom(config: {
  certifiers: string[]
  types: string[]
  limit?: number
}): Promise<{ totalCertificates: number; certificates: any[] }>
```

List certificates from specific certifiers.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.certifiers` | `string[]` | *required* | Array of certifier public keys |
| `config.types` | `string[]` | *required* | Array of certificate type strings |
| `config.limit` | `number` | `100` | Maximum results |

### relinquishCert()

```typescript
async relinquishCert(args: {
  type: string
  serialNumber: string
  certifier: string
}): Promise<void>
```

Revoke/relinquish a certificate from the wallet.

| Parameter | Type | Description |
|-----------|------|-------------|
| `args.type` | `string` | Certificate type |
| `args.serialNumber` | `string` | Certificate serial number |
| `args.certifier` | `string` | Certifier's public key |
