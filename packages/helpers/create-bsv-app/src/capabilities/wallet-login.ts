// src/capabilities/wallet-login.ts
import type { Capability, CapabilityContext, BaseBuilder } from '../types.js'
import { bsvImport } from '../scaffold/base-app.js'

const WALLET_LOGIN_PAGE = `import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ConnectWallet } from './ConnectWallet.js'
import { useWallet } from './WalletContext.js'
import { createAuthProof } from './auth.js'
import { getServerIdentity } from './serverIdentity.js'
import { API_BASE_URL } from './config.js'

export function WalletLogin () {
  const { wallet, connected, identityKey } = useWallet()
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // --- demo activity log (safe to delete) ---
  const [log, setLog] = useState<string[]>([])
  const step = (m: string): void => setLog(l => [...l, m])
  // --- end demo activity log ---
  const login = async () => {
    setError(null); setResult(null); setLog([])
    if (wallet == null) return
    try {
      step('Fetching the server identity (GET /api/identity)…')
      const counterparty = await getServerIdentity()
      step('Server identity: ' + counterparty.slice(0, 16) + '…')
      step('Signing a login proof with your wallet (action: login)…')
      const proof = await createAuthProof(wallet, { counterparty, action: 'login' })
      step('POST /api/login — sending the proof to the server')
      const res = await fetch(API_BASE_URL + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof) })
      if (!res.ok) { step('✗ Server rejected the proof (' + String(res.status) + ')'); setError('login failed: ' + String(res.status)); return }
      const data = await res.json()
      step('✓ Proof valid — the server trusts this identity')
      setResult(data.identityKey ?? identityKey)
    } catch (e) { step('✗ ' + String(e)); setError(String(e)) }
  }
  return (
    <main style={{ maxWidth: 640, margin: '40px auto', fontFamily: 'system-ui' }}>
      <p><Link to="/">← Back to home</Link></p>
      <h1>Login</h1>
      <ConnectWallet />
      {connected && <button onClick={() => { void login() }}>Login with wallet</button>}
      {result != null && <p>Logged in as <code>{result.slice(0, 16)}…</code></p>}
      {error != null && <p style={{ color: 'crimson' }}>{error}</p>}
      {/* --- demo activity log (safe to delete) --- */}
      {log.length > 0 && (
        <ol style={{ marginTop: 16, paddingLeft: 20, fontFamily: 'monospace', fontSize: 13, color: '#555' }}>
          {log.map((m, i) => <li key={i}>{m}</li>)}
        </ol>
      )}
      {/* --- end demo activity log --- */}
    </main>
  )
}
`

const HOOK = `// Wallet login: prove identity with the connected wallet, then POST the proof.
import { useCallback } from 'react'
import { useWallet } from './WalletContext.js'
import { createAuthProof } from './auth.js'
import { getServerIdentity } from './serverIdentity.js'
import { API_BASE_URL } from './config.js'

// serverIdentityKey is optional: when omitted it's fetched from GET /api/identity.
export interface UseWalletLoginOptions { serverIdentityKey?: string, loginEndpoint?: string }

export function useWalletLogin (opts: UseWalletLoginOptions = {}) {
  const { wallet, identityKey } = useWallet()
  const login = useCallback(async (): Promise<{ identityKey: string }> => {
    if (wallet === null) throw new Error('connect a wallet first (initializeWallet / relay)')
    const counterparty = opts.serverIdentityKey ?? await getServerIdentity()
    const proof = await createAuthProof(wallet, { counterparty, action: 'login' })
    const res = await fetch(API_BASE_URL + (opts.loginEndpoint ?? '/api/login'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof)
    })
    if (!res.ok) throw new Error('login failed: ' + String(res.status))
    return await res.json()
  }, [wallet, opts.serverIdentityKey, opts.loginEndpoint])
  return { login, identityKey, connected: wallet !== null }
}
`

const ROUTE = `// Express login route. Mount: app.post('/api/login', loginRoute(serverWallet))
import type { Request, Response } from 'express'
import { verifyAuthProof } from './auth.js'

const usedNonces = new Map<string, number>()

export function loginRoute (serverWallet: { verifySignature: (args: any) => Promise<{ valid: boolean }> }) {
  return async (req: Request, res: Response): Promise<void> => {
    const result = await verifyAuthProof(serverWallet, req.body, { action: 'login' }, (nonce, expiresAt) => {
      if (usedNonces.has(nonce)) return false
      usedNonces.set(nonce, expiresAt.getTime())
      return true
    })
    if (!result.valid) { res.status(401).json({ error: result.error ?? 'invalid proof' }); return }
    res.json({ identityKey: result.identityKey })
  }
}
`

function agentsSection (_ctx: CapabilityContext): string {
  return `## wallet-login

Passwordless login: the connected wallet signs a proof with \`action: 'login'\`, the server verifies it, and you get a trusted \`identityKey\` — no password, no shared secret.

### How it works
- The client fetches the server's identity key (\`GET /api/identity\`) to use as the proof \`counterparty\`, signs a login proof with the wallet, and POSTs it to \`/api/login\`.
- The server verifies the signature with its \`serverWallet\` and consumes a single-use nonce (replay protection), then trusts the \`identityKey\` the proof was signed by.
- That verified \`identityKey\` is the whole BSV-specific step. What you do next — issue a session, create a user — is your app's call (see *Future integrations*). The demo page renders each step so you can watch the exchange.

### How it's used
- \`WalletLogin.tsx\` (client page) — login UI at \`/login\`; resolves the counterparty via \`getServerIdentity()\` and shows a step-by-step activity log of the exchange.
- \`useWalletLogin.tsx\` (client hook) — \`const { login } = useWalletLogin()\` for a custom UI; pass \`{ serverIdentityKey }\` to pin a key instead of auto-fetching.
- \`loginRoute.ts\` (server) — \`app.post('/api/login', loginRoute(serverWallet))\`; verifies the proof and returns \`{ identityKey }\`.

### Environment (in \`bsv/config.ts\`)
- Client: \`API_BASE_URL\` (default \`http://localhost:3000\`, override with \`VITE_API_URL\`).
- Server: \`SERVER_PRIVATE_KEY\` (the \`serverWallet\` key; random dev fallback), \`PORT\`, \`CLIENT_ORIGIN\` (CORS allow-origin).

### Future integrations — turn login into a session
After \`/api/login\` verifies the proof you hold a trusted \`identityKey\`; mint a session from it however your app prefers. A minimal JWT example with \`jose\` (read a secret from env, like \`serverWallet\` does its key):
\`\`\`ts
import { SignJWT, jwtVerify } from 'jose'
const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-only-secret')
// in loginRoute, once the proof verifies:
const token = await new SignJWT({ sub: result.identityKey }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('7d').sign(secret)
res.cookie('session', token, { httpOnly: true, sameSite: 'lax' }) // or return it for a bearer header
// guard a route: const { payload } = await jwtVerify(token, secret) // payload.sub === identityKey
\`\`\`
- Swap the in-memory nonce store in \`loginRoute.ts\` for Redis/DB in production.
- Persist a user record keyed by \`identityKey\` on first login.
`
}

export const walletLogin: Capability = {
  id: 'wallet-login',
  title: 'Wallet login (passwordless, BRC-103 proof)',
  description: 'Prove identity with the connected wallet; server verifies the proof. Builds on wallet-connect.',
  requires: ['wallet-connect'],
  roles: ['client', 'server'],
  files: () => ({
    client: [
      { path: 'WalletLogin.tsx', content: WALLET_LOGIN_PAGE },
      { path: 'useWalletLogin.tsx', content: HOOK }
    ],
    server: [{ path: 'loginRoute.ts', content: ROUTE }]
  }),
  baseEdits: ({ builder, ctx }: { builder: BaseBuilder, ctx: CapabilityContext }) => {
    builder.app.routes.push({ path: '/login', component: 'WalletLogin', importPath: bsvImport(ctx, 'WalletLogin'), label: 'Wallet login' })
    builder.server.imports.push(`import { loginRoute } from '${bsvImport(ctx, 'loginRoute.js')}'`)
    builder.server.routes.push("app.post('/api/login', loginRoute(serverWallet))")
  },
  npmDependencies: () => ({
    client: { react: '>=18' },
    server: { express: '^5.0.0' }
  }),
  agentsSection
}
