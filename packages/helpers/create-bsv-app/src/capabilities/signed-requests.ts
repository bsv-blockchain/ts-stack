import type { Capability, CapabilityContext } from '../types.js'

const SIGNED_REQUEST = `// Create a signed request: an @bsv/auth proof bound to a route (action) + body.
import type { WalletInterface } from '@bsv/sdk'
import { createAuthProof, type AuthProof } from './auth.js'

export async function createSignedRequest (
  wallet: WalletInterface,
  opts: { serverIdentityKey: string, action: string, body?: unknown }
): Promise<AuthProof> {
  return await createAuthProof(wallet, { counterparty: opts.serverIdentityKey, action: opts.action, body: opts.body })
}
`

const USE_SIGNED_REQUEST = `// Hook: signedFetch attaches a proof bound to the route + JSON body.
import { useCallback } from 'react'
import { useWallet } from './WalletContext.js'
import { createSignedRequest } from './signedRequest.js'

export function useSignedRequest (serverIdentityKey: string) {
  const { wallet } = useWallet()
  const signedFetch = useCallback(async (url: string, opts: { action: string, body?: unknown }): Promise<Response> => {
    if (wallet === null) throw new Error('connect a wallet first')
    const proof = await createSignedRequest(wallet, { serverIdentityKey, action: opts.action, body: opts.body })
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof, body: opts.body })
    })
  }, [wallet, serverIdentityKey])
  return { signedFetch, connected: wallet !== null }
}
`

const VERIFY = `// Framework-agnostic verification of a signed request. Works in Express, Next API
// routes, Fastify — it's a plain function. Pass your own single-use nonce store.
import { verifyAuthProof, type AuthProof } from './auth.js'

export async function verifySignedRequest (
  serverWallet: { verifySignature: (args: any) => Promise<{ valid: boolean }> },
  proof: AuthProof,
  opts: { action: string, body?: unknown },
  consumeNonce: (nonce: string, expiresAt: Date) => boolean | Promise<boolean>
): Promise<{ valid: boolean, identityKey?: string, error?: string }> {
  return await verifyAuthProof(serverWallet, proof, { action: opts.action, body: opts.body }, consumeNonce)
}
`

function agentsSection (_ctx: CapabilityContext): string {
  return `## signed-requests

Authenticate individual API calls: sign a proof bound to a route (\`action\`) + request \`body\`. Same primitive as login, with a body — single round-trip, no handshake, framework-agnostic server side.

- \`signedRequest.ts\` / \`useSignedRequest.ts\` (client) — \`const { signedFetch } = useSignedRequest(serverIdentityKey)\`; \`signedFetch('/api/thing', { action: 'thing', body })\`.
- \`verifySignedRequest.ts\` (server) — plain \`verifySignedRequest(serverWallet, proof, { action, body }, consumeNonce)\`; call it from any backend (Express/Next/Fastify) before trusting \`identityKey\`.
`
}

export const signedRequests: Capability = {
  id: 'signed-requests',
  title: 'Signed requests (per-call BRC-103 auth)',
  description: 'Sign API calls bound to a route + body; verify with a framework-agnostic function. Builds on wallet-connect.',
  requires: ['wallet-connect'],
  roles: ['client', 'server'],
  files: () => ({
    client: [
      { path: 'signedRequest.ts', content: SIGNED_REQUEST },
      { path: 'useSignedRequest.ts', content: USE_SIGNED_REQUEST }
    ],
    server: [{ path: 'verifySignedRequest.ts', content: VERIFY }]
  }),
  npmDependencies: () => ({
    client: { react: '>=18' },
    server: {}
  }),
  agentsSection
}
