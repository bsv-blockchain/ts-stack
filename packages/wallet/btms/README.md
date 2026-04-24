# @bsv/btms

**Basic Token Management System** - A modular library for managing UTXO-based tokens on the BSV blockchain.

## Overview

BTMS Core provides a clean, well-architected API for:
- **Issuing** new fungible tokens with customizable metadata
- **Sending** tokens to other users
- **Receiving** tokens from others
- **Querying** balances and asset information

The library is designed to work with the BSV overlay network and aligns exactly with the `BTMSTopicManager` protocol.

## Start Here for BTMS Builders

If you are building a token-enabled app, this is the primary package to use: `@bsv/btms`.

## Related Docs

- Project index: [`../README.md`](../README.md)
- Overlay backend (Topic Manager + Lookup Service): [`../backend/README.md`](../backend/README.md)
- Frontend app and live deployment (`https://btms.metanet.app`): [`../frontend/README.md`](../frontend/README.md)
- Wallet integration modules (BRC-100 via BRC-98/99 hooks): [`../permission-module/README.md`](../permission-module/README.md), [`../permission-module-ui/README.md`](../permission-module-ui/README.md)

## Installation

```bash
npm install @bsv/btms @bsv/sdk
```

## Quick Start

```typescript
import { BTMS } from '@bsv/btms'
import { MessageBoxClient } from '@bsv/message-box-client'

// Create a BTMS instance with MessageBoxClient for token delivery
const comms = new MessageBoxClient()
const btms = new BTMS({ 
  networkPreset: 'mainnet',
  comms
})

// Issue new tokens
const result = await btms.issue(1000000, {
  name: 'GOLD',
  description: 'Represents 1 gram of gold'
})
console.log('Asset ID:', result.assetId) // e.g., 'abc123...def.0'

// Check balance
const balance = await btms.getBalance(result.assetId)
console.log('Balance:', balance)

// Send tokens to someone (automatically delivered via MessageBoxClient)
const sendResult = await btms.send(
  result.assetId,
  '03abc123...', // recipient's identity public key
  100
)

// List incoming tokens
const incoming = await btms.listIncoming()
for (const payment of incoming) {
  console.log(`Incoming: ${payment.amount} of ${payment.assetId}`)
  // Accept the payment
  await btms.accept(payment)
}

// List all your assets
const assets = await btms.listAssets()
for (const asset of assets) {
  console.log(`${asset.name}: ${asset.balance}`)
}
```

## Token Protocol

BTMS uses a 3-field PushDrop token format that aligns with the `BTMSTopicManager`:

| Field | Description |
|-------|-------------|
| 0 | Asset ID (or `"ISSUE"` for new tokens) |
| 1 | Amount (positive integer as UTF-8 string) |
| 2 | Metadata (optional JSON string) |

### Issuance

When issuing new tokens, field 0 is set to `"ISSUE"`. After the transaction is mined, the canonical asset ID becomes `{txid}.{outputIndex}` (e.g., `abc123...def.0`).

### Transfers

When transferring tokens, field 0 contains the canonical asset ID. The TopicManager enforces:
- Total output amounts cannot exceed input amounts for the same asset
- Metadata must match across inputs/outputs for the same asset

## API Reference

### BTMS Class

The main class for token operations.

#### Constructor

```typescript
const btms = new BTMS(config?: BTMSConfig)
```

**Configuration Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wallet` | `WalletInterface` | `WalletClient()` | Wallet for signing transactions |
| `networkPreset` | `'local' \| 'mainnet' \| 'testnet'` | `'mainnet'` | Network for overlay services |
| `comms` | `CommsLayer` | `undefined` | Optional communications layer (e.g., MessageBoxClient) |

#### Methods

##### `issue(amount, metadata?)`

Issue new tokens with the specified amount and optional metadata.

```typescript
const result = await btms.issue(1000, {
  name: 'GOLD',
  description: 'A test token',
  iconURL: 'https://example.com/icon.png'
})

// Result:
// {
//   success: true,
//   txid: 'abc123...',
//   assetId: 'abc123...def.0',
//   outputIndex: 0,
//   amount: 1000
// }
```

The token will be stored in basket `p btms <assetId>` where `assetId` is the canonical `txid.0` format.

##### `send(assetId, recipient, amount)`

Send tokens to a recipient.

```typescript
const result = await btms.send(
  'abc123...def.0',  // asset ID
  '03abc123...',     // recipient's identity public key
  100                // amount to send
)

// Result:
// {
//   success: true,
//   txid: 'def456...',
//   tokenForRecipient: { ... },
//   changeAmount: 900
// }
```

##### `accept(payment)`

Accept an incoming token payment.

```typescript
const incoming = await btms.listIncoming()
for (const payment of incoming) {
  const result = await btms.accept(payment)
  console.log(`Accepted ${result.amount} tokens`)
}
```

##### `burn(assetId, amount?)`

Permanently destroy tokens by burning them.

```typescript
// Burn specific amount
const result = await btms.burn('abc123...def.0', 100)

// Burn entire balance (amount optional)
const result = await btms.burn('abc123...def.0')

// Result:
// {
//   success: true,
//   txid: 'def456...',
//   assetId: 'abc123...def.0',
//   amountBurned: 100
// }
```

##### `getBalance(assetId)`

Get the balance of a specific asset.

```typescript
const balance = await btms.getBalance('abc123...def.0')
console.log('Balance:', balance)
```

##### `listAssets()`

List all assets owned by this wallet.

```typescript
const assets = await btms.listAssets()
// Returns: BTMSAsset[]
```

##### `getSpendableTokens(assetId)`

Get all spendable token UTXOs for an asset.

```typescript
const utxos = await btms.getSpendableTokens('abc123...def.0')
// Returns: BTMSTokenOutput[]
```

### BTMSToken Class

Low-level class for encoding and decoding tokens.

```typescript
import { BTMSToken } from '@bsv/btms'

// Decode a token from a locking script
const decoded = BTMSToken.decode(lockingScriptHex)
if (decoded.valid) {
  console.log('Asset:', decoded.assetId)
  console.log('Amount:', decoded.amount)
  console.log('Metadata:', decoded.metadata)
}

// Check if a token is an issuance
const isIssue = BTMSToken.isIssuance(decoded)

// Validate asset ID format
const isValid = BTMSToken.isValidAssetId('abc123...def.0')

// Compute asset ID from txid and output index
const assetId = BTMSToken.computeAssetId(txid, 0)
```

## Types

### BTMSAsset

```typescript
interface BTMSAsset {
  assetId: string
  name?: string
  balance: number
  metadata?: BTMSAssetMetadata
  hasPendingIncoming?: boolean
}
```

### BTMSAssetMetadata

```typescript
interface BTMSAssetMetadata {
  name?: string
  description?: string
  iconURL?: string
  [key: string]: unknown
}
```

### IssueResult

```typescript
interface IssueResult {
  success: boolean
  txid: string
  assetId: string
  vout: number
  amount: number
  error?: string
}
```

### SendResult

```typescript
interface SendResult {
  success: boolean
  txid: string
  tokenForRecipient: TokenForRecipient
  changeAmount?: number
  error?: string
}
```

### BurnResult

```typescript
interface BurnResult {
  success: boolean
  txid: string
  assetId: string
  amountBurned: number
  error?: string
}
```

## Extensibility

### Ownership Proofs

BTMS supports cryptographic ownership proofs using key linkage:

```typescript
// Prover creates a proof for a verifier
const proof = await btms.proveOwnership(
  'abc123...def.0',  // asset ID
  100,               // amount to prove
  verifierPubKey     // verifier's identity key
)

// Verifier validates the proof
const result = await btms.verifyOwnership(proof)
if (result.valid) {
  console.log(`Verified ${result.amount} tokens owned by ${result.prover}`)
}
```

This enables use cases like:
- Collateral verification for loans
- Marketplace escrow-free trading
- Access control / token gating
- Auditing and compliance

### Marketplace (Future)

The type system includes `MarketplaceListing` and `MarketplaceOffer` types for future atomic swap functionality.

## Architecture

```
@bsv/btms/
├── src/
│   ├── index.ts          # Public API exports
│   ├── BTMS.ts           # Main BTMS class
│   ├── BTMSToken.ts      # Token encoding/decoding
│   ├── types.ts          # TypeScript interfaces
│   ├── constants.ts      # Protocol constants
│   └── __tests__/        # Test files
├── package.json
└── README.md
```

## Integration with Overlay Services

BTMS Core works with the BTMS overlay services:

- **Topic Manager**: `tm_btms` - Validates token transactions
- **Lookup Service**: `ls_btms` - Indexes and queries tokens

For overlay deployment, see the `@bsv/btms-backend` package.

## License

See LICENSE.txt
