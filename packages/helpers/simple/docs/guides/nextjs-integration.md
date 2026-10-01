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
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: [
    '@bsv/wallet-toolbox',
    'knex',
    'better-sqlite3',
    'tedious',
    'mysql',
    'mysql2',
    'pg',
    'pg-query-stream',
    'oracledb',
    'dotenv'
  ]
}

export default nextConfig
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

  // Directory display hint only; this does not authenticate the handle.
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
const handler = createServerWalletHandler({
  authorize: async ({ action, headers }) => {
    const session = await authenticateApplicationRequest(headers)
    return session?.canUseServerWallet(action) === true
  }
})
export const GET = handler.GET,
  POST = handler.POST
```

All actions default closed, including payment-request and receive routes.
Authenticate the application request and authorize the specific action; a
truthy non-boolean verdict is rejected.

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
  envVar: 'SERVER_PRIVATE_KEY', // env var name (default)
  keyFile: '.server-wallet.json', // file persistence (default)
  network: 'main',
  defaultRequestSatoshis: 1000,
  requestMemo: 'Payment to server',
  authorize: async ({ action, headers }) => {
    const session = await authenticateApplicationRequest(headers)
    return session?.canUseServerWallet(action) === true
  }
})
```

### Identity Registry

The generated compatibility handler does not authenticate tag mutations: a
public identity key is not proof of private-key control. Use this route only for
local/demo discovery or place it behind application authentication. Do not use
its lookup result alone to select a payment recipient.

```typescript
// app/api/identity-registry/route.ts
import { createIdentityRegistryHandler } from '@bsv/simple/server'
const handler = createIdentityRegistryHandler()
export const GET = handler.GET,
  POST = handler.POST
```

The built-in registry accepts only canonical compressed public keys and
control-free tags up to 128 characters. It defaults to 32 tags per identity,
10,000 total entries, and 100 results per lookup; deployments can lower these
limits with `maxTagsPerIdentity`, `maxEntries`, and `maxLookupResults`. All
Simple route adapters also stop reading JSON request bodies after 64 MiB (a
custom `toNextHandlers()` adapter may choose a lower limit).

### Identity-key DID resolution

Use `DID.resolve(did)` from `@bsv/simple` in the application. It is deterministic and offline; no proxy route or provider configuration is required. See [migration guidance](identity-credential-migration.md).

### Credential Issuer

```typescript
// app/api/credential-issuer/route.ts  (no [[...path]] catch-all needed!)
import { createCredentialIssuerHandler } from '@bsv/simple/server'
const handler = createCredentialIssuerHandler({
  schemas: [
    {
      id: 'my-credential',
      name: 'MyCredential',
      fields: [{ key: 'name', label: 'Full Name', type: 'text', required: true }]
    }
  ],
  // Required for every issue/certify/revoke state change. Bind this to your
  // authenticated session, application policy, and subject/serial ownership.
  authorize: async ({ action, subjectIdentityKey, serialNumber, headers }) => {
    return await authorizeCredentialOperation({
      action,
      subjectIdentityKey,
      serialNumber,
      authorization: headers?.get('authorization')
    })
  }
})
export const GET = handler.GET,
  POST = handler.POST
```

The handler denies issuance and revocation unless `authorize` returns literal
`true`. Its public info/schema/status/verification routes do not grant mutation
authority. Never replace this policy with a truthy value or a check that trusts
the caller-supplied subject key by itself.

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

| Problem                               | Solution                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Build fails with "Can't resolve 'fs'" | Add `serverExternalPackages` to `next.config.ts`                                               |
| Import error for `@bsv/simple/server` | Use handler factories (static imports work) or dynamic `await import()` for lower-level access |
