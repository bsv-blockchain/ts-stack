# CLAUDE.md — @bsv/402-pay

## Purpose (1-2 sentences)

BRC-121 HTTP 402 Payment Required handler for client and server. Client-side: auto-pays 402 responses. Server-side: middleware/validation for accepting BSV micropayments over HTTP.

## Public API surface

### Server (@bsv/402-pay/server)
- `createPaymentMiddleware(opts: PaymentMiddlewareOptions): Express middleware` — Express middleware for automatic 402 handling
  - `opts.wallet: WalletInterface` — Wallet to accept payment into
  - `opts.calculatePrice(path: string): number | undefined` — Return satoshi price or undefined to skip payment
  - Sets `req.payment` on success
- `validatePayment(req: Request, wallet: WalletInterface): Promise<PaymentResult | null>` — Validate incoming payment headers
- `send402(res: Response, serverIdentityKey: string, satoshis: number): void` — Send 402 response with payment request headers

### Client (@bsv/402-pay/client)
- `create402Fetch(opts: Payment402Options): typeof fetch` — Fetch wrapper that auto-handles 402 responses
  - `opts.wallet: WalletInterface` — Wallet to pay with
  - `opts.cacheTimeoutMs?: number` — Cache paid content (default: 30 min)
  - Returns fetch-compatible function with `.clearCache()` method
- `constructPaymentHeaders(wallet: WalletInterface, url: string, satoshis: number, serverIdentityKey: string): Promise<PaymentHeaders>` — Build payment headers manually

### Types
- `PaymentMiddlewareOptions` — Middleware configuration
- `PaymentResult` — Parsed payment { sats: number, sender: string, txid: string, ... }
- `PaymentHeaders` — Five required headers { x-bsv-beef, x-bsv-sender, x-bsv-nonce, x-bsv-time, x-bsv-vout }
- `Payment402Options` — Client configuration
- `PaymentRequest` — Server's 402 request
- `PaymentResponse` — Payment validation response

### Constants & Exports
- `HEADERS` — Header names enum (BEEF, SENDER, NONCE, TIME, VOUT)
- `BRC29_PROTOCOL_ID` — Protocol ID for payment key derivation
- `DEFAULT_PAYMENT_WINDOW_MS` — Timestamp freshness window (30 seconds)

## Real usage patterns

```typescript
// ===== SERVER SIDE =====
import express from 'express'
import { createPaymentMiddleware } from '@bsv/402-pay/server'

const app = express()

app.use('/articles/:slug', createPaymentMiddleware({
  wallet,  // WalletInterface
  calculatePrice: (path) => {
    if (path.includes('/premium/')) return 1000  // 1000 sats
    return undefined  // Free content
  }
}))

app.get('/articles/:slug', (req, res) => {
  // req.payment is set if payment was accepted
  if (req.payment) {
    res.json({ article: 'Paid content here', paidBy: req.payment.sender })
  } else {
    res.json({ article: 'Free content' })
  }
})

// Or low-level:
import { validatePayment, send402 } from '@bsv/402-pay/server'

app.get('/premium', async (req, res) => {
  const result = await validatePayment(req, wallet)
  if (!result) {
    send402(res, serverIdentityKey, 100)  // Request 100 sats
    return
  }
  res.json({ content: 'Premium stuff', tx: result.txid })
})

// ===== CLIENT SIDE =====
import { create402Fetch } from '@bsv/402-pay/client'

const fetch402 = create402Fetch({
  wallet,  // WalletClient
  cacheTimeoutMs: 30 * 60 * 1000  // Cache for 30 minutes
})

// Automatically handles 402 with payment
const response = await fetch402('https://example.com/articles/foo')
const article = await response.json()
console.log(article)

// Clear cache between sessions
fetch402.clearCache()

// Or construct headers manually for custom fetch:
import { constructPaymentHeaders } from '@bsv/402-pay/client'

const headers = await constructPaymentHeaders(
  wallet,
  'https://example.com/articles/foo',
  100,  // 100 sats
  serverPublicKey
)

const res = await fetch('https://example.com/articles/foo', { headers })
```

## Key concepts

- **402 Payment Required** — HTTP status code for micropayments (BRC-121)
- **Server Headers (402 response):**
  - `x-bsv-sats` — Satoshi amount required
  - `x-bsv-server` — Server identity public key (for key derivation)
- **Client Headers (payment request):**
  - `x-bsv-beef` — Base64-encoded transaction proof
  - `x-bsv-sender` — Client identity public key
  - `x-bsv-nonce` — Derivation prefix (random 8 bytes, Base64)
  - `x-bsv-time` — Unix millisecond timestamp
  - `x-bsv-vout` — Output index (usually 0)
- **Replay Protection:**
  1. Timestamp freshness — `x-bsv-time` must be within 30 seconds of server
  2. Transaction uniqueness — `internalizeAction` returns `isMerge: true` for duplicates
- **Key Derivation** — Client derives payment pubkey via BRC-29 using server's identity key + nonce + timestamp
- **Caching** — Client can cache paid content per URL to avoid re-payment within timeout
- **P2PKH Script** — Payment is always P2PKH: `OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG`

## Dependencies

**Runtime:**
- `@bsv/sdk` ^2.0.14 (PublicKey, Utils, Random, WalletInterface, WalletClient)

**Peer:**
- `@bsv/sdk` (peer dependency; application must provide)

**Dev:**
- TypeScript, Vitest, @types/node

## Common pitfalls / gotchas

1. **Timestamp must be fresh** — If `x-bsv-time` is >30 seconds old, payment is rejected
2. **Server identity key required** — Server must send its identity public key in 402 response; client uses it for key derivation
3. **Transaction uniqueness** — Replaying same BEEF twice is rejected; nonce must be different
4. **Cache timeout too long** — If cached, same content is served without payment check; short timeout (e.g., 30 min) recommended
5. **BEEF must be valid** — Malformed or invalid BEEF transaction is rejected during validation
6. **Wallet not available** — Client-side `create402Fetch` requires working WalletClient; fails if wallet is not installed/running
7. **calculatePrice undefined** — If price calculator returns undefined, payment is skipped (content is free)
8. **Server clock skew** — If server and client clocks differ by >30 seconds, payment fails; use NTP

## Spec conformance

- **BRC-121** — HTTP 402 Payment Required micropayments
- **BRC-29** — Key derivation (payment pubkey via nonce + timestamp)
- **BRC-42** — Public key derivation
- **BRC-100** — Wallet interface
- **P2PKH** — Standard Bitcoin SV locking script
- **BEEF** — Transaction proof format

## File map

```
402-pay/
  src/
    index.ts                    # Main exports (all modules)
    server.ts                   # createPaymentMiddleware, validatePayment, send402
    client.ts                   # create402Fetch, constructPaymentHeaders
    constants.ts                # HEADERS, BRC29_PROTOCOL_ID, DEFAULT_PAYMENT_WINDOW_MS
    server.test.ts              # Server tests
    client.test.ts              # Client tests
    constants.test.ts           # Constants tests
```

## Integration points

- **Depends on:** `@bsv/sdk` (WalletClient, WalletInterface, PublicKey, Utils)
- **Used by:** HTTP servers and clients implementing micropayments (paywalls, API gateways, content platforms)
- **Complements:** `@bsv/simple` (wallet instance for payments), any HTTP framework (Express, Hono, etc.)
