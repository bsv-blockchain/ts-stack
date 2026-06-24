// src/capabilities/wallet-login.ts
import type { Capability, CapabilityContext } from '../types.js'

const HOOK = `// Wallet login: prove identity with the connected wallet, then POST the proof.
import { useCallback } from 'react'
import { useWallet } from './WalletContext.js'
import { createAuthProof } from './auth.js'

export interface UseWalletLoginOptions { serverIdentityKey: string, loginEndpoint?: string }

export function useWalletLogin (opts: UseWalletLoginOptions) {
  const { wallet, identityKey } = useWallet()
  const login = useCallback(async (): Promise<{ identityKey: string }> => {
    if (wallet === null) throw new Error('connect a wallet first (initializeWallet / relay)')
    const proof = await createAuthProof(wallet, { counterparty: opts.serverIdentityKey, action: 'login' })
    const res = await fetch(opts.loginEndpoint ?? '/api/login', {
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

- \`useWalletLogin.tsx\` (client) — \`const { login } = useWalletLogin({ serverIdentityKey })\`; call from a button after connecting.
- \`loginRoute.ts\` (server) — Express handler; \`app.post('/api/login', loginRoute(serverWallet))\` (serverWallet = a \`ProtoWallet\`).

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
    client: [{ path: 'useWalletLogin.tsx', content: HOOK }],
    server: [{ path: 'loginRoute.ts', content: ROUTE }]
  }),
  npmDependencies: () => ({
    client: { react: '>=18' },
    server: { express: '^5.0.0' }
  }),
  agentsSection
}
