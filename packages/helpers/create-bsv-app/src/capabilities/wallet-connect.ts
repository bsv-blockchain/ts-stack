// src/capabilities/wallet-connect.ts
import type { Capability, CapabilityContext } from '../types.js'

const AUTH_UTIL = `// Shared, framework-agnostic auth-proof helpers built on @bsv/auth (BRC-103).
// One primitive: sign a proof bound to { action, body? }, verify it on the server.
import { AuthProofClient, AuthProofServer, type AuthProof, type ProofSignerWallet } from '@bsv/auth'

export type { AuthProof }

export async function createAuthProof (
  wallet: ProofSignerWallet,
  opts: { counterparty: string, action: string, body?: unknown }
): Promise<AuthProof> {
  const client = new AuthProofClient()
  return await client.createAuthProof({ wallet, counterparty: opts.counterparty, action: opts.action, body: opts.body })
}

export async function verifyAuthProof (
  serverWallet: { verifySignature: (args: any) => Promise<{ valid: boolean }> },
  proof: AuthProof,
  opts: { action: string, body?: unknown },
  consumeNonce: (nonce: string, expiresAt: Date) => boolean | Promise<boolean>
): Promise<{ valid: boolean, identityKey?: string, error?: string }> {
  const server = new AuthProofServer()
  return await server.verifyAuthProof({ wallet: serverWallet, proof, action: opts.action, body: opts.body, consumeNonce })
}
`

const ACQUISITION = `// Desktop/extension wallet acquisition via @bsv/sdk WalletClient('auto').
import { WalletClient, type WalletInterface } from '@bsv/sdk'

export async function connectDesktopWallet (): Promise<{ wallet: WalletInterface, identityKey: string }> {
  const wallet = new WalletClient('auto')
  const { authenticated } = await wallet.isAuthenticated()
  if (!authenticated) throw new Error('No authenticated desktop wallet found')
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return { wallet, identityKey: publicKey }
}
`

const RELAY_CONTEXT = `// Relay-session context: wraps @bsv/wallet-relay's hook so a single relay client
// (mobile QR / remote wallet) lives above the router. Port/extend from your app as needed.
import { createContext, useContext, type ReactNode } from 'react'
import { useWalletRelayClient } from '@bsv/wallet-relay/react'

type RelayValue = ReturnType<typeof useWalletRelayClient>
const Ctx = createContext<RelayValue | null>(null)

export function WalletConnectionProvider ({ children, apiUrl }: { children: ReactNode, apiUrl?: string }) {
  const relay = useWalletRelayClient({ apiUrl, autoCreate: false })
  return <Ctx.Provider value={relay}>{children}</Ctx.Provider>
}

export function useWalletConnection (): RelayValue {
  const v = useContext(Ctx)
  if (v === null) throw new Error('useWalletConnection must be used within WalletConnectionProvider')
  return v
}
`

const WALLET_CONTEXT = `// App-wide wallet state. Holds the connected wallet (desktop OR relay) + identityKey.
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { WalletInterface } from '@bsv/sdk'
import { connectDesktopWallet } from './walletAcquisition.js'
import { useWalletConnection } from './WalletConnectionContext.js'

interface WalletState {
  wallet: WalletInterface | null
  identityKey: string | null
  connected: boolean
  initializeWallet: () => Promise<void>          // desktop
  setRelayWallet: (wallet: WalletInterface, identityKey: string) => void  // relay bridge
  reset: () => void
}
const Ctx = createContext<WalletState | null>(null)

export function WalletProvider ({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<WalletInterface | null>(null)
  const [identityKey, setIdentityKey] = useState<string | null>(null)
  useWalletConnection() // ensures the relay provider is mounted above
  const initializeWallet = useCallback(async () => {
    const { wallet, identityKey } = await connectDesktopWallet()
    setWallet(wallet); setIdentityKey(identityKey)
  }, [])
  const setRelayWallet = useCallback((w: WalletInterface, id: string) => { setWallet(w); setIdentityKey(id) }, [])
  const reset = useCallback(() => { setWallet(null); setIdentityKey(null) }, [])
  return <Ctx.Provider value={{ wallet, identityKey, connected: wallet !== null, initializeWallet, setRelayWallet, reset }}>{children}</Ctx.Provider>
}

export function useWallet (): WalletState {
  const v = useContext(Ctx)
  if (v === null) throw new Error('useWallet must be used within WalletProvider')
  return v
}
`

const PROVIDERS = `// Compose the wallet providers in the required order (relay above wallet).
import type { ReactNode } from 'react'
import { WalletConnectionProvider } from './WalletConnectionContext.js'
import { WalletProvider } from './WalletContext.js'

export function WalletProviders ({ children }: { children: ReactNode }) {
  return (
    <WalletConnectionProvider>
      <WalletProvider>{children}</WalletProvider>
    </WalletConnectionProvider>
  )
}
`

function mainEntry (bsvDir: string): string {
  // bsvDir default 'src/bsv'; main.tsx sits at 'src/main.tsx' → import is './bsv/WalletProviders'
  const rel = bsvDir.startsWith('src/') ? './' + bsvDir.slice('src/'.length) : '../' + bsvDir
  return `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { WalletProviders } from '${rel}/WalletProviders'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProviders>
      <App />
    </WalletProviders>
  </StrictMode>,
)
`
}

function agentsSection (_ctx: CapabilityContext): string {
  return `## wallet-connect (base)

Connect any BRC-100 wallet — desktop (\`@bsv/sdk\` \`WalletClient('auto')\`) or mobile/relay (\`@bsv/wallet-relay\`) — and expose it app-wide.

- \`auth.ts\` (shared) — \`createAuthProof(wallet, { counterparty, action, body? })\` + \`verifyAuthProof(serverWallet, proof, { action, body? }, consumeNonce)\`. The proof primitive both \`wallet-login\` and \`signed-requests\` build on.
- \`walletAcquisition.ts\` (client) — \`connectDesktopWallet()\`.
- \`WalletConnectionContext.tsx\` / \`WalletContext.tsx\` / \`WalletProviders.tsx\` (client) — relay session + wallet state; consume the wallet anywhere via \`useWallet()\`.
- New projects (glue on): \`src/main.tsx\` is wired to wrap \`<App/>\` in \`<WalletProviders>\`. With \`--no-glue\` or add mode: wrap your root with \`<WalletProviders>\` yourself.
`
}

export const walletConnect: Capability = {
  id: 'wallet-connect',
  title: 'Wallet connect (desktop + relay, app-wide context)',
  description: 'Base: connect any BRC-100 wallet (desktop or mobile/relay) and use it across the app, plus the @bsv/auth proof primitive.',
  roles: ['shared', 'client'],
  defaultSelected: true,
  files: () => ({
    shared: [{ path: 'auth.ts', content: AUTH_UTIL }],
    client: [
      { path: 'walletAcquisition.ts', content: ACQUISITION },
      { path: 'WalletConnectionContext.tsx', content: RELAY_CONTEXT },
      { path: 'WalletContext.tsx', content: WALLET_CONTEXT },
      { path: 'WalletProviders.tsx', content: PROVIDERS }
    ]
  }),
  clientEntry: (ctx) => ({ path: 'src/main.tsx', content: mainEntry(ctx.bsvDir) }),
  npmDependencies: () => ({
    shared: { '@bsv/auth': '^0.1.0' },
    client: { '@bsv/sdk': '^2.1.0', '@bsv/wallet-relay': '^0.2.0', react: '>=18' }
  }),
  agentsSection
}
