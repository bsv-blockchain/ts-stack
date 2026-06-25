// src/capabilities/wallet-connect.ts
import type { Capability, CapabilityContext, BaseBuilder } from '../types.js'
import { bsvImport } from '../scaffold/base-app.js'

const AUTH_UTIL = `// Shared, framework-agnostic auth-proof helpers built on @bsv/auth (BRC-103).
// One primitive: sign a proof bound to { action, body? }, verify it on the server.
import { AuthProofClient, AuthProofServer, type AuthProof, type ProofSignerWallet, type RequestBody } from '@bsv/auth'

export type { AuthProof, RequestBody }

export async function createAuthProof (
  wallet: ProofSignerWallet,
  opts: { counterparty: string, action: string, body?: RequestBody }
): Promise<AuthProof> {
  const client = new AuthProofClient()
  return await client.createAuthProof({ wallet, counterparty: opts.counterparty, action: opts.action, body: opts.body })
}

export async function verifyAuthProof (
  serverWallet: { verifySignature: (args: any) => Promise<{ valid: boolean }> },
  proof: AuthProof,
  opts: { action: string, body?: RequestBody },
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

const WALLET_CONTEXT = `// App-wide wallet state + connect state machine (desktop-first, relay fallback).
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import type { WalletInterface } from '@bsv/sdk'
import { connectDesktopWallet } from './walletAcquisition.js'
import { useWalletConnection } from './WalletConnectionContext.js'

export type ConnectStatus = 'disconnected' | 'connecting' | 'choosing' | 'pairing' | 'connected'
interface WalletState {
  wallet: WalletInterface | null
  identityKey: string | null
  connected: boolean
  status: ConnectStatus
  connect: () => Promise<void>          // desktop-first; on failure -> 'choosing'
  connectMobile: () => Promise<void>    // relay QR -> 'pairing'
  cancel: () => void
}
const Ctx = createContext<WalletState | null>(null)

export function WalletProvider ({ children }: { children: ReactNode }) {
  const relay = useWalletConnection()
  const [wallet, setWallet] = useState<WalletInterface | null>(null)
  const [identityKey, setIdentityKey] = useState<string | null>(null)
  const [status, setStatus] = useState<ConnectStatus>('disconnected')

  const connect = useCallback(async () => {
    setStatus('connecting')
    try {
      const { wallet, identityKey } = await connectDesktopWallet()
      setWallet(wallet); setIdentityKey(identityKey); setStatus('connected')
    } catch {
      setStatus('choosing')   // no desktop wallet -> show modal
    }
  }, [])

  const connectMobile = useCallback(async () => {
    setStatus('pairing')
    try {
      await relay.createSession()   // shows QR via relay.session.qrDataUrl
    } catch {
      setStatus('choosing')         // relay unavailable -> back to the choice modal
    }
  }, [relay])

  const cancel = useCallback(() => { relay.cancelSession?.(); setStatus('disconnected') }, [relay])

  // bridge: when the relay session connects, adopt its wallet
  useEffect(() => {
    if (relay.session?.status === 'connected' && relay.wallet != null && wallet == null) {
      const w = relay.wallet as unknown as WalletInterface
      w.getPublicKey({ identityKey: true }).then(({ publicKey }) => {
        setWallet(w); setIdentityKey(publicKey); setStatus('connected')
      }).catch(() => {})
    }
  }, [relay.session?.status, relay.wallet, wallet])

  return <Ctx.Provider value={{ wallet, identityKey, connected: wallet !== null, status, connect, connectMobile, cancel }}>{children}</Ctx.Provider>
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

const CONNECT_WALLET = `// Connect button + desktop-fail modal (mobile QR / install link). Built on useWallet + the relay session.
import { useWallet } from './WalletContext.js'
import { useWalletConnection } from './WalletConnectionContext.js'

const INSTALL_URL = 'https://desktop.bsvb.tech'

export function ConnectWallet () {
  const { status, identityKey, connect, connectMobile, cancel } = useWallet()
  const relay = useWalletConnection()
  if (status === 'connected') {
    return <div className="bsv-connected">Connected: <code>{identityKey?.slice(0, 16)}…</code></div>
  }
  return (
    <div className="bsv-connect">
      <button onClick={() => { void connect() }} disabled={status !== 'disconnected'}>
        {status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
      </button>
      {(status === 'choosing' || status === 'pairing') && (
        <div className="bsv-modal" role="dialog">
          <div className="bsv-modal-card">
            {status === 'choosing' && (
              <>
                <h3>No desktop wallet found</h3>
                <button onClick={() => { void connectMobile() }}>Connect with a mobile wallet</button>
                <a href={INSTALL_URL} target="_blank" rel="noreferrer">Install a desktop wallet</a>
              </>
            )}
            {status === 'pairing' && (
              <>
                <h3>Scan with your mobile wallet</h3>
                {relay.session?.qrDataUrl != null ? <img src={relay.session.qrDataUrl} alt="Pairing QR" /> : <p>Generating code…</p>}
              </>
            )}
            <button onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
`

const HOME = `// Default home: shows the connect flow + links to any capability routes.
import { Link } from 'react-router-dom'
import { ConnectWallet } from './ConnectWallet.js'
import { useWallet } from './WalletContext.js'

export function Home () {
  const { connected } = useWallet()
  return (
    <main style={{ maxWidth: 640, margin: '40px auto', fontFamily: 'system-ui' }}>
      <h1>BSV app</h1>
      <p>Scaffolded by create-bsv-app. Connect a wallet to get started.</p>
      <ConnectWallet />
      {connected && <p><Link to="/login">Go to login →</Link></p>}
    </main>
  )
}
`

function agentsSection (_ctx: CapabilityContext): string {
  return `## wallet-connect (base)

Connect any BRC-100 wallet — desktop (\`@bsv/sdk\` \`WalletClient('auto')\`) or mobile/relay (\`@bsv/wallet-relay\`) — and expose it app-wide via a connect state machine.

- \`auth.ts\` (shared) — \`createAuthProof(wallet, { counterparty, action, body? })\` + \`verifyAuthProof(serverWallet, proof, { action, body? }, consumeNonce)\`. The proof primitive both \`wallet-login\` and \`signed-requests\` build on.
- \`walletAcquisition.ts\` (client) — \`connectDesktopWallet()\`.
- \`WalletConnectionContext.tsx\` / \`WalletContext.tsx\` / \`WalletProviders.tsx\` (client) — relay session + wallet state; consume the wallet anywhere via \`useWallet()\`.
- \`ConnectWallet.tsx\` (client) — button + modal (mobile QR / install link). Driven by the connect state machine: desktop-first, relay fallback.
- \`Home.tsx\` (client) — default home page with \`<ConnectWallet />\`. Capability variants add their own routes on top.
- New projects (glue on): \`src/main.tsx\` is wired to wrap \`<App/>\` in \`<WalletProviders>\` via \`baseEdits\`. With \`--no-glue\` or add mode: wrap your root with \`<WalletProviders>\` yourself.
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
      { path: 'WalletProviders.tsx', content: PROVIDERS },
      { path: 'ConnectWallet.tsx', content: CONNECT_WALLET },
      { path: 'Home.tsx', content: HOME }
    ]
  }),
  baseEdits: ({ builder, ctx }: { builder: BaseBuilder, ctx: CapabilityContext }) => {
    builder.main.imports.push(`import { WalletProviders } from '${bsvImport(ctx, 'WalletProviders')}'`)
    builder.main.wraps.push({ open: '<WalletProviders>', close: '</WalletProviders>' })
  },
  npmDependencies: () => ({
    shared: { '@bsv/auth': '^0.1.0', '@bsv/sdk': '^2.1.0' },
    client: { '@bsv/wallet-relay': '^0.2.0', react: '>=18', 'react-router-dom': '^7.0.0' }
  }),
  agentsSection
}
