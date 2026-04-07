# Browser Wallet

The browser wallet connects to the user's BSV wallet extension (such as MetaNet Client) and provides a full-featured API for blockchain operations.

## Connecting

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()
```

This prompts the user to approve the connection. Once approved, the wallet is ready to use.

### With Custom Defaults

```typescript
const wallet = await createWallet({
  network: 'main',
  tokenBasket: 'my-tokens',        // default basket for tokens
  messageBoxHost: 'https://messagebox.babbage.systems',
  registryUrl: '/api/identity-registry'
})
```

Any default can be overridden per-method call.

## Wallet Info

```typescript
// Identity key (compressed public key, 66 hex chars)
const key = wallet.getIdentityKey()
// '02a1b2c3d4...'

// P2PKH address
const address = wallet.getAddress()
// '1A2b3C4d5E...'

// Status object
const status = wallet.getStatus()
// { isConnected: true, identityKey: '02a1b2...', network: 'main' }

// Full info object
const info = wallet.getWalletInfo()
// { identityKey, address, network, isConnected }
```

## Balance

```typescript
// Overall wallet balance (optimized, no output iteration)
const balance = await wallet.getBalance()
console.log(`${balance.totalSatoshis} sats`)

// Balance for a specific basket
const tokenBalance = await wallet.getBalance('tokens')
console.log(`${tokenBalance.spendableOutputs} spendable, ${tokenBalance.spendableSatoshis} sats`)
```

## Key Derivation

Derive public keys for specific protocols and counterparties.

### Generic Derivation

```typescript
const derivedKey = await wallet.derivePublicKey(
  [2, '3241645161d8'],   // protocol ID (BRC-29 in this case)
  'invoice-001',          // key ID
  recipientIdentityKey,   // counterparty
  false                   // forSelf
)
```

### BRC-29 Payment Key

A convenience method for deriving BRC-29 payment keys:

```typescript
const paymentKey = await wallet.derivePaymentKey(
  recipientIdentityKey,
  'invoice-001'    // optional invoice number
)
```

This uses protocol ID `[2, '3241645161d8']` internally.

## Accessing the Underlying Client

For advanced operations that aren't covered by the simple API:

```typescript
const client = wallet.getClient()

// Now you can call raw @bsv/sdk methods
const result = await client.createAction({ ... })
await client.listOutputs({ basket: 'my-basket', include: 'locking scripts' })
```

## Default Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `network` | `'main'` | Network to operate on |
| `description` | `'BSV-Simplify transaction'` | Default transaction description |
| `outputDescription` | `'BSV-Simplify output'` | Default output description |
| `tokenBasket` | `'tokens'` | Default basket for token operations |
| `tokenProtocolID` | `[0, 'token']` | Default PushDrop protocol ID |
| `tokenKeyID` | `'1'` | Default PushDrop key ID |
| `messageBoxHost` | `'https://messagebox.babbage.systems'` | MessageBox server URL |
| `registryUrl` | `undefined` | Identity registry API URL |

## Type Reference

```typescript
import type { BrowserWallet } from '@bsv/simple/browser'
import type { WalletStatus, WalletInfo, WalletDefaults } from '@bsv/simple'
```
