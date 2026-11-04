import { describe, expect, test } from '@jest/globals'
import ts from 'typescript'
import { walletConnect } from '../wallet-connect'

// Runs the generated WalletContext.tsx provider under a minimal hook runtime (no React
// dependency): state slots, effects with dependency comparison and cleanup, render-phase
// state updates, and a render loop driven by state changes. The relay hook and desktop
// connect are mocked.

interface FakeWallet {
  getPublicKey: (args: unknown) => Promise<{ publicKey: string }>
}
interface FakeRelay {
  session: { status: string } | null
  wallet: FakeWallet | null
  createSession: () => Promise<void>
  cancelSession: () => void
}
interface WalletValue {
  wallet: unknown
  identityKey: string | null
  connected: boolean
  status: string
  connect: () => Promise<void>
}

const ctx = {
  name: 'demo',
  network: 'test' as const,
  bsvDir: 'src/bsv',
  stack: { frontend: { framework: 'react' as const, variant: 'react-ts' } },
  layout: 'frontend-only' as const
}

const source = (walletConnect.files(ctx).client ?? []).find(f => f.path === 'WalletContext.tsx')
  ?.content as string
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX
  }
}).outputText

const wallet = (publicKey: string): FakeWallet => ({
  getPublicKey: async () => ({ publicKey })
})

function mount(relay: FakeRelay, desktop: FakeWallet) {
  const states: unknown[] = []
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = []
  const queued: Array<() => void> = []
  let cursor = 0
  let dirty = true
  let value: WalletValue | undefined
  const history: WalletValue[] = []

  const react = {
    createContext: () => ({ Provider: 'Provider' }),
    useContext: () => null,
    useCallback: (fn: unknown) => fn,
    useState: (init: unknown) => {
      const slot = cursor++
      if (!(slot in states)) states[slot] = init
      return [
        states[slot],
        (next: unknown) => {
          if (!Object.is(states[slot], next)) {
            states[slot] = next
            dirty = true
          }
        }
      ]
    },
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const slot = cursor++
      const prev = effects[slot]
      if (prev !== undefined && deps.every((d, i) => Object.is(d, prev.deps[i]))) return
      queued.push(() => {
        prev?.cleanup?.()
        effects[slot] = { deps, cleanup: fn() ?? undefined }
      })
    }
  }
  const modules: Record<string, unknown> = {
    react,
    'react/jsx-runtime': { jsx: (_type: unknown, props: { value: WalletValue }) => props },
    './walletAcquisition.js': {
      connectDesktopWallet: async () => ({ wallet: desktop, identityKey: 'desktop-key' })
    },
    './WalletConnectionContext.js': { useWalletConnection: () => relay }
  }
  const exports: Record<string, unknown> = {}
  new Function('require', 'exports', compiled)((id: string) => modules[id], exports)
  const WalletProvider = exports.WalletProvider as (props: { children: null }) => {
    value: WalletValue
  }

  const settle = async (): Promise<WalletValue> => {
    for (let round = 0; round < 20; round++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      for (let renders = 0; dirty; renders++) {
        if (renders > 20) throw new Error('render loop')
        dirty = false
        cursor = 0
        value = WalletProvider({ children: null }).value
        // A state update during render makes React re-render before committing it.
        if (dirty) {
          queued.length = 0
          continue
        }
        history.push(value)
        for (const run of queued.splice(0)) run()
      }
    }
    return value as WalletValue
  }
  // A relay change re-renders the provider, as the hook's state update would.
  const update = async (patch: Partial<FakeRelay>): Promise<WalletValue> => {
    Object.assign(relay, patch)
    dirty = true
    return await settle()
  }
  return { settle, update, history }
}

const newRelay = (): FakeRelay => ({
  session: null,
  wallet: null,
  createSession: async () => {},
  cancelSession: () => {}
})

describe('generated WalletContext follows the relay session', () => {
  test.each(['disconnected', 'expired'])(
    'relay wallet is dropped when the session is %s',
    async status => {
      const relay = newRelay()
      const { settle, update } = mount(relay, wallet('desktop-key'))
      await settle()
      const connected = await update({
        session: { status: 'connected' },
        wallet: wallet('relay-key')
      })
      expect(connected).toMatchObject({
        identityKey: 'relay-key',
        connected: true,
        status: 'connected'
      })
      // The hook exposes wallet = null whenever the session is not 'connected'.
      const after = await update({ session: { status }, wallet: null })
      expect(after).toMatchObject({
        wallet: null,
        identityKey: null,
        connected: false,
        status: 'disconnected'
      })
    }
  )

  test('relay wallet is dropped when the relay session goes away', async () => {
    const relay = newRelay()
    const { settle, update } = mount(relay, wallet('desktop-key'))
    await settle()
    await update({ session: { status: 'connected' }, wallet: wallet('relay-key') })
    const after = await update({ session: null, wallet: null })
    expect(after).toMatchObject({ wallet: null, connected: false, status: 'disconnected' })
  })

  test('desktop wallet is kept when a relay session reports disconnected', async () => {
    const relay = newRelay()
    const desktop = wallet('desktop-key')
    const { settle, update } = mount(relay, desktop)
    const initial = await settle()
    await initial.connect()
    const connected = await settle()
    expect(connected).toMatchObject({
      wallet: desktop,
      identityKey: 'desktop-key',
      status: 'connected'
    })
    const after = await update({ session: { status: 'disconnected' }, wallet: null })
    expect(after).toMatchObject({
      wallet: desktop,
      identityKey: 'desktop-key',
      status: 'connected'
    })
  })

  test('a relay reconnect is adopted again', async () => {
    const relay = newRelay()
    const { settle, update } = mount(relay, wallet('desktop-key'))
    await settle()
    await update({ session: { status: 'connected' }, wallet: wallet('relay-key') })
    await update({ session: { status: 'disconnected' }, wallet: null })
    const again = await update({ session: { status: 'connected' }, wallet: wallet('relay-key-2') })
    expect(again).toMatchObject({
      identityKey: 'relay-key-2',
      connected: true,
      status: 'connected'
    })
  })

  test('an adopt still in flight when the session disconnects does not resurrect the wallet', async () => {
    const relay = newRelay()
    let release: (key: { publicKey: string }) => void = () => {}
    const slow: FakeWallet = {
      getPublicKey: async () =>
        await new Promise(resolve => {
          release = resolve
        })
    }
    const { settle, update, history } = mount(relay, wallet('desktop-key'))
    await settle()
    await update({ session: { status: 'connected' }, wallet: slow })
    await update({ session: { status: 'disconnected' }, wallet: null })
    const mark = history.length
    release({ publicKey: 'late-key' })
    const after = await settle()
    expect(after).toMatchObject({
      wallet: null,
      identityKey: null,
      connected: false,
      status: 'disconnected'
    })
    // Not even briefly: no render after the disconnect shows the late key.
    expect(history.slice(mark).map(v => v.identityKey)).not.toContain('late-key')
  })

  test('a stale adopt resolving after a reconnect does not replace the new relay wallet', async () => {
    const relay = newRelay()
    let release: (key: { publicKey: string }) => void = () => {}
    const slow: FakeWallet = {
      getPublicKey: async () =>
        await new Promise(resolve => {
          release = resolve
        })
    }
    const fresh = wallet('relay-key-2')
    const { settle, update } = mount(relay, wallet('desktop-key'))
    await settle()
    await update({ session: { status: 'connected' }, wallet: slow })
    await update({ session: { status: 'disconnected' }, wallet: null })
    await update({ session: { status: 'connected' }, wallet: fresh })
    release({ publicKey: 'late-key' })
    const after = await settle()
    expect(after).toMatchObject({ wallet: fresh, identityKey: 'relay-key-2', status: 'connected' })
  })

  test('a relay adopt resolving after a desktop connect does not replace the desktop wallet', async () => {
    const relay = newRelay()
    let release: (key: { publicKey: string }) => void = () => {}
    const slow: FakeWallet = {
      getPublicKey: async () =>
        await new Promise(resolve => {
          release = resolve
        })
    }
    const desktop = wallet('desktop-key')
    const { settle, update } = mount(relay, desktop)
    const initial = await settle()
    await update({ session: { status: 'connected' }, wallet: slow })
    await initial.connect()
    await settle()
    release({ publicKey: 'late-key' })
    const after = await settle()
    expect(after).toMatchObject({
      wallet: desktop,
      identityKey: 'desktop-key',
      status: 'connected'
    })
  })
})
