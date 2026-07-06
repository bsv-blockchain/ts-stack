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

const CLIENT_CONFIG = `// Centralized client configuration. Vite loads VITE_-prefixed vars from client/.env.
// Base URL of the server API. Defaults to the dev server; set VITE_API_URL in production
// (or whenever the client is served from a different origin than the API).
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'
`

const SERVER_IDENTITY = `// Fetch the server's identity public key (its wallet's identityKey) once, and cache it.
// Used as the proof \`counterparty\` for login / signed requests — the server exposes it
// at GET /api/identity (baseline route), so no key needs to be hard-coded client-side.
import { API_BASE_URL } from './config.js'

let cached: string | null = null

export async function getServerIdentity (endpoint = '/api/identity'): Promise<string> {
  if (cached !== null) return cached
  const res = await fetch(API_BASE_URL + endpoint)
  if (!res.ok) throw new Error('failed to fetch server identity: ' + String(res.status))
  const { identityKey } = await res.json() as { identityKey: string }
  cached = identityKey
  return identityKey
}
`

const RELAY_CONTEXT = `// Relay-session context: wraps @bsv/wallet-relay's hook so a single relay client
// (mobile QR / remote wallet) lives above the router. Port/extend from your app as needed.
import { createContext, useContext, type ReactNode } from 'react'
import { useWalletRelayClient } from '@bsv/wallet-relay/react'
import { API_BASE_URL } from './config.js'

type RelayValue = ReturnType<typeof useWalletRelayClient>
const Ctx = createContext<RelayValue | null>(null)

export function WalletConnectionProvider ({ children, apiUrl = API_BASE_URL }: { children: ReactNode, apiUrl?: string }) {
  // apiUrl points at the server running the WalletRelayService (REST /api/session + WS /ws).
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

const BSV_CSS = `/* Shared dark theme for the scaffolded BSV pages — accent #2196F3.
   Imported once by WalletProviders; delete or restyle freely. */
:root {
  --bsv-accent: #2196F3;
  --bsv-ink: #06121f;
  --bsv-bg: #0b0e13;
  --bsv-surface: #0f151c;
  --bsv-surface-deep: #05070a;
  --bsv-border: #2c3540;
  --bsv-border-soft: #243441;
  --bsv-text: #cdd4de;
  --bsv-strong: #e8edf4;
  --bsv-muted: #7b8694;
  --bsv-green: #7fd6a0;
  --bsv-err: #e06a5a;
  --bsv-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
body { margin: 0; display: block; background: var(--bsv-bg); color: var(--bsv-text); font: 14px/1.5 system-ui, -apple-system, sans-serif; }
.bsv-page { max-width: 680px; margin: 0 auto; padding: 56px 24px 96px; }
.bsv-page h1 { margin: 0 0 8px; font: 600 26px/1.15 system-ui; color: var(--bsv-strong); }
.bsv-page > p { margin: 0 0 22px; color: var(--bsv-muted); }
.bsv-back { display: inline-block; margin-bottom: 22px; color: var(--bsv-muted); text-decoration: none; font-size: 13px; }
.bsv-back:hover { color: var(--bsv-text); }
code { font-family: var(--bsv-mono); color: var(--bsv-strong); }
.bsv-btn { height: 44px; padding: 0 20px; border: 0; border-radius: 7px; background: var(--bsv-accent); color: var(--bsv-ink); font: 600 14px/1 system-ui; cursor: pointer; }
.bsv-btn:hover { filter: brightness(1.07); }
.bsv-btn:disabled { opacity: .5; cursor: default; filter: none; }
.bsv-btn-ghost { height: 40px; padding: 0 16px; border: 1px solid var(--bsv-border); border-radius: 7px; background: transparent; color: #aab3bf; font: 500 13px/1 system-ui; cursor: pointer; }
.bsv-btn-ghost:hover { border-color: #3d4855; color: var(--bsv-text); }
.bsv-connect { margin: 20px 0; }
.bsv-connect button { height: 44px; padding: 0 20px; border: 0; border-radius: 7px; background: var(--bsv-accent); color: var(--bsv-ink); font: 600 14px/1 system-ui; cursor: pointer; }
.bsv-connect button:hover { filter: brightness(1.07); }
.bsv-connect button:disabled { opacity: .5; cursor: default; filter: none; }
.bsv-connected { display: inline-block; margin: 20px 0; padding: 10px 14px; border: 1px solid #1d3d28; border-radius: 8px; background: #0f2418; color: var(--bsv-green); font: 500 13px/1.4 system-ui; }
.bsv-page button + button, .bsv-page .bsv-btn { margin-top: 4px; }
.bsv-label { margin: 0 0 4px; font: 600 11px/1 system-ui; letter-spacing: .1em; text-transform: uppercase; color: var(--bsv-muted); }
.bsv-nav { margin-top: 28px; display: grid; gap: 9px; }
.bsv-nav a { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border: 1px solid var(--bsv-border-soft); border-radius: 10px; background: var(--bsv-surface); color: var(--bsv-text); text-decoration: none; font: 500 14px/1 system-ui; }
.bsv-nav a:hover { border-color: var(--bsv-accent); background: rgba(33,150,243,.07); color: var(--bsv-strong); }
.bsv-log { margin: 20px 0 0; padding: 14px 16px 14px 36px; list-style: decimal; background: var(--bsv-surface-deep); border: 1px solid #1d242d; border-radius: 8px; font: 400 12.5px/1.9 var(--bsv-mono); color: #9aa6b2; }
.bsv-result { margin-top: 16px; padding: 14px 16px; background: var(--bsv-surface-deep); border: 1px solid #1d242d; border-radius: 8px; font: 400 12.5px/1.7 var(--bsv-mono); color: var(--bsv-text); white-space: pre-wrap; word-break: break-word; }
.bsv-err { margin-top: 14px; color: var(--bsv-err); font-size: 13px; }
.bsv-modal { position: fixed; inset: 0; background: rgba(4,6,9,.82); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.bsv-modal-card { width: 100%; max-width: 380px; background: #0e141b; border: 1px solid var(--bsv-border-soft); border-radius: 14px; padding: 26px; text-align: center; box-shadow: 0 24px 70px rgba(0,0,0,.55); }
.bsv-modal-card h3 { margin: 0 0 16px; font: 600 17px/1.3 system-ui; color: var(--bsv-strong); }
.bsv-modal-card .bsv-btn, .bsv-modal-card .bsv-btn-ghost { display: block; width: 100%; margin-top: 9px; }
.bsv-modal-card a { display: inline-block; margin-top: 12px; color: var(--bsv-accent); font-size: 13px; }
.bsv-modal-card img { width: 210px; height: 210px; margin-top: 6px; border-radius: 10px; background: #fff; padding: 8px; }
`

const PROVIDERS = `// Compose the wallet providers in the required order (relay above wallet).
import './bsv.css'
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
                <button className="bsv-btn" onClick={() => { void connectMobile() }}>Connect with a mobile wallet</button>
                <a href={INSTALL_URL} target="_blank" rel="noreferrer">Install a desktop wallet</a>
              </>
            )}
            {status === 'pairing' && (
              <>
                <h3>Scan with your mobile wallet</h3>
                {relay.session?.qrDataUrl != null ? <img src={relay.session.qrDataUrl} alt="Pairing QR" /> : <p>Generating code…</p>}
              </>
            )}
            <button className="bsv-btn-ghost" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
`

function agentsSection (_ctx: CapabilityContext): string {
  return `## wallet-connect (base)

Connect any BRC-100 wallet — desktop (\`@bsv/sdk\` \`WalletClient('auto')\`) or mobile/relay (\`@bsv/wallet-relay\`) — use it app-wide, and sign/verify the \`@bsv/auth\` proofs that \`wallet-login\` and \`signed-requests\` build on.

### How it works
- Connecting is a small state machine: it tries the desktop/extension wallet first; if none is found it opens a modal to pair a mobile wallet over a relay (QR) or install a desktop one. The connected wallet lives in React context, reachable anywhere via \`useWallet()\`.
- The **mobile/relay path needs a server**: the base server entry runs \`new WalletRelayService({ app, server, wallet: serverWallet, origin })\` from \`@bsv/wallet-relay\`, which registers \`GET /api/session\` (+ \`/:id\`, \`POST /api/request/:id\`) and a \`/ws\` WebSocket upgrade on the raw HTTP server. The client (\`useWalletRelayClient\`, pointed at \`API_BASE_URL\`) creates a session, shows its QR, and pairs over \`/ws\`. Frontend-only projects (no server) get desktop connect only.
- The proof primitive (\`auth.ts\`) uses the wallet to sign a message bound to \`{ counterparty, action, body? }\` and verifies it server-side (BRC-103). That's identity (and request auth) without passwords or shared secrets.
- The server publishes its own identity key at \`GET /api/identity\`; the client fetches it (\`getServerIdentity()\`) to use as the proof \`counterparty\`, so no key is hard-coded anywhere.

### How it's used
- \`auth.ts\` (shared) — \`createAuthProof(wallet, { counterparty, action, body? })\` and \`verifyAuthProof(serverWallet, proof, { action, body? }, consumeNonce)\`.
- \`config.ts\` (client) — \`API_BASE_URL\` (from \`VITE_API_URL\`, default \`http://localhost:3000\`); the server base every fetch helper targets.
- \`serverIdentity.ts\` (client) — \`getServerIdentity()\` fetches + caches the server's identity key from \`GET /api/identity\`.
- \`walletAcquisition.ts\` (client) — \`connectDesktopWallet()\`.
- \`WalletConnectionContext.tsx\` / \`WalletContext.tsx\` / \`WalletProviders.tsx\` (client) — relay session + wallet state; consume via \`useWallet()\`.
- \`ConnectWallet.tsx\` (client) — the connect button + desktop-fail modal.
- New projects (glue on): \`src/main.tsx\` wraps \`<App/>\` in \`<WalletProviders>\`, and a generated \`Home.tsx\` hub links to each installed capability's page once a wallet connects. With \`--no-glue\` / add mode: wrap your root in \`<WalletProviders>\` and build your own home.

### Future integrations
- Persist the connection across reloads (re-probe the desktop wallet / restore the relay session on load).
- Reuse the proof primitive for any action beyond login — bind a proof to any \`{ action, body }\` (that's exactly what \`signed-requests\` does).
- Layer identity certificates (BRC-52/103) on top of the raw identity key when you need verified attributes, not just a public key.
`
}

export const walletConnect: Capability = {
  id: 'wallet-connect',
  title: 'Wallet connect (desktop + relay, app-wide context)',
  description: 'Base: connect any BRC-100 wallet (desktop or mobile/relay) and use it across the app, plus the @bsv/auth proof primitive.',
  roles: ['shared', 'client', 'server'],
  defaultSelected: true,
  files: () => ({
    shared: [{ path: 'auth.ts', content: AUTH_UTIL }],
    client: [
      { path: 'walletAcquisition.ts', content: ACQUISITION },
      { path: 'serverIdentity.ts', content: SERVER_IDENTITY },
      { path: 'WalletConnectionContext.tsx', content: RELAY_CONTEXT },
      { path: 'WalletContext.tsx', content: WALLET_CONTEXT },
      { path: 'WalletProviders.tsx', content: PROVIDERS },
      { path: 'ConnectWallet.tsx', content: CONNECT_WALLET },
      { path: 'config.ts', content: CLIENT_CONFIG },
      { path: 'bsv.css', content: BSV_CSS }
    ]
  }),
  baseEdits: ({ builder, ctx }: { builder: BaseBuilder, ctx: CapabilityContext }) => {
    builder.main.imports.push(`import { WalletProviders } from '${bsvImport(ctx, 'WalletProviders')}'`)
    builder.main.wraps.push({ open: '<WalletProviders>', close: '</WalletProviders>' })
    // Server side of the relay: one service registers REST /api/session(+/:id, /request/:id) and the /ws upgrade.
    builder.server.imports.push("import { WalletRelayService } from '@bsv/wallet-relay'")
    builder.server.setup.push('new WalletRelayService({ app, server, wallet: serverWallet, origin: CLIENT_ORIGIN }) // mobile-wallet pairing relay (QR)')
  },
  npmDependencies: () => ({
    shared: { '@bsv/auth': '^0.1.0', '@bsv/sdk': '^2.1.0' },
    client: { '@bsv/wallet-relay': '^0.2.0', react: '>=18', 'react-router-dom': '^7.0.0' },
    // @bsv/wallet-relay's peer deps for the server-side WalletRelayService.
    server: { '@bsv/wallet-relay': '^0.2.0', qrcode: '^1.5.0', ws: '^8.0.0' }
  }),
  agentsSection
}
