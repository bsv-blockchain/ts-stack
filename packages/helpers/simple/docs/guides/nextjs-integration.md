# Next.js Integration

This guide covers setting up `@bsv/simple` in a Next.js application with both browser wallet (client components) and server wallet (API routes).

## 1. Install Dependencies

```bash
npm install @bsv/simple
```

> **Note:** `@bsv/sdk` is NOT needed as a direct dependency — `@bsv/simple` wraps it entirely.

## 2. Configure next.config.ts

This is **required**. Without it, Turbopack will try to bundle server-only packages (`@bsv/wallet-toolbox`, database drivers) for the browser, causing build failures.

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@bsv/wallet-toolbox",
    "knex",
    "better-sqlite3",
    "tedious",
    "mysql",
    "mysql2",
    "pg",
    "pg-query-stream",
    "oracledb",
    "dotenv"
  ]
};

export default nextConfig;
```

## 3. Browser Wallet (Client Components)

### Basic Page

```typescript
// app/page.tsx
'use client'

import { useState } from 'react'
import { createWallet, type BrowserWallet } from '@bsv/simple/browser'

export default function Page() {
  const [wallet, setWallet] = useState<BrowserWallet | null>(null)
  const [status, setStatus] = useState('Not connected')

  const connect = async () => {
    try {
      const w = await createWallet()
      setWallet(w)
      setStatus(`Connected: ${w.getAddress()}`)
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`)
    }
  }

  const sendPayment = async () => {
    if (!wallet) return
    const result = await wallet.pay({
      to: recipientKey,
      satoshis: 1000
    })
    setStatus(`Sent! TXID: ${result.txid}`)
  }

  return (
    <div>
      <p>{status}</p>
      {!wallet ? (
        <button onClick={connect}>Connect Wallet</button>
      ) : (
        <button onClick={sendPayment}>Send 1000 sats</button>
      )}
    </div>
  )
}
```

### Auto-Check MessageBox on Connect

```typescript
const connect = async () => {
  const w = await createWallet()
  setWallet(w)

  // Check if already registered on MessageBox
  const handle = await w.getMessageBoxHandle('/api/identity-registry')
  if (handle) {
    setStatus(`Connected as ${handle}`)
  } else {
    setStatus(`Connected: ${w.getIdentityKey().substring(0, 20)}...`)
  }
}
```

## 4. Server API Routes (Handler Factories)

All server routes use pre-built handler factories — no boilerplate needed. Each factory handles lazy initialization, key persistence, error handling, and all API actions automatically.

### Server Wallet

```typescript
// app/api/server-wallet/route.ts
import { createServerWalletHandler } from '@bsv/simple/server'
const handler = createServerWalletHandler()
export const GET = handler.GET, POST = handler.POST
```

**API endpoints:**
- `GET ?action=create` — Server identity key + status
- `GET ?action=request&satoshis=1000` — BRC-29 payment request
- `GET ?action=balance` — Output count + total satoshis
- `GET ?action=status` — Key persistence status
- `GET ?action=outputs` — List outputs
- `GET ?action=reset` — Reset wallet
- `POST ?action=receive` body: `{ tx, senderIdentityKey, derivationPrefix, derivationSuffix, outputIndex }`

**Custom config:**
```typescript
createServerWalletHandler({
  envVar: 'SERVER_PRIVATE_KEY',       // env var name (default)
  keyFile: '.server-wallet.json',     // file persistence (default)
  network: 'main',
  defaultRequestSatoshis: 1000,
  requestMemo: 'Payment to server'
})
```

### Identity Registry

```typescript
// app/api/identity-registry/route.ts
import { createIdentityRegistryHandler } from '@bsv/simple/server'
const handler = createIdentityRegistryHandler()
export const GET = handler.GET, POST = handler.POST
```

### DID Resolver

```typescript
// app/api/resolve-did/route.ts
import { createDIDResolverHandler } from '@bsv/simple/server'
const handler = createDIDResolverHandler()
export const GET = handler.GET
```

### Credential Issuer

```typescript
// app/api/credential-issuer/route.ts  (no [[...path]] catch-all needed!)
import { createCredentialIssuerHandler } from '@bsv/simple/server'
const handler = createCredentialIssuerHandler({
  schemas: [{
    id: 'my-credential',
    name: 'MyCredential',
    fields: [
      { key: 'name', label: 'Full Name', type: 'text', required: true },
    ]
  }]
})
export const GET = handler.GET, POST = handler.POST
```

### Key Persistence

Server wallet private keys persist automatically:
1. `process.env.SERVER_PRIVATE_KEY` — Environment variable (production)
2. `.server-wallet.json` file — Persisted from previous run (development)
3. Auto-generated via `generatePrivateKey()` — Fresh key (first run)

No `@bsv/sdk` import needed.

## 5. Client-Side Funding Flow

```typescript
// In your client component:
const fundServer = async () => {
  // 1. Get payment request
  const res = await fetch('/api/server-wallet?action=request')
  const { paymentRequest } = await res.json()

  // 2. Fund server wallet
  const result = await wallet.fundServerWallet(paymentRequest, 'server-funding')

  // 3. Send tx to server
  await fetch('/api/server-wallet?action=receive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tx: Array.from(result.tx),
      senderIdentityKey: wallet.getIdentityKey(),
      derivationPrefix: paymentRequest.derivationPrefix,
      derivationSuffix: paymentRequest.derivationSuffix,
      outputIndex: 0
    })
  })
}
```

## 6. .gitignore

Add these entries to prevent committing secrets:

```
.server-wallet.json
.revocation-secrets.json
.identity-registry.json
```

## 7. Environment Variables

For production deployments, set the server wallet key as an environment variable instead of using file persistence:

```bash
SERVER_PRIVATE_KEY=a1b2c3d4e5f6...
```

## Common Issues

| Problem | Solution |
|---------|----------|
| Build fails with "Can't resolve 'fs'" | Add `serverExternalPackages` to `next.config.ts` |
| Import error for `@bsv/simple/server` | Use handler factories (static imports work) or dynamic `await import()` for lower-level access |
