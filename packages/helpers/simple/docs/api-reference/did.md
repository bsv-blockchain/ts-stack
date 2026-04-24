# DID Module

The DID module provides W3C-compatible Decentralized Identifiers (`did:bsv:`) backed by BSV identity keys. It includes the standalone `DID` utility class and wallet-integrated methods.

**Source:** `src/modules/did.ts`

## DID Class

The `DID` class is a standalone utility — no wallet instance required.

```typescript
import { DID } from '@bsv/simple/browser'
```

### DID.fromIdentityKey()

```typescript
static fromIdentityKey(identityKey: string): DIDDocument
```

Generate a W3C DID Document from a compressed public key.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identityKey` | `string` | 66-character hex compressed public key |

**Returns:** [`DIDDocument`](types.md#diddocument)

**Throws:** `DIDError` if the identity key is not a valid 66-character hex string.

```typescript
const doc = DID.fromIdentityKey('02a1b2c3...')
// {
//   '@context': ['https://www.w3.org/ns/did/v1'],
//   id: 'did:bsv:02a1b2c3...',
//   controller: 'did:bsv:02a1b2c3...',
//   verificationMethod: [{
//     id: 'did:bsv:02a1b2c3...#key-1',
//     type: 'EcdsaSecp256k1VerificationKey2019',
//     controller: 'did:bsv:02a1b2c3...',
//     publicKeyHex: '02a1b2c3...'
//   }],
//   authentication: ['did:bsv:02a1b2c3...#key-1'],
//   assertionMethod: ['did:bsv:02a1b2c3...#key-1']
// }
```

### DID.parse()

```typescript
static parse(didString: string): DIDParseResult
```

Parse a `did:bsv:` string and extract the identity key.

| Parameter | Type | Description |
|-----------|------|-------------|
| `didString` | `string` | A `did:bsv:` DID string |

**Returns:**

```typescript
{ method: 'bsv', identityKey: string }
```

**Throws:** `DIDError` if the format is invalid.

### DID.isValid()

```typescript
static isValid(didString: string): boolean
```

Validate a `did:bsv:` string format.

| Parameter | Type | Description |
|-----------|------|-------------|
| `didString` | `string` | String to validate |

**Returns:** `true` if the string is a valid `did:bsv:` DID, `false` otherwise.

```typescript
DID.isValid('did:bsv:02a1b2c3...')  // true
DID.isValid('did:eth:0x123')         // false
DID.isValid('not-a-did')             // false
```

### DID.getCertificateType()

```typescript
static getCertificateType(): string
```

Get the base64-encoded certificate type used for DID persistence.

**Returns:** Base64 encoding of `'did:bsv'`.

## Wallet Methods

### getDID()

```typescript
getDID(): DIDDocument
```

Get this wallet's DID Document. **Synchronous** — builds the document from the identity key.

```typescript
const doc = wallet.getDID()
console.log(doc.id) // 'did:bsv:02abc...'
```

### resolveDID()

```typescript
resolveDID(didString: string): DIDDocument
```

Resolve any `did:bsv:` string to its DID Document. **Synchronous**.

| Parameter | Type | Description |
|-----------|------|-------------|
| `didString` | `string` | A `did:bsv:` DID string |

**Throws:** `DIDError` if the DID format is invalid.

```typescript
const doc = wallet.resolveDID('did:bsv:03def456...')
console.log(doc.verificationMethod[0].publicKeyHex) // '03def456...'
```

### registerDID()

```typescript
async registerDID(options?: { persist?: boolean }): Promise<DIDDocument>
```

Persist this wallet's DID as a BSV certificate.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `options.persist` | `boolean` | `true` | If `false`, returns the DID Document without persisting |

**What happens:**
1. Builds the DID Document from the identity key
2. Creates an ephemeral `Certifier` with `certificateType: DID.getCertificateType()`
3. Issues a certificate containing:
   - `didId`: The full DID string
   - `didType`: `'identity'`
   - `version`: `'1.0'`
   - `created`: ISO timestamp
   - `isDID`: `'true'`

**Throws:** `DIDError` if registration fails.

```typescript
const doc = await wallet.registerDID()
console.log('Registered:', doc.id)
```
