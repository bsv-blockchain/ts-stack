# Next.js Integration

This guide covers setting up `@bsv/simple` in a Next.js application with both browser wallet (client components) and server wallet (API routes).

## 1. Install Dependencies

```bash
npm install @bsv/simple @bsv/sdk
```

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

## 4. Server Wallet (API Routes)

### Server Wallet Route

```typescript
// app/api/server-wallet/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'

const WALLET_FILE = join(process.cwd(), '.server-wallet.json')

let serverWallet: any = null
let initPromise: Promise<any> | null = null

function loadSavedKey(): string | null {
  try {
    if (existsSync(WALLET_FILE)) {
      return JSON.parse(readFileSync(WALLET_FILE, 'utf-8')).privateKey || null
    }
  } catch {}
  return null
}

async function getServerWallet() {
  if (serverWallet) return serverWallet
  if (initPromise) return initPromise

  initPromise = (async () => {
    const { ServerWallet } = await import('@bsv/simple/server')
    const { PrivateKey } = await import('@bsv/sdk')

    const savedKey = loadSavedKey()
    const privateKey = process.env.SERVER_PRIVATE_KEY
      || savedKey
      || PrivateKey.fromRandom().toHex()

    serverWallet = await ServerWallet.create({
      privateKey,
      network: 'main',
      storageUrl: 'https://storage.babbage.systems'
    })

    // Persist key for dev restarts
    if (!process.env.SERVER_PRIVATE_KEY) {
      writeFileSync(WALLET_FILE, JSON.stringify({
        privateKey,
        identityKey: serverWallet.getIdentityKey()
      }, null, 2))
    }

    return serverWallet
  })()

  return initPromise
}
```

### Key Points

- **Dynamic imports**: Always use `await import('@bsv/simple/server')` instead of static imports at the top of the file. Static imports cause bundler issues.
- **Module-level caching**: Store the wallet instance and init promise at module scope so the wallet isn't re-initialized on every request.
- **Error recovery**: If initialization fails, reset the promise so the next request can retry.

### GET Handlers

```typescript
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') || 'create'

  try {
    if (action === 'create') {
      const wallet = await getServerWallet()
      return NextResponse.json({
        success: true,
        serverIdentityKey: wallet.getIdentityKey(),
        status: wallet.getStatus()
      })
    }

    if (action === 'request') {
      const wallet = await getServerWallet()
      const request = wallet.createPaymentRequest({
        satoshis: Number(req.nextUrl.searchParams.get('satoshis')) || 1000
      })
      return NextResponse.json({ success: true, paymentRequest: request })
    }

    if (action === 'balance') {
      const wallet = await getServerWallet()
      const client = wallet.getClient()
      const raw = await client.listOutputs({
        basket: 'default',
        include: 'locking scripts'
      })
      const outputs = raw?.outputs ?? (Array.isArray(raw) ? raw : [])
      const totalSatoshis = outputs.reduce((sum: number, o: any) => sum + (o.satoshis || 0), 0)
      return NextResponse.json({ success: true, totalOutputs: outputs.length, totalSatoshis })
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    if (action === 'create') { initPromise = null; serverWallet = null }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
```

### POST Handler (Receive Payment)

```typescript
export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') || 'receive'

  try {
    if (action === 'receive') {
      const wallet = await getServerWallet()
      const { tx, senderIdentityKey, derivationPrefix, derivationSuffix, outputIndex } = await req.json()

      if (!tx || !senderIdentityKey || !derivationPrefix || !derivationSuffix) {
        return NextResponse.json({
          error: 'Missing required fields: tx, senderIdentityKey, derivationPrefix, derivationSuffix'
        }, { status: 400 })
      }

      await wallet.receivePayment({
        tx, senderIdentityKey, derivationPrefix, derivationSuffix,
        outputIndex: outputIndex ?? 0
      })

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
```

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
| Server wallet re-initializes every request | Cache at module scope with promise pattern |
| Import error for `@bsv/simple/server` | Use dynamic `await import()` in API routes |
