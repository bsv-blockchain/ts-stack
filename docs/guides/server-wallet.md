# Server Wallet

The server wallet runs on Node.js using a private key and `@bsv/wallet-toolbox`. It's used for automated operations, payment processing, and funding flows where no user interaction is needed.

## Creating a Server Wallet

```typescript
import { ServerWallet } from '@bsv/simple/server'

const wallet = await ServerWallet.create({
  privateKey: process.env.SERVER_PRIVATE_KEY!,
  network: 'main',
  storageUrl: 'https://storage.babbage.systems'
})

console.log('Identity Key:', wallet.getIdentityKey())
```

### Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `privateKey` | `string` | *required* | Hex-encoded private key |
| `network` | `'main' \| 'testnet'` | `'main'` | Network to operate on |
| `storageUrl` | `string` | `'https://storage.babbage.systems'` | Wallet storage provider URL |

### What Happens During Creation

1. A `PrivateKey` and `KeyDeriver` are created from the hex key
2. A `WalletStorageManager`, `WalletSigner`, and `Services` instance are configured
3. A `StorageClient` connects to the storage URL and becomes available
4. The `ToolboxWallet` is instantiated and all module methods are mixed in
5. The composed `ServerWallet` is returned

## Funding Flow

The server wallet uses a request/response pattern to receive funds from a browser wallet:

### Step 1: Server Creates a Payment Request

```typescript
const request = wallet.createPaymentRequest({
  satoshis: 50000,
  memo: 'Server wallet funding'
})
// Returns: { serverIdentityKey, derivationPrefix, derivationSuffix, satoshis, memo }
```

This generates a random BRC-29 derivation suffix so the server can later prove ownership of the payment.

### Step 2: Browser Wallet Funds the Server

```typescript
// On the client (browser):
const result = await browserWallet.fundServerWallet(
  paymentRequest,
  'server-funding'       // basket for tracking
)
```

### Step 3: Client Sends Transaction to Server

```typescript
await fetch('/api/server-wallet?action=receive', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tx: Array.from(result.tx),
    senderIdentityKey: browserWallet.getIdentityKey(),
    derivationPrefix: paymentRequest.derivationPrefix,
    derivationSuffix: paymentRequest.derivationSuffix,
    outputIndex: 0
  })
})
```

### Step 4: Server Internalizes the Payment

```typescript
await wallet.receivePayment({
  tx: txBytesFromClient,
  senderIdentityKey: clientIdentityKey,
  derivationPrefix: request.derivationPrefix,
  derivationSuffix: request.derivationSuffix,
  outputIndex: 0
})
```

This uses the `wallet payment` protocol to internalize the output with proper derivation info, so the server wallet can spend it later.

## Private Key Persistence

Key persistence is handled automatically by handler factories. If you need lower-level access, use `generatePrivateKey()` instead of importing `@bsv/sdk`:

```typescript
import { generatePrivateKey } from '@bsv/simple/server'
const key = process.env.SERVER_PRIVATE_KEY || generatePrivateKey()
```

For Next.js API routes, use the handler factory which manages key persistence automatically:

```typescript
// app/api/server-wallet/route.ts
import { createServerWalletHandler } from '@bsv/simple/server'
const handler = createServerWalletHandler()
export const GET = handler.GET, POST = handler.POST
```

Key persistence order (automatic):
1. `process.env.SERVER_PRIVATE_KEY` — Environment variable (production)
2. `.server-wallet.json` file — Persisted from previous run (development)
3. Auto-generated via `generatePrivateKey()` — Fresh key (first run)

> **Important:** Add `.server-wallet.json` to your `.gitignore`. Never commit private keys.

## Shared Methods

The server wallet has all the same methods as the browser wallet:

- `pay()`, `send()`
- `createToken()`, `listTokenDetails()`, `sendToken()`, `redeemToken()`
- `inscribeText()`, `inscribeJSON()`, `inscribeFileHash()`, `inscribeImageHash()`
- `certifyForMessageBox()`, `sendMessageBoxPayment()`, `listIncomingPayments()`, `acceptIncomingPayment()`
- `acquireCertificateFrom()`, `listCertificatesFrom()`, `relinquishCert()`
- `getDID()`, `resolveDID()`, `registerDID()`
- `acquireCredential()`, `listCredentials()`, `createPresentation()`
- `advertiseSHIP()`, `advertiseSLAP()`, `broadcastAction()`, `withRetry()`

## Next.js API Route Example

See the [Next.js Integration Guide](nextjs-integration.md) for a complete API route implementation with caching and key persistence.
