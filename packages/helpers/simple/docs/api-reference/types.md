# Types

All shared TypeScript interfaces and types used across `@bsv/simple`.

**Source:** `src/core/types.ts`

## Common

### Network

```typescript
type Network = 'main' | 'testnet'
```

## Configuration

### WalletDefaults

```typescript
interface WalletDefaults {
  network: Network
  description: string
  outputDescription: string
  tokenBasket: string
  tokenProtocolID: [SecurityLevel, string]
  tokenKeyID: string
  messageBoxHost: string
  registryUrl?: string
  registryFetch?: typeof fetch
}
```

**Default values:**

| Field               | Default                                |
| ------------------- | -------------------------------------- |
| `network`           | `'main'`                               |
| `description`       | `'BSV-Simplify transaction'`           |
| `outputDescription` | `'BSV-Simplify output'`                |
| `tokenBasket`       | `'tokens'`                             |
| `tokenProtocolID`   | `[0, 'token']`                         |
| `tokenKeyID`        | `'1'`                                  |
| `messageBoxHost`    | `'https://messagebox.babbage.systems'` |
| `registryUrl`       | `undefined`                            |
| `registryFetch`     | `undefined`                            |

Without `registryFetch`, registry requests require public HTTPS and enforce
DNS-address validation and connection pinning. Set this callback only for an
explicitly trusted local/private transport.

## Wallet Status

### WalletStatus

```typescript
interface WalletStatus {
  isConnected: boolean
  identityKey: string | null
  network: string
}
```

### WalletInfo

```typescript
interface WalletInfo {
  identityKey: string
  address: string
  network: string
  isConnected: boolean
}
```

### BalanceResult

```typescript
interface BalanceResult {
  totalSatoshis: number // sum of all output satoshis
  totalOutputs: number // count of outputs
  spendableSatoshis: number // sum of spendable output satoshis
  spendableOutputs: number // count of spendable outputs
}
```

## Transaction Results

### TransactionResult

```typescript
interface TransactionResult {
  txid: string
  tx: any // AtomicBEEF bytes (number[])
  outputs?: OutputInfo[]
}
```

### OutputInfo

```typescript
interface OutputInfo {
  index: number
  satoshis: number
  lockingScript: string
  description?: string
}
```

### SendResult

```typescript
interface SendResult extends TransactionResult {
  outputDetails: SendOutputDetail[]
}
```

### SendOutputDetail

```typescript
interface SendOutputDetail {
  index: number
  type: 'p2pkh' | 'op_return' | 'pushdrop'
  satoshis: number
  description: string
}
```

## Payment Types

### PaymentOptions

```typescript
interface PaymentOptions {
  to: string // Recipient identity key
  satoshis: number // Amount
  memo?: string // Optional memo
  description?: string // Transaction description
}
```

### SendOptions

```typescript
interface SendOptions {
  outputs: SendOutputSpec[]
  description?: string
}
```

### SendOutputSpec

```typescript
interface SendOutputSpec {
  to?: string // Recipient public key
  satoshis?: number // Amount
  data?: (string | object | number[])[] // Data fields
  description?: string // Output description
  basket?: string // Track in basket
  protocolID?: [number, string] // PushDrop protocol ID
  keyID?: string // PushDrop key ID
}
```

**Output routing rules:**

| `to` | `data` | Result    |
| ---- | ------ | --------- |
| Yes  | No     | P2PKH     |
| No   | Yes    | OP_RETURN |
| Yes  | Yes    | PushDrop  |

## Derivation Types

### DerivationInfo

```typescript
interface DerivationInfo {
  counterparty: string
  protocolID: WalletProtocol
  keyID: string
  publicKey: string
}
```

### PaymentDerivation

```typescript
interface PaymentDerivation {
  derivationPrefix: string
  derivationSuffix: string
  publicKey: string
}
```

## Token Types

### TokenOptions

```typescript
interface TokenOptions {
  to?: string // Recipient (default: self)
  data: any // Token data (serialized to JSON)
  basket?: string // Basket (default: 'tokens')
  protocolID?: [number, string] // PushDrop protocol
  keyID?: string // PushDrop key ID
  satoshis?: number // Locked sats (default: 1)
}
```

### TokenResult

```typescript
interface TokenResult extends TransactionResult {
  basket: string
  encrypted: boolean
}
```

### TokenDetail

```typescript
interface TokenDetail {
  outpoint: string // "txid.vout"
  satoshis: number
  data: any // Decrypted token data
  protocolID: any
  keyID: string
  counterparty: string
}
```

### SendTokenOptions

```typescript
interface SendTokenOptions {
  basket: string // Source basket
  outpoint: string // Token outpoint
  to: string // Recipient public key
}
```

### RedeemTokenOptions

```typescript
interface RedeemTokenOptions {
  basket: string // Source basket
  outpoint: string // Token outpoint
}
```

## Inscription Types

### InscriptionType

```typescript
type InscriptionType = 'text' | 'json' | 'file-hash' | 'image-hash'
```

### InscriptionOptions

```typescript
interface InscriptionOptions {
  data: string | object
  type: InscriptionType
  basket?: string
  description?: string
}
```

### InscriptionResult

```typescript
interface InscriptionResult extends TransactionResult {
  type: InscriptionType
  dataSize: number
  basket: string
}
```

## MessageBox Types

### MessageBoxConfig

```typescript
interface MessageBoxConfig {
  host?: string
  enableLogging?: boolean
}
```

## Certification Types

### CertifierConfig

```typescript
interface CertifierConfig {
  privateKey?: string
  // Short historical values are hashed for new issuance and retained only as migration aliases.
  certificateType?: string
  defaultFields?: Record<string, string>
  includeTimestamp?: boolean
}
```

### CertificateData

```typescript
interface CertificateData {
  type: string
  serialNumber: string
  subject: string
  certifier: string
  revocationOutpoint: string
  fields: Record<string, string>
  signature: string
  keyringForSubject: Record<string, string>
}
```

## Server Wallet Types

### ServerWalletConfig

```typescript
interface ServerWalletConfig {
  privateKey: string
  network?: Network
  storageUrl?: string
}
```

### PaymentRequest

```typescript
interface PaymentRequest {
  serverIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
  satoshis: number
  memo?: string
}
```

### IncomingPayment

```typescript
interface IncomingPayment {
  tx: number[] | Uint8Array
  senderIdentityKey: string
  derivationPrefix: string
  derivationSuffix: string
  outputIndex: number
  description?: string
}
```

## Overlay Types

### OverlayConfig

```typescript
interface OverlayConfig {
  topics: string[]
  network?: 'mainnet' | 'testnet' | 'teratestnet' | 'local'
  requireAckFromAllHosts?: 'all' | 'any' | string[]
  requireAckFromAnyHost?: 'all' | 'any' | string[]
  slapTrackers?: string[]
  hostOverrides?: Record<string, string[]>
  additionalHosts?: Record<string, string[]>
}
```

### OverlayInfo

```typescript
interface OverlayInfo {
  topics: string[]
  network: string
  admittanceInstructions?: string
}
```

### OverlayBroadcastResult

```typescript
interface OverlayBroadcastResult {
  success: boolean
  txid?: string
  steak?: Record<
    string,
    {
      outputsToAdmit: number[]
      coinsToRetain: number[]
      coinsRemoved?: number[]
    }
  >
  code?: string
  description?: string
}
```

### OverlayOutput

```typescript
interface OverlayOutput {
  beef: number[]
  outputIndex: number
  context?: number[]
}
```

## DID Types

`DidDocument` and `DidResolutionResult` are re-exported from `@bsv/did`. Documents use a Multikey and the BRC-202 verification relationships; successful metadata is empty. See the [DID API](did.md).

## Credential Types

### CredentialFieldType

```typescript
type CredentialFieldType = 'text' | 'email' | 'date' | 'number' | 'textarea' | 'checkbox' | 'select'
```

### CredentialFieldSchema

```typescript
interface CredentialFieldSchema {
  key: string
  label: string
  type: CredentialFieldType
  required?: boolean
  placeholder?: string
  format?: string
  options?: { value: string; label: string }[]
  helpText?: string
  group?: string
}
```

### CredentialSchemaConfig

```typescript
interface CredentialSchemaConfig {
  id: string
  name: string
  description?: string
  certificateTypeBase64?: string
  legacyCertificateTypesBase64?: string[]
  fields: CredentialFieldSchema[]
  fieldGroups?: { key: string; label: string }[]
  validate?: (values: Record<string, string>) => string | null
  computedFields?: (values: Record<string, string>) => Record<string, string>
}
```

### CredentialIssuerConfig

```typescript
interface CredentialIssuerConfig {
  privateKey: string
  schemas?: CredentialSchemaConfig[]
  revocation?: {
    enabled: boolean
    wallet?: any // WalletInterface
    store?: RevocationStore
  }
}
```

### BRC52Envelope and BRC52VerificationResult

Re-exported from `@bsv/did`. An envelope has `profile`, `certificateBinary`, and `credential`, with optional `disclosure` under the explicit recipient-keyring protocol. Verification returns `verified`, `verifiedDocument`, `mediaType`, and `errors`. It supplies no issuer trust, holder authentication, disclosure authorization, or automatic chain status.

### IssuedCredential

```typescript
interface IssuedCredential {
  credential: BRC52Envelope
  keyringForSubject: Record<string, string>
}
```

Keep subject keyrings outside the authenticated credential graph and deliver only to the authorized subject.

### RevocationRecord

```typescript
interface RevocationRecord {
  secret: string // Hex-encoded secret
  outpoint: string // "txid.vout"
  beef: number[] // BEEF bytes of the revocation UTXO tx
}
```

### RevocationStore

```typescript
interface RevocationStore {
  save(serialNumber: string, record: RevocationRecord): Promise<void>
  load(serialNumber: string): Promise<RevocationRecord | undefined>
  delete(serialNumber: string): Promise<void>
  has(serialNumber: string): Promise<boolean>
  findByOutpoint(outpoint: string): Promise<boolean>
}
```
