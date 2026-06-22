// src/capabilities/wallet-login.ts
import type { Capability, CapabilityContext } from '../types.js'

const SHARED_AUTH_UTIL = `// Shared, framework-agnostic wallet-login helpers.
// Built on @bsv/auth (BRC-103 auth proofs); works with any BRC-100 wallet.
import { AuthProofClient, AuthProofServer, type AuthProof } from '@bsv/auth'

export const LOGIN_ACTION = 'login'

export async function createLoginProof (
  wallet: { getPublicKey: Function, createSignature: Function },
  serverIdentityKey: string
): Promise<AuthProof> {
  const client = new AuthProofClient()
  return await client.createAuthProof(wallet as any, serverIdentityKey, LOGIN_ACTION)
}

export async function verifyLoginProof (
  serverWallet: { getPublicKey: Function, verifySignature: Function },
  proof: AuthProof,
  consumeNonce: (nonce: string, expiresAt: number) => boolean
): Promise<{ valid: boolean, identityKey?: string, error?: string }> {
  const server = new AuthProofServer()
  return await server.verifyAuthProof(serverWallet as any, proof, LOGIN_ACTION, { consumeNonce })
}
`

const REACT_HOOK = `// React hook for wallet-login. Built on @bsv/wallet-relay + the shared @bsv/auth util.
import { useCallback } from 'react'
import { useWalletRelayClient } from '@bsv/wallet-relay/react'
import { createLoginProof } from './auth.js'

export interface UseWalletLoginOptions { serverIdentityKey: string, loginEndpoint?: string }

export function useWalletLogin (opts: UseWalletLoginOptions) {
  const { session, createSession } = useWalletRelayClient({ autoCreate: true })
  const login = useCallback(async (): Promise<{ identityKey: string }> => {
    const active = session ?? await createSession()
    const proof = await createLoginProof(active.wallet, opts.serverIdentityKey)
    const res = await fetch(opts.loginEndpoint ?? '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof)
    })
    if (!res.ok) throw new Error('login failed: ' + String(res.status))
    return await res.json()
  }, [session, createSession, opts.serverIdentityKey, opts.loginEndpoint])
  return { login, session, connected: session != null }
}
`

const EXPRESS_ROUTE = `// Express login route. Drop in: app.post('/api/login', loginRoute(serverWallet))
import type { Request, Response } from 'express'
import { verifyLoginProof } from './auth.js'

const usedNonces = new Map<string, number>()

export function loginRoute (serverWallet: { getPublicKey: Function, verifySignature: Function }) {
  return async (req: Request, res: Response): Promise<void> => {
    const result = await verifyLoginProof(serverWallet, req.body, (nonce, expiresAt) => {
      if (usedNonces.has(nonce)) return false
      usedNonces.set(nonce, expiresAt)
      return true
    })
    if (!result.valid) { res.status(401).json({ error: result.error ?? 'invalid proof' }); return }
    res.json({ identityKey: result.identityKey })
  }
}
`

function agentsSection (_ctx: CapabilityContext): string {
  return `## wallet-login

Passwordless wallet login built on **@bsv/auth** (BRC-103 auth proofs); works with any BRC-100 wallet.

- \`auth.ts\` (shared) — \`createLoginProof(wallet, serverIdentityKey)\` (client) + \`verifyLoginProof(serverWallet, proof, consumeNonce)\` (server).
- \`useWalletLogin.tsx\` (client) — React hook on \`@bsv/wallet-relay\`; call \`login()\` from a button.
- \`loginRoute.ts\` (server) — Express handler; mount with \`app.post('/api/login', loginRoute(serverWallet))\`.

### How to extend
- Replace the in-memory nonce store with Redis/DB for production single-use enforcement.
- After \`verifyLoginProof\` succeeds, issue your own session/JWT keyed by \`identityKey\`.
`
}

export const walletLogin: Capability = {
  id: 'wallet-login',
  title: 'Wallet login (passwordless, BRC-103 proof)',
  description: 'Util files for proving identity with any BRC-100 wallet, built on @bsv/auth.',
  roles: ['shared', 'client', 'server'],
  files: () => ({
    shared: [{ path: 'auth.ts', content: SHARED_AUTH_UTIL }],
    client: [{ path: 'useWalletLogin.tsx', content: REACT_HOOK }],
    server: [{ path: 'loginRoute.ts', content: EXPRESS_ROUTE }]
  }),
  npmDependencies: () => ({
    shared: { '@bsv/auth': '^1.0.0' },
    client: { '@bsv/wallet-relay': '^1.0.0', react: '>=17' },
    server: { express: '^5.0.0' }
  }),
  agentsSection
}
