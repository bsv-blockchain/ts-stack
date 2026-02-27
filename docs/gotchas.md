# Gotchas & Pitfalls

Common mistakes and non-obvious behaviors when working with `@bsv/simple` and the BSV wallet ecosystem.

## 1. Basket Insertion vs Wallet Payment

These two internalization protocols are **mutually exclusive**. You cannot use both on the same output.

| Protocol | Use Case | Output Visible in Basket? | Can Wallet Spend? |
|----------|----------|--------------------------|-------------------|
| `basket insertion` | Store output in a named basket for tracking | Yes | Via `customInstructions` |
| `wallet payment` | Receive a payment with derivation info | No | Yes (derivation-based) |

```typescript
// basket insertion — output appears in listOutputs('my-basket')
protocol: 'basket insertion',
insertionRemittance: { basket: 'my-basket', customInstructions: '...', tags: [] }

// wallet payment — output is spendable but NOT in any basket
protocol: 'wallet payment',
paymentRemittance: { senderIdentityKey, derivationPrefix, derivationSuffix }
```

If you need both trackability and spendability, use `basket insertion` and store the derivation info in `customInstructions`.

## 2. PeerPayClient.acceptPayment() Silently Fails

The `@bsv/message-box-client` library's `acceptPayment()` returns a string `'Unable to receive payment!'` instead of throwing an error.

```typescript
// WRONG — silently fails
await peerPay.acceptPayment(payment)

// CORRECT — check return value
const result = await peerPay.acceptPayment(payment)
if (typeof result === 'string') throw new Error(result)
```

`@bsv/simple` handles this check internally, but be aware if you ever use `@bsv/message-box-client` directly.

## 3. result.tx May Be Undefined

`createAction()` doesn't always return transaction bytes.

```typescript
const result = await wallet.getClient().createAction({ ... })

// WRONG — may crash
Transaction.fromAtomicBEEF(result.tx)

// CORRECT — check first
if (!result.tx) {
  console.warn('No tx bytes available')
  return
}
```

## 4. Overlay Prefix Requirements

Topics must start with `tm_`, lookup services must start with `ls_`. The library throws immediately if these prefixes are missing.

```typescript
// THROWS: Topic "payments" must start with "tm_" prefix
await Overlay.create({ topics: ['payments'] })

// CORRECT
await Overlay.create({ topics: ['tm_payments'] })
```

Same for SLAP advertisements:

```typescript
// THROWS
await wallet.advertiseSLAP('domain.com', 'payments')

// CORRECT
await wallet.advertiseSLAP('domain.com', 'ls_payments')
```

## 5. FileRevocationStore Crashes in Browser

`FileRevocationStore` uses Node.js `fs` and `path` modules. Importing it in browser code causes a crash.

```typescript
// BROWSER — use MemoryRevocationStore
import { MemoryRevocationStore } from '@bsv/simple/browser'

// SERVER — use FileRevocationStore
const { FileRevocationStore } = await import('@bsv/simple/server')
```

## 6. Use Handler Factories for API Routes

Don't write manual server wallet boilerplate — use the pre-built handler factories. They handle lazy initialization, key persistence, caching, and error recovery automatically.

```typescript
// WRONG — manual boilerplate (100+ lines of code)
import { NextRequest, NextResponse } from 'next/server'
let serverWallet: any = null
// ... 100 lines of init, caching, GET/POST handlers ...

// CORRECT — 3 lines with handler factory
import { createServerWalletHandler } from '@bsv/simple/server'
const handler = createServerWalletHandler()
export const GET = handler.GET, POST = handler.POST
```

Available handler factories:
- `createServerWalletHandler()` — Server wallet with key persistence
- `createIdentityRegistryHandler()` — MessageBox identity registry
- `createDIDResolverHandler()` — DID resolution proxy (nChain + WoC fallback)
- `createCredentialIssuerHandler()` — W3C Verifiable Credential issuer

## 7. No Need to Import @bsv/sdk

Never import `@bsv/sdk` in consumer code. Use `generatePrivateKey()` from `@bsv/simple/server`:

```typescript
// WRONG
import { PrivateKey } from '@bsv/sdk'
const key = PrivateKey.fromRandom().toHex()

// CORRECT
import { generatePrivateKey } from '@bsv/simple/server'
const key = generatePrivateKey()
```

## 8. Token Send/Redeem Requires Two-Step Signing

Token transfers use a `createAction` → `signAction` flow because PushDrop outputs need a custom unlocking script. Don't try to send tokens using `pay()` or raw `createAction()` — use `sendToken()` or `redeemToken()`.

## 9. next.config.ts serverExternalPackages Is Required

Without the `serverExternalPackages` configuration, Next.js Turbopack bundles `@bsv/wallet-toolbox`, `knex`, and database drivers for the browser, causing build failures:

```typescript
const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@bsv/wallet-toolbox", "knex", "better-sqlite3", "tedious",
    "mysql", "mysql2", "pg", "pg-query-stream", "oracledb", "dotenv"
  ]
}
```

## 10. BRC-29 Protocol ID

The payment derivation protocol ID is `[2, '3241645161d8']`. This is a `SecurityLevel` 2 protocol. Don't confuse it with other protocol IDs.

```typescript
const protocolID: [SecurityLevel, string] = [2, '3241645161d8']
```
