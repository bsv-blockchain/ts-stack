import type { Capability, CapabilityContext, BaseBuilder } from '../types.js'
import { bsvImport } from '../scaffold/base-app.js'

const SIGNED_REQUEST = `// Create a signed request: an @bsv/auth proof bound to a route (action) + body.
import type { WalletInterface } from '@bsv/sdk'
import { createAuthProof, type AuthProof, type RequestBody } from './auth.js'

export async function createSignedRequest (
  wallet: WalletInterface,
  opts: { serverIdentityKey: string, action: string, body?: RequestBody }
): Promise<AuthProof> {
  return await createAuthProof(wallet, { counterparty: opts.serverIdentityKey, action: opts.action, body: opts.body })
}
`

const USE_SIGNED_REQUEST = `// Hook: signedFetch attaches a proof bound to the route + JSON body.
import { useCallback } from 'react'
import { useWallet } from './WalletContext.js'
import { createSignedRequest } from './signedRequest.js'
import type { RequestBody } from './auth.js'

export function useSignedRequest (serverIdentityKey: string) {
  const { wallet } = useWallet()
  const signedFetch = useCallback(async (url: string, opts: { action: string, body?: RequestBody }): Promise<Response> => {
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

const SIGNED_REQUEST_DEMO = `import { useState } from 'react'
import { ConnectWallet } from './ConnectWallet.js'
import { useSignedRequest } from './useSignedRequest.js'

const SERVER_IDENTITY_KEY = '' // set to your server's identity key

export function SignedRequestDemo () {
  const { signedFetch, connected } = useSignedRequest(SERVER_IDENTITY_KEY)
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    setError(null)
    try {
      const res = await signedFetch('/api/echo', { action: 'echo', body: { hello: 'world' } })
      if (!res.ok) { setError('request failed: ' + String(res.status)); return }
      setResult(await res.json())
    } catch (e) { setError(String(e)) }
  }
  return (
    <main style={{ maxWidth: 640, margin: '40px auto', fontFamily: 'system-ui' }}>
      <h1>Signed Request Demo</h1>
      <ConnectWallet />
      {connected && <button onClick={() => { void send() }}>Send signed echo</button>}
      {result != null && <pre>{JSON.stringify(result, null, 2)}</pre>}
      {error != null && <p style={{ color: 'crimson' }}>{error}</p>}
    </main>
  )
}
`

const VERIFY = `// Framework-agnostic verification of a signed request. Works in Express, Next API
// routes, Fastify — it's a plain function. Pass your own single-use nonce store.
import { verifyAuthProof, type AuthProof, type RequestBody } from './auth.js'

export async function verifySignedRequest (
  serverWallet: { verifySignature: (args: any) => Promise<{ valid: boolean }> },
  proof: AuthProof,
  opts: { action: string, body?: RequestBody },
  consumeNonce: (nonce: string, expiresAt: Date) => boolean | Promise<boolean>
): Promise<{ valid: boolean, identityKey?: string, error?: string }> {
  return await verifyAuthProof(serverWallet, proof, { action: opts.action, body: opts.body }, consumeNonce)
}
`

function agentsSection (_ctx: CapabilityContext): string {
  return `## signed-requests

Authenticate individual API calls: sign a proof bound to a route (\`action\`) + request \`body\`. Same primitive as login, with a body — single round-trip, no handshake, framework-agnostic server side.

- \`signedRequest.ts\` / \`useSignedRequest.ts\` (client) — \`const { signedFetch } = useSignedRequest(serverIdentityKey)\`; \`signedFetch('/api/thing', { action: 'thing', body })\`.
- \`SignedRequestDemo.tsx\` (client page) — interactive demo at \`/signed-demo\`; connects wallet then sends a signed echo to \`/api/echo\` and shows the JSON result.
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
      { path: 'useSignedRequest.ts', content: USE_SIGNED_REQUEST },
      { path: 'SignedRequestDemo.tsx', content: SIGNED_REQUEST_DEMO }
    ],
    server: [{ path: 'verifySignedRequest.ts', content: VERIFY }]
  }),
  baseEdits: ({ builder, ctx }: { builder: BaseBuilder, ctx: CapabilityContext }) => {
    builder.app.routes.push({ path: '/signed-demo', component: 'SignedRequestDemo', importPath: bsvImport(ctx, 'SignedRequestDemo') })
    builder.server.imports.push(`import { verifySignedRequest } from '${bsvImport(ctx, 'verifySignedRequest.js')}'`)
    builder.server.routes.push("app.post('/api/echo', async (req, res) => { const { proof, body } = req.body; const r = await verifySignedRequest(serverWallet, proof, { action: 'echo', body }, async () => true); res.status(r.valid ? 200 : 401).json(r) })")
  },
  npmDependencies: () => ({
    client: { react: '>=18' },
    server: {}
  }),
  agentsSection
}
