import type { WalletInterface } from './Wallet.interfaces.js'
import HTTPWalletJSON from './substrates/HTTPWalletJSON.js'
import XDMSubstrate from './substrates/XDM.js'
import Random from '../primitives/Random.js'
import { toHex } from '../primitives/utils.js'

/**
 * How a discovered wallet is reached.
 */
export type DiscoveredWalletKind = 'extension' | 'desktop' | 'in-app' | 'web' | 'mobile' | 'other'

/**
 * What a wallet tells apps about itself when it announces.
 * `name`, `icon` and `rdns` are self-asserted: show them to the user, never treat them as proof.
 */
export interface WalletAnnouncementInfo {
  /** Random per page load; dedupes repeat announcements. */
  uuid: string
  /** The wallet's own human-readable name. */
  name: string
  /** Square icon as a data: URI. Render it with an image element only, never as markup. */
  icon: string
  /** Stable reverse-DNS id of a domain the wallet controls, e.g. `com.example.wallet`. */
  rdns: string
  kind: DiscoveredWalletKind
}

export interface WalletAnnouncement {
  info: WalletAnnouncementInfo
  wallet: WalletInterface
}

/**
 * A wallet found by {@link discoverWallets}. Pass `wallet` to `new WalletClient(wallet, originator)`.
 */
export interface DiscoveredWallet {
  rdns: string
  name: string
  icon: string | null
  kind: DiscoveredWalletKind
  wallet: WalletInterface
  /** How it was found: announced, or a fallback for wallets that do not announce. */
  source: 'announced' | 'xdm' | 'window.CWI' | 'http'
}

export interface DiscoverWalletsOptions {
  /** The app's domain, sent to local HTTP wallets. Defaults to `location.host`. */
  originator?: string
  /** How long to collect announcements, in ms. Default 400. */
  announceMs?: number
  /** Probe desktop wallets on localhost:3321 and :2121. Default true, except on mobile user agents. */
  probeLocal?: boolean
  /** Timeout for each fallback probe, in ms. Default 1500. */
  probeTimeoutMs?: number
}

/** App to wallets: "which wallets are here?" */
export const WALLET_REQUEST_EVENT = 'brc100:requestWallet'
/** Wallet to app: one announcement per wallet. */
export const WALLET_ANNOUNCE_EVENT = 'brc100:announceWallet'

const isMobileAgent = (): boolean =>
  typeof navigator !== 'undefined' && /iPhone|iPad|Android/i.test(navigator.userAgent)

const isFramed = (): boolean => {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Derives a display name from a wallet version string: "yours-wallet-5.0.2" becomes "Yours Wallet". */
export function walletNameFromVersion(version: string, fallback: string): string {
  const base = version.replace(/[-_ ]?v?\d[\d.]*.*$/, '')
  if (base === '') return fallback
  return base
    .split(/[-_ ]+/)
    .filter(w => w !== '')
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Asks every wallet in the page to announce itself and collects the replies for `ms`.
 * Deduped by `rdns`; the latest announcement wins.
 */
export async function collectWalletAnnouncements(ms = 400): Promise<WalletAnnouncement[]> {
  if (typeof window === 'undefined') return []
  return await new Promise(resolve => {
    const found = new Map<string, WalletAnnouncement>()
    const onAnnounce = (e: Event): void => {
      const detail = (e as CustomEvent<WalletAnnouncement>).detail
      if (typeof detail?.info?.rdns === 'string' && detail.wallet != null) {
        found.set(detail.info.rdns, detail)
      }
    }
    window.addEventListener(WALLET_ANNOUNCE_EVENT, onAnnounce)
    window.dispatchEvent(new Event(WALLET_REQUEST_EVENT))
    setTimeout(() => {
      window.removeEventListener(WALLET_ANNOUNCE_EVENT, onAnnounce)
      resolve([...found.values()])
    }, ms)
  })
}

async function probeHttpWallet(
  originator: string,
  baseUrl: string,
  rdns: string,
  timeoutMs: number
): Promise<DiscoveredWallet | null> {
  try {
    const wallet = new HTTPWalletJSON(originator, baseUrl)
    const { version } = await withTimeout(wallet.getVersion({}), timeoutMs)
    return {
      rdns,
      name: walletNameFromVersion(version, 'Desktop wallet'),
      icon: null,
      kind: 'desktop',
      wallet,
      source: 'http'
    }
  } catch {
    return null
  }
}

/**
 * Finds every BRC-100 wallet available to this page, so the user can choose one.
 *
 * Unlike `new WalletClient('auto')`, which connects to the first substrate that answers, this
 * returns all of them: wallets that announce themselves (`brc100:announceWallet`), the host of an
 * in-app browser frame (XDM), an unannounced `window.CWI`, and desktop wallets on
 * `localhost:3321` / `localhost:2121`. It never picks one.
 *
 * Call it when the user starts connecting, not on page load: the local probes reveal to the page
 * whether a desktop wallet is running.
 */
export async function discoverWallets(
  options: DiscoverWalletsOptions = {}
): Promise<DiscoveredWallet[]> {
  if (typeof window === 'undefined') return []
  const originator = options.originator ?? window.location.host
  const timeoutMs = options.probeTimeoutMs ?? 1500
  const framed = isFramed()
  const probeLocal = (options.probeLocal ?? !isMobileAgent()) && !framed

  // Run the slower local probes alongside the announcement window.
  const local = probeLocal
    ? Promise.all([
        probeHttpWallet(originator, 'http://localhost:3321', 'local.json-api.3321', timeoutMs),
        probeHttpWallet(
          originator,
          'https://localhost:2121',
          'local.secure-json-api.2121',
          timeoutMs
        )
      ])
    : Promise.resolve([])

  const list: DiscoveredWallet[] = (await collectWalletAnnouncements(options.announceMs)).map(
    a => ({
      rdns: a.info.rdns,
      name: a.info.name,
      icon: a.info.icon ?? null,
      kind: a.info.kind ?? 'extension',
      wallet: a.wallet,
      source: 'announced'
    })
  )

  if (framed && !list.some(w => w.kind === 'in-app')) {
    try {
      const host = new XDMSubstrate()
      const { version } = await withTimeout(host.getVersion({}), timeoutMs)
      list.push({
        rdns: 'legacy.xdm-host',
        name: walletNameFromVersion(version, 'In-app wallet'),
        icon: null,
        kind: 'in-app',
        wallet: host,
        source: 'xdm'
      })
    } catch {
      // Framed by a page that is not a wallet.
    }
  }

  const cwi = (window as unknown as { CWI?: WalletInterface }).CWI
  if (cwi != null && !list.some(w => w.wallet === cwi)) {
    let name = 'Browser wallet'
    try {
      name = walletNameFromVersion((await withTimeout(cwi.getVersion({}), timeoutMs)).version, name)
    } catch {
      // Locked or slow: keep the generic name.
    }
    list.push({
      rdns: 'legacy.window-cwi',
      name,
      icon: null,
      kind: 'extension',
      wallet: cwi,
      source: 'window.CWI'
    })
  }

  for (const w of await local) if (w != null) list.push(w)
  return list
}

/**
 * For wallets: announces `wallet` to the page now and whenever an app asks.
 * Returns a function that stops announcing.
 */
export function announceWallet(
  info: Omit<WalletAnnouncementInfo, 'uuid'>,
  wallet: WalletInterface
): () => void {
  const detail = Object.freeze({
    info: Object.freeze({ ...info, uuid: toHex(Random(16)) }),
    wallet
  })
  const announce = (): void => {
    window.dispatchEvent(new CustomEvent(WALLET_ANNOUNCE_EVENT, { detail }))
  }
  window.addEventListener(WALLET_REQUEST_EVENT, announce)
  announce()
  return () => window.removeEventListener(WALLET_REQUEST_EVENT, announce)
}
