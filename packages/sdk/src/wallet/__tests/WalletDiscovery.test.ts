import ProtoWallet from '../ProtoWallet'
import PrivateKey from '../../primitives/PrivateKey'
import {
  announceWallet,
  collectWalletAnnouncements,
  discoverWallets,
  walletNameFromVersion,
  WALLET_ANNOUNCE_EVENT,
  WALLET_REQUEST_EVENT
} from '../WalletDiscovery'

const wallet = (version = 'test-wallet-1.0.0'): ProtoWallet => {
  const w = new ProtoWallet(PrivateKey.fromRandom())
  w.getVersion = async () => ({ version })
  return w
}
const noLocal = { announceMs: 20, probeLocal: false }

// Only the browser page is simulated (Node's own EventTarget/CustomEvent); discovery is real.
beforeEach(() => {
  const page: any = new EventTarget()
  page.location = { host: 'app.example' }
  page.self = page
  page.top = page
  ;(globalThis as any).window = page
})
afterEach(() => {
  delete (globalThis as any).window
})

describe('WalletDiscovery', () => {
  it('collects every announced wallet and dedupes by rdns', async () => {
    const stops = [
      announceWallet({ name: 'A', icon: '', rdns: 'com.example.a', kind: 'extension' }, wallet()),
      announceWallet(
        { name: 'A newer', icon: '', rdns: 'com.example.a', kind: 'extension' },
        wallet()
      ),
      announceWallet({ name: 'B', icon: '', rdns: 'com.example.b', kind: 'desktop' }, wallet())
    ]
    const found = await collectWalletAnnouncements(20)
    expect(found.map(f => f.info.rdns).sort()).toEqual(['com.example.a', 'com.example.b'])
    expect(found.find(f => f.info.rdns === 'com.example.a')?.info.name).toBe('A newer')
    for (const stop of stops) stop()
    expect(await collectWalletAnnouncements(20)).toEqual([])
  })

  it('announces immediately and again on each request, with a frozen detail', () => {
    const seen: any[] = []
    const on = (e: Event): void => {
      seen.push((e as CustomEvent).detail)
    }
    window.addEventListener(WALLET_ANNOUNCE_EVENT, on)
    const stop = announceWallet(
      { name: 'A', icon: '', rdns: 'com.example.a', kind: 'extension' },
      wallet()
    )
    window.dispatchEvent(new Event(WALLET_REQUEST_EVENT))
    stop()
    window.dispatchEvent(new Event(WALLET_REQUEST_EVENT))
    window.removeEventListener(WALLET_ANNOUNCE_EVENT, on)
    expect(seen).toHaveLength(2)
    expect(Object.isFrozen(seen[0])).toBe(true)
    expect(Object.isFrozen(seen[0].info)).toBe(true)
    expect(seen[0].info.uuid).toMatch(/^[0-9a-f]{32}$/)
  })

  it('lists an unannounced window.CWI, named from its version', async () => {
    ;(window as any).CWI = wallet('yours-wallet-5.0.2')
    const list = await discoverWallets(noLocal)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      name: 'Yours Wallet',
      rdns: 'legacy.window-cwi',
      source: 'window.CWI'
    })
  })

  it('shows a wallet that both announces and owns window.CWI once, under its announced name', async () => {
    const w = wallet('yours-wallet-5.0.2')
    ;(window as any).CWI = w
    const stop = announceWallet(
      { name: 'Yours', icon: '', rdns: 'org.yours', kind: 'extension' },
      w
    )
    const list = await discoverWallets(noLocal)
    stop()
    expect(list.map(x => x.name)).toEqual(['Yours'])
  })

  it('lists every wallet together, not just the first', async () => {
    ;(window as any).CWI = wallet('legacy-wallet-1.0.0')
    const stop = announceWallet(
      { name: 'A', icon: '', rdns: 'com.example.a', kind: 'extension' },
      wallet()
    )
    const list = await discoverWallets(noLocal)
    stop()
    expect(list.map(x => x.source)).toEqual(['announced', 'window.CWI'])
  })

  it('ignores malformed announcements', async () => {
    const bad = (): void => {
      window.dispatchEvent(
        new CustomEvent(WALLET_ANNOUNCE_EVENT, {
          detail: { info: { name: 'no rdns' }, wallet: {} }
        })
      )
      window.dispatchEvent(new CustomEvent(WALLET_ANNOUNCE_EVENT, { detail: null }))
    }
    window.addEventListener(WALLET_REQUEST_EVENT, bad)
    const found = await collectWalletAnnouncements(20)
    window.removeEventListener(WALLET_REQUEST_EVENT, bad)
    expect(found).toEqual([])
  })

  it('derives names from version strings', () => {
    expect(walletNameFromVersion('yours-wallet-5.0.2', 'x')).toBe('Yours Wallet')
    expect(walletNameFromVersion('1.0.0', 'Desktop wallet')).toBe('Desktop wallet')
  })
})
