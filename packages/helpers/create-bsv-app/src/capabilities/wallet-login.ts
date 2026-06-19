// src/capabilities/wallet-login.ts
import type { Capability, FileSpec, Framework, GenContext } from '../types.js'

const SHARED_AUTH_UTIL = `// Shared, framework-agnostic wallet-login helpers.
// Built on @bsv/auth (BRC-103 auth proofs); works with any BRC-100 wallet.
import { AuthProofClient, AuthProofServer, type AuthProof } from '@bsv/auth'

export const LOGIN_ACTION = 'login'

/** CLIENT: sign a login proof with the user's wallet. */
export async function createLoginProof (
  wallet: { getPublicKey: Function, createSignature: Function },
  serverIdentityKey: string
): Promise<AuthProof> {
  const client = new AuthProofClient()
  return await client.createAuthProof(wallet as any, serverIdentityKey, LOGIN_ACTION)
}

/** SERVER: verify a login proof. Returns the caller's identity key when valid. */
export async function verifyLoginProof (
  serverWallet: { getPublicKey: Function, verifySignature: Function },
  proof: AuthProof,
  consumeNonce: (nonce: string, expiresAt: number) => boolean
): Promise<{ valid: boolean, identityKey?: string, error?: string }> {
  const server = new AuthProofServer()
  return await server.verifyAuthProof(serverWallet as any, proof, LOGIN_ACTION, { consumeNonce })
}
`

const EXPRESS_ROUTE = `// Express login route for the wallet-login capability.
// Drop into your app: app.post('/api/login', loginRoute(serverWallet))
import type { Request, Response } from 'express'
import { verifyLoginProof } from './auth.js'

// Replace with a real single-use store (Redis, DB) in production.
const usedNonces = new Map<string, number>()

export function loginRoute (serverWallet: { getPublicKey: Function, verifySignature: Function }) {
  return async (req: Request, res: Response): Promise<void> => {
    const result = await verifyLoginProof(serverWallet, req.body, (nonce, expiresAt) => {
      if (usedNonces.has(nonce)) return false
      usedNonces.set(nonce, expiresAt)
      return true
    })
    if (!result.valid) {
      res.status(401).json({ error: result.error ?? 'invalid proof' })
      return
    }
    // result.identityKey is the authenticated user. Issue your session/JWT here.
    res.json({ identityKey: result.identityKey })
  }
}
`

const REACT_HOOK = `// React hook for the wallet-login capability.
// Built on @bsv/wallet-relay (wallet pairing) + the shared @bsv/auth util.
import { useCallback } from 'react'
import { useWalletRelayClient } from '@bsv/wallet-relay/react'
import { createLoginProof } from './auth.js'

export interface UseWalletLoginOptions {
  serverIdentityKey: string
  loginEndpoint?: string // default '/api/login'
}

export function useWalletLogin (opts: UseWalletLoginOptions) {
  const { session, createSession } = useWalletRelayClient({ autoCreate: true })

  const login = useCallback(async (): Promise<{ identityKey: string }> => {
    const active = session ?? await createSession()
    const proof = await createLoginProof(active.wallet, opts.serverIdentityKey)
    const res = await fetch(opts.loginEndpoint ?? '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proof)
    })
    if (!res.ok) throw new Error('login failed: ' + String(res.status))
    return await res.json()
  }, [session, createSession, opts.serverIdentityKey, opts.loginEndpoint])

  return { login, session, connected: session != null }
}
`

function files (ctx: GenContext): FileSpec[] {
  const out: FileSpec[] = [{ path: 'src/bsv/auth.ts', content: SHARED_AUTH_UTIL }]
  if (ctx.framework === 'express') {
    out.push({ path: 'src/bsv/loginRoute.ts', content: EXPRESS_ROUTE })
  } else if (ctx.framework === 'react') {
    out.push({ path: 'src/bsv/useWalletLogin.tsx', content: REACT_HOOK })
  }
  return out
}

function npmDependencies (ctx: GenContext): Record<string, string> {
  const deps: Record<string, string> = { '@bsv/auth': '^1.0.0' }
  if (ctx.framework === 'express') {
    deps.express = '^5.0.0'
  } else if (ctx.framework === 'react') {
    deps['@bsv/wallet-relay'] = '^1.0.0'
    deps.react = '>=17'
  }
  return deps
}

function agentsSection (ctx: GenContext): string {
  const frameworkFile = ctx.framework === 'express'
    ? "- `src/bsv/loginRoute.ts` — Express handler; mount it with `app.post('/api/login', loginRoute(serverWallet))`."
    : '- `src/bsv/useWalletLogin.tsx` — React hook `useWalletLogin({ serverIdentityKey })`; call `login()` from a button. Uses `@bsv/wallet-relay` for wallet pairing.'
  return `## wallet-login

Passwordless wallet login built on **@bsv/auth** (BRC-103 auth proofs); works with any BRC-100 wallet.

- \`src/bsv/auth.ts\` — shared, framework-agnostic helpers: \`createLoginProof(wallet, serverIdentityKey)\` (client) and \`verifyLoginProof(serverWallet, proof, consumeNonce)\` (server).
${frameworkFile}

### How to extend
- Replace the in-memory nonce store with Redis/DB for production single-use enforcement.
- After \`verifyLoginProof\` succeeds, issue your own session/JWT keyed by \`identityKey\`.
- Need wallet actions (pay, tokens, credentials)? Add the relevant capability or use \`@bsv/simple\`.
`
}

export const walletLogin: Capability = {
  id: 'wallet-login',
  title: 'Wallet login (passwordless, BRC-103 proof)',
  description: 'Util files for proving identity with any BRC-100 wallet, built on @bsv/auth.',
  frameworks: ['express', 'react'] as Framework[],
  files,
  npmDependencies,
  agentsSection
}
