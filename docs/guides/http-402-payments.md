---
id: guide-http-402
title: "HTTP 402 Payment Gating"
kind: guide
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
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
npm install express body-parser @bsv/sdk @bsv/payment-express-middleware \
  @bsv/auth-express-middleware @bsv/wallet-toolbox dotenv
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

## Step 2 — Set up server wallet and auth middleware

In the server project, create `server.ts`:

```typescript
import express from 'express'
import bodyParser from 'body-parser'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { SetupWallet } from '@bsv/wallet-toolbox'
import dotenv from 'dotenv'

dotenv.config()

async function setupServer() {
  // 1. Initialize wallet
  const wallet = await SetupWallet({
    env: 'test'  // testnet
  })
  
  // 2. Create auth middleware
  // Auth must run first to set req.auth.identityKey
  const authMiddleware = createAuthMiddleware({
    wallet,
    allowUnauthenticated: false
  })
  
  // 3. Create payment middleware
  // Depends on auth being set first
  const paymentMiddleware = createPaymentMiddleware({
    wallet,
    calculateRequestPrice: async (req) => {
      // Dynamic pricing by route
      if (req.path === '/api/premium') return 1000  // 1000 satoshis
      if (req.path === '/api/free') return 0        // Free
      return 100  // Default 100 satoshis
    }
  })
  
  // 4. Build Express app
  const app = express()
  app.use(bodyParser.json())
  app.use(authMiddleware)
  app.use(paymentMiddleware)
  
  // 5. Define routes
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
      sender: req.auth?.identityKey
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
    console.log('- POST /api/free: No payment required')
    console.log('- POST /api/premium: Requires 1000 satoshis')
  })
}

main().catch(console.error)
```

The middleware chain:
1. **Auth middleware** validates client identity (BRC-103)
2. **Payment middleware** checks if payment required, validates if provided
3. **Route handler** receives request only if payment verified (or free)

## Step 3 — Understand the 402 response

When client requests a paid endpoint without payment, the server responds with 402 and payment details.

The payment middleware automatically:
- Calculates required satoshis via `calculateRequestPrice()`
- Returns 402 status if unpaid
- Includes headers:
  - `x-bsv-payment-satoshis-required`: satoshis owed
  - `x-bsv-payment-derivation-prefix`: nonce for client to derive payment address
  - `x-bsv-payment-version`: protocol version

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
2. Receives 402 with `x-bsv-payment-satoshis-required: 1000`
3. Derives payment address from server's nonce (BRC-29)
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
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { SetupWallet } from '@bsv/wallet-toolbox'

async function main() {
  // Setup wallet
  const wallet = await SetupWallet({ env: 'test' })
  
  // Setup middleware
  const authMiddleware = createAuthMiddleware({ wallet })
  const paymentMiddleware = createPaymentMiddleware({
    wallet,
    calculateRequestPrice: async (req) => {
      if (req.path === '/api/premium') return 1000
      if (req.path === '/api/free') return 0
      return 100
    }
  })
  
  // Create app
  const app = express()
  app.use(bodyParser.json())
  app.use(authMiddleware)
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
→ Payment middleware expects `req.auth.identityKey` set by auth middleware. Ensure auth runs before payment in middleware chain

**"Wallet must implement internalizeAction()"**
→ Server wallet must have `internalizeAction()` method for validating payments. Use `SetupWallet()` or custom BRC-100 wallet

**"Nonce verification failed"**
→ Client must use exact `derivationPrefix` from 402 response. Don't modify or cache the prefix across requests

**"Transaction format error"**
→ Client sends `x-bsv-payment` header as JSON. Ensure BEEF format is valid; invalid transactions are rejected

**"Timestamp must be fresh"**
→ `x-bsv-time` must be within ~30 seconds of server time. Check system clocks if repeatedly failing

**"Cache timeout too long"**
→ If cache timeout is very long, client may use stale payments for different resources. Use moderate timeout (30 min is safe)

**"Replay protection"**
→ Server wallet rejects duplicate `derivationPrefix` values. Each payment must use a fresh nonce

## What to read next

- **[402-Pay Package Reference](/docs/packages/402-pay/)** — Client and server APIs
- **[Payment Express Middleware](/docs/packages/payment-express-middleware/)** — Detailed middleware config
- **[BRC-121 Specification](/docs/specs/brc-121/)** — HTTP 402 Payment Required protocol
- **[BRC-29 Key Derivation](/docs/specs/brc-29/)** — Payment address generation
- **[Wallet-Toolbox Reference](/docs/packages/wallet-toolbox/)** — Wallet configuration
