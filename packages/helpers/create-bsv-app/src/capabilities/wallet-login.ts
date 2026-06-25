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
  const login = async () => {
    setError(null)
    if (wallet == null) return
    try {
      const counterparty = await getServerIdentity()
      const proof = await createAuthProof(wallet, { counterparty, action: 'login' })
      const res = await fetch(API_BASE_URL + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof) })
      if (!res.ok) { setError('login failed: ' + String(res.status)); return }
      const data = await res.json()
      setResult(data.identityKey ?? identityKey)
    } catch (e) { setError(String(e)) }
  }
  return (
    <main style={{ maxWidth: 640, margin: '40px auto', fontFamily: 'system-ui' }}>
      <p><Link to="/">← Back to home</Link></p>
      <h1>Login</h1>
      <ConnectWallet />
      {connected && <button onClick={() => { void login() }}>Login with wallet</button>}
      {result != null && <p>Logged in as <code>{result.slice(0, 16)}…</code></p>}
      {error != null && <p style={{ color: 'crimson' }}>{error}</p>}
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

Passwordless login = a signed proof with \`action: 'login'\` over the base \`auth.ts\` primitive.

- \`WalletLogin.tsx\` (client page) — full login UI at \`/login\`. Works out of the box: the server's identity key (the proof \`counterparty\`) is fetched from \`GET /api/identity\` via \`getServerIdentity()\`.
- \`useWalletLogin.tsx\` (client hook) — \`const { login } = useWalletLogin()\`; use directly if you want a custom UI. Pass \`{ serverIdentityKey }\` only to pin a specific key instead of auto-fetching.
- \`loginRoute.ts\` (server) — Express handler; mounted at \`app.post('/api/login', loginRoute(serverWallet))\` (serverWallet = a \`ProtoWallet\`).

### Environment (all in \`bsv/config.ts\`)
- Client (\`client/src/bsv/config.ts\`): \`API_BASE_URL\` (default \`http://localhost:3000\`, override with \`VITE_API_URL\`). The counterparty itself needs nothing set — \`getServerIdentity()\` resolves it from \`GET /api/identity\`.
- Server (\`server/src/bsv/config.ts\`): \`SERVER_PRIVATE_KEY\` (\`serverWallet\`'s key; random dev fallback), \`PORT\`, and \`CLIENT_ORIGIN\` (CORS allow-origin for the browser client).

### Extend
- Swap the in-memory nonce store for Redis/DB in production.
- Issue your own JWT/session keyed by \`identityKey\` after verify (a future \`--jwt\` option will scaffold this).
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
