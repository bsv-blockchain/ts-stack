# ServerWallet

`ServerWallet` is the composed wallet type for server-side (Node.js) applications. It extends [`WalletCore`](wallet-core.md) with server-specific payment receiving methods, plus all module methods mixed in.

**Source:** `src/server.ts`

**Import:**

```typescript
// In Next.js API routes, always use dynamic import:
const { ServerWallet } = await import('@bsv/simple/server')

// In standalone Node.js scripts:
import { ServerWallet } from '@bsv/simple/server'
```

> **Important:** In Next.js, use `await import()` instead of static `import` at the top of the file. Static imports cause Turbopack bundling issues.

## Type Definition

```typescript
type ServerWallet = _ServerWallet
  & ReturnType<typeof createTokenMethods>
  & ReturnType<typeof createInscriptionMethods>
  & ReturnType<typeof createMessageBoxMethods>
  & ReturnType<typeof createCertificationMethods>
  & ReturnType<typeof createOverlayMethods>
  & ReturnType<typeof createDIDMethods>
  & ReturnType<typeof createCredentialMethods>
```

## ServerWallet.create()

```typescript
namespace ServerWallet {
  async function create(config: ServerWalletConfig): Promise<ServerWallet>
}
```

Factory function that creates a fully-composed `ServerWallet`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config.privateKey` | `string` | Yes | Hex-encoded private key |
| `config.network` | `Network` | No | `'main'` (default) or `'testnet'` |
| `config.storageUrl` | `string` | No | Storage service URL (default: `'https://storage.babbage.systems'`) |

**What happens:**
1. Creates a `PrivateKey` and `KeyDeriver` from the hex key
2. Initializes `WalletStorageManager` and `WalletSigner`
3. Connects to the storage service via `StorageClient`
4. Mixes in all module methods

**Example:**

```typescript
const wallet = await ServerWallet.create({
  privateKey: process.env.SERVER_PRIVATE_KEY!,
  network: 'main',
  storageUrl: 'https://storage.babbage.systems'
})
```

## Server-Specific Methods

### createPaymentRequest()

```typescript
createPaymentRequest(options: { satoshis: number; memo?: string }): PaymentRequest
```

Generate a BRC-29 payment request that a browser wallet can fulfill.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options.satoshis` | `number` | Yes | Amount requested |
| `options.memo` | `string` | No | Human-readable memo |

**Returns:**

```typescript
{
  serverIdentityKey: string      // Server's public key
  derivationPrefix: string       // Base64-encoded prefix
  derivationSuffix: string       // Base64-encoded random suffix
  satoshis: number               // Requested amount
  memo?: string                  // Optional memo
}
```

### receivePayment()

```typescript
async receivePayment(payment: IncomingPayment): Promise<void>
```

Internalize a payment received from a browser wallet using the `wallet payment` protocol.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `payment.tx` | `number[] \| Uint8Array` | Yes | AtomicBEEF transaction bytes |
| `payment.senderIdentityKey` | `string` | Yes | Sender's identity key |
| `payment.derivationPrefix` | `string` | Yes | BRC-29 derivation prefix |
| `payment.derivationSuffix` | `string` | Yes | BRC-29 derivation suffix |
| `payment.outputIndex` | `number` | Yes | Index of the payment output |
| `payment.description` | `string` | No | Transaction description |

## Shared Methods

`ServerWallet` inherits all methods from [`WalletCore`](wallet-core.md) and all module methods (tokens, inscriptions, messagebox, certification, overlay, DID, credentials). See the [BrowserWallet](browser-wallet.md) page for the full method listing.

## Funding Flow

The typical server wallet funding flow:

```
1. Server: wallet.createPaymentRequest({ satoshis: 50000 })
       ↓ (send PaymentRequest to client via API)
2. Client: wallet.fundServerWallet(request, 'funding')
       ↓ (send tx bytes back to server via API)
3. Server: wallet.receivePayment({ tx, senderIdentityKey, ... })
```

See the [Server Wallet Guide](../guides/server-wallet.md) for a complete example.

## Key Persistence

In production, set the private key via environment variable:

```bash
SERVER_PRIVATE_KEY=a1b2c3d4e5f6...
```

For development, persist to a file so the wallet identity survives server restarts:

```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { PrivateKey } from '@bsv/sdk'

const WALLET_FILE = '.server-wallet.json'

function getPrivateKey(): string {
  if (process.env.SERVER_PRIVATE_KEY) return process.env.SERVER_PRIVATE_KEY
  if (existsSync(WALLET_FILE)) {
    return JSON.parse(readFileSync(WALLET_FILE, 'utf-8')).privateKey
  }
  const key = PrivateKey.fromRandom().toHex()
  writeFileSync(WALLET_FILE, JSON.stringify({ privateKey: key }, null, 2))
  return key
}
```

> Add `.server-wallet.json` to `.gitignore`.

## Dependencies

`ServerWallet` requires `@bsv/wallet-toolbox`, which is a Node.js-only dependency. It must be listed in `serverExternalPackages` in `next.config.ts` to avoid Turbopack bundling it for the browser:

```typescript
serverExternalPackages: ["@bsv/wallet-toolbox", "knex", "better-sqlite3", ...]
```
