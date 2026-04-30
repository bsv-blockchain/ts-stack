---
id: guide-http-402
title: "HTTP 402 Payment Gating"
kind: guide
version: "1.0.0"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
review_cadence_days: 30
status: stable
tags: [guide, payments, http-402, brc-121, monetization]
---

# HTTP 402 Payment Gating

> Monetize your API with Bitcoin SV micropayments. You'll set up a payment-gated Express server and build a client that auto-pays for content using HTTP 402 Payment Required.

**Time:** ~25 minutes
**Prerequisites:** Node.js ≥ 20, basic Express.js, understanding of Bitcoin transactions

## What you'll build

A complete end-to-end payment system:
- **Server**: Express middleware that gates endpoints by payment, validates transactions
- **Client**: Auto-paying fetch wrapper that transparently handles 402 responses
- **Flow**: Client requests resource → server responds 402 with payment details → client signs & pays → access granted

By the end, you'll have a production-ready micropayment system that doesn't require user friction.

## Prerequisites

- Node.js 20+ installed
- npm or pnpm
- A BRC-100 wallet (server and client)
- Basic understanding of Bitcoin transactions and satoshis
- A private key for the server identity

## Step 1 — Create server and client projects

Set up two separate projects:

```bash
# Server
mkdir payment-server && cd payment-server
npm init -y
npm install express body-parser @bsv/sdk @bsv/402-pay @bsv/simple dotenv
npm install -D typescript ts-node @types/express @types/node

# Client (in separate directory)
mkdir ../payment-client && cd ../payment-client
npm init -y
npm install @bsv/402-pay @bsv/sdk dotenv
npm install -D typescript ts-node @types/node
```

Both need TypeScript config:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true
  }
}
```

## Step 2 — Set up server wallet and payment middleware

In the server project, create `server.ts`:

```typescript
import express from 'express'
import bodyParser from 'body-parser'
import { createPaymentMiddleware } from '@bsv/402-pay/server'
import { ServerWallet } from '@bsv/simple/server'
import dotenv from 'dotenv'

dotenv.config()

async function setupServer() {
  // 1. Initialize wallet
  const wallet = await ServerWallet.create({
    privateKey: process.env.SERVER_PRIVATE_KEY!,
    network: 'main',
    storageUrl: 'https://store-us-1.bsvb.tech'
  })
  
  // 2. Create payment middleware
  const paymentMiddleware = createPaymentMiddleware({
    wallet,
    calculatePrice: (path) => {
      // Dynamic pricing by route
      if (path === '/api/premium') return 1000  // 1000 satoshis
      if (path === '/api/free') return 0        // Free
      return 100  // Default 100 satoshis
    }
  })
  
  // 3. Build Express app
  const app = express()
  app.use(bodyParser.json())
  app.use(paymentMiddleware)
  
  // 4. Define routes
  app.get('/api/free', (req, res) => {
    res.json({
      message: 'Free content',
      paid: false
    })
  })
  
  app.get('/api/premium', (req, res) => {
    res.json({
      message: 'Premium content — paid!',
      paid: true,
      satoshisPaid: req.payment?.satoshisPaid || 0,
      sender: req.payment?.senderIdentityKey
    })
  })
  
  return app
}

// Start server
async function main() {
  const app = await setupServer()
  const port = process.env.PORT || 3000
  
  app.listen(port, () => {
    console.log(`Payment server running on http://localhost:${port}`)
    console.log('- GET /api/free: No payment required')
    console.log('- GET /api/premium: Requires 1000 satoshis')
  })
}

main().catch(console.error)
```

The middleware chain:
1. **Payment middleware** checks if payment is required and validates provided payment headers
2. **Route handler** receives the request only if payment was accepted or the route is free

## Step 3 — Understand the 402 response

When client requests a paid endpoint without payment, the server responds with 402 and payment details.

The payment middleware automatically:
- Calculates required satoshis via `calculatePrice()`
- Returns 402 status if unpaid
- Includes headers:
  - `x-bsv-sats`: satoshis owed
  - `x-bsv-server`: server identity key used by the client for payment derivation

## Step 4 — Set up client wallet and create 402-pay wrapper

In the client project, create `client.ts`:

```typescript
import { create402Fetch } from '@bsv/402-pay/client'
import { WalletClient } from '@bsv/sdk'
import dotenv from 'dotenv'

dotenv.config()

export async function setupPaymentClient() {
  // Initialize wallet for signing payments
  const wallet = new WalletClient()
  
  // Create a fetch wrapper that auto-handles 402
  const fetch402 = create402Fetch({
    wallet,
    cacheTimeoutMs: 30 * 60 * 1000  // Cache paid content for 30 minutes
  })
  
  return fetch402
}
```

`create402Fetch()` returns a fetch-compatible function that:
- Catches 402 responses
- Signs a payment transaction
- Retries with payment headers
- Caches successful responses to avoid re-payment

## Step 5 — Make authenticated requests with auto-payment

Create `requests.ts` in client:

```typescript
export async function accessFreeContent(fetch402: any) {
  const response = await fetch402('http://localhost:3000/api/free')
  const data = await response.json()
  
  console.log('Free content:', data)
  return data
}

export async function accessPremiumContent(fetch402: any) {
  // Automatically handles 402 and pays
  const response = await fetch402('http://localhost:3000/api/premium')
  const data = await response.json()
  
  console.log('Premium content:', data)
  return data
}

export async function clearPaymentCache(fetch402: any) {
  // Reset cache between sessions
  fetch402.clearCache()
  console.log('Payment cache cleared')
}
```

When client calls `fetch402('/api/premium')`:
1. Sends request (no payment)
2. Receives 402 with `x-bsv-sats: 1000` and `x-bsv-server`
3. Generates a fresh nonce and timestamp, then derives the payment address with BRC-29
4. Creates and signs payment transaction
5. Retries request with payment headers
6. Server validates payment
7. Access granted, response cached

## Step 6 — Manual payment construction (advanced)

For custom workflows, construct payment headers manually:

```typescript
import { constructPaymentHeaders } from '@bsv/402-pay/client'

export async function manualPayment(
  wallet: any,
  serverUrl: string,
  satoshis: number,
  serverIdentityKey: string
) {
  // Build payment headers manually
  const headers = await constructPaymentHeaders(
    wallet,
    serverUrl,
    satoshis,
    serverIdentityKey
  )
  
  // Use with custom fetch
  const response = await fetch(serverUrl, { headers })
  return response
}
```

Manual header construction gives you:
- `x-bsv-beef`: Base64-encoded transaction proof
- `x-bsv-sender`: Your identity public key
- `x-bsv-nonce`: Derivation prefix (random 8 bytes)
- `x-bsv-time`: Unix millisecond timestamp
- `x-bsv-vout`: Output index (usually 0)

## Putting it all together

Server `main.ts`:

```typescript
import express from 'express'
import bodyParser from 'body-parser'
import { createPaymentMiddleware } from '@bsv/402-pay/server'
import { ServerWallet } from '@bsv/simple/server'

async function main() {
  // Setup wallet
  const wallet = await ServerWallet.create({
    privateKey: process.env.SERVER_PRIVATE_KEY!,
    network: 'main',
    storageUrl: 'https://store-us-1.bsvb.tech'
  })
  
  // Setup middleware
  const paymentMiddleware = createPaymentMiddleware({
    wallet,
    calculatePrice: (path) => {
      if (path === '/api/premium') return 1000
      if (path === '/api/free') return 0
      return 100
    }
  })
  
  // Create app
  const app = express()
  app.use(bodyParser.json())
  app.use(paymentMiddleware)
  
  // Routes
  app.get('/api/free', (req, res) => {
    res.json({ message: 'Free content', paid: false })
  })
  
  app.get('/api/premium', (req, res) => {
    res.json({
      message: 'Premium content',
      paid: true,
      satoshisPaid: req.payment?.satoshisPaid || 0
    })
  })
  
  // Start
  app.listen(3000, () => {
    console.log('Server on http://localhost:3000')
  })
}

main().catch(console.error)
```

Client `main.ts`:

```typescript
import { create402Fetch } from '@bsv/402-pay/client'
import { WalletClient } from '@bsv/sdk'

async function main() {
  // Setup wallet
  const wallet = new WalletClient()
  
  // Create auto-paying fetch
  const fetch402 = create402Fetch({
    wallet,
    cacheTimeoutMs: 30 * 60 * 1000
  })
  
  console.log('Accessing free content...')
  let response = await fetch402('http://localhost:3000/api/free')
  let data = await response.json()
  console.log('Free:', data)
  
  console.log('\nAccessing premium content (will auto-pay 1000 sats)...')
  response = await fetch402('http://localhost:3000/api/premium')
  data = await response.json()
  console.log('Premium:', data)
  
  console.log('\nAccessing premium again (cached, no new payment)...')
  response = await fetch402('http://localhost:3000/api/premium')
  data = await response.json()
  console.log('Premium (cached):', data)
}

main().catch(console.error)
```

Run:

```bash
# Terminal 1: Server
cd payment-server
npx ts-node main.ts

# Terminal 2: Client
cd payment-client
npx ts-node main.ts
```

## Troubleshooting

**"Auth middleware must run first"**
→ This applies to `@bsv/payment-express-middleware`, not `@bsv/402-pay`. The `@bsv/402-pay` middleware is independent and does not require BRC-31 auth.

**"Wallet must implement getPublicKey() and internalizeAction()"**
→ Server wallet must expose an identity key and accept wallet-payment internalization. Use `ServerWallet.create()` from `@bsv/simple/server` or another BRC-100 wallet implementation.

**"Payment keeps getting requested"**
→ The retried request must include `x-bsv-beef`, `x-bsv-sender`, `x-bsv-nonce`, `x-bsv-time`, and `x-bsv-vout`. `create402Fetch()` adds those automatically.

**"Transaction format error"**
→ Client sends the payment transaction as base64 BEEF in `x-bsv-beef`. Ensure the wallet returned `tx` from `createAction()`.

**"Timestamp must be fresh"**
→ `x-bsv-time` must be within ~30 seconds of server time. Check system clocks if repeatedly failing

**"Cache timeout too long"**
→ If cache timeout is very long, client may use stale payments for different resources. Use moderate timeout (30 min is safe)

**"Replay protection"**
→ Server wallet rejects duplicate payment internalization. Each payment must use a fresh nonce and transaction.

## What to read next

- **[402-Pay Package Reference](../packages/middleware/402-pay.md)** — Client and server APIs
- **[Payment Express Middleware](../packages/middleware/payment-express-middleware.md)** — Auth-required 402 middleware variant
- **[BRC-121 Specification](../specs/brc-121-402.md)** — HTTP 402 Payment Required protocol
- **[BRC-29 Key Derivation](../specs/brc-29-peer-payment.md)** — Payment address generation
- **[Wallet-Toolbox Reference](../packages/wallet/wallet-toolbox.md)** — Wallet configuration
