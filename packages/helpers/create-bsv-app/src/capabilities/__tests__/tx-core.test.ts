import { describe, expect, test } from '@jest/globals'
import {
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  Transaction,
  Utils,
  Validation
} from '@bsv/sdk'
import type { CreateActionArgs, InternalizeActionArgs } from '@bsv/sdk'
import { txCore, TRANSACTIONS_SOURCE, TX_UTILS_SOURCE } from '../tx-core'
import { WALLET_RELAY_RANGE } from '../versions'
import { walletConnect } from '../wallet-connect'
import { getCapability } from '../../registry'
import { planPlacement } from '../../engine'
import { resolveConfig } from '../../config/validate'
import { assembleBaseFile, APP_TEMPLATE, HOME_TEMPLATE, newBuilder } from '../../scaffold/base-app'
import { loadGenerated } from '../../__tests__/helpers/generated-module'
import type { ProjectConfig } from '../../config/model'
import type { CapabilityContext } from '../../types'

const baseConfig: ProjectConfig = {
  mode: 'add',
  name: 'demo',
  dir: '.',
  starter: 'custom',
  stack: {},
  targets: {},
  bsvDir: 'src/bsv',
  capabilities: ['wallet-connect', 'tx-core'],
  glue: false,
  install: false,
  packageManager: 'npm',
  network: 'test'
}
const monorepo: ProjectConfig = {
  ...baseConfig,
  stack: {
    frontend: { framework: 'react', variant: 'react-ts' },
    backend: { framework: 'express' }
  },
  targets: { client: 'client', server: 'server' }
}
const frontendOnly: ProjectConfig = {
  ...baseConfig,
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  targets: { client: '' }
}
const backendOnly: ProjectConfig = {
  ...baseConfig,
  stack: { backend: { framework: 'express' } },
  targets: { server: '' }
}
const caps = [walletConnect, txCore]
const paths = (c: ProjectConfig): string[] => planPlacement(c, caps).utilFiles.map(f => f.path)

describe('tx-core registry and placement', () => {
  test('is registered, selected by default and builds on wallet-connect', () => {
    expect(getCapability('tx-core')).toBe(txCore)
    expect(txCore.defaultSelected).toBe(true)
    expect(txCore.requires).toEqual(['wallet-connect'])
    expect(txCore.title).toBe('Transactions (build, send, read)')
  })
  test('monorepo: shared helpers on both sides, demo on the client only', () => {
    const p = paths(monorepo)
    for (const f of ['txUtils.ts', 'transactions.ts', 'TransactionsDemo.tsx']) {
      expect(p).toContain(`client/src/bsv/${f}`)
    }
    expect(p).toContain('server/src/bsv/txUtils.ts')
    expect(p).toContain('server/src/bsv/transactions.ts')
    expect(p).not.toContain('server/src/bsv/TransactionsDemo.tsx')
  })
  test('frontend-only gets all three under src/bsv', () => {
    const p = paths(frontendOnly)
    for (const f of ['txUtils.ts', 'transactions.ts', 'TransactionsDemo.tsx']) {
      expect(p).toContain(`src/bsv/${f}`)
    }
  })
  test('backend-only gets no demo', () => {
    const p = paths(backendOnly)
    expect(p).toContain('src/bsv/txUtils.ts')
    expect(p).toContain('src/bsv/transactions.ts')
    expect(p.some(f => f.includes('TransactionsDemo'))).toBe(false)
  })
  test.each([
    ['monorepo', monorepo, ['client', 'server']],
    ['frontend-only', frontendOnly, ['client']],
    ['backend-only', backendOnly, ['server']]
  ] as const)('%s: sdk and wallet-helper ranges on each target', (_n, config, targets) => {
    const { deps } = planPlacement(config, caps)
    for (const t of targets) {
      expect(deps[t]).toMatchObject({ '@bsv/sdk': '^4.0.1', '@bsv/wallet-helper': '^0.1.11' })
    }
  })
  test('a new-mode config with no capabilities selects tx-core and wallet-connect', () => {
    const config = resolveConfig({
      mode: 'new',
      name: 'app',
      stack: { frontend: { framework: 'react', variant: 'react-ts' } }
    })
    expect(config.capabilities).toContain('tx-core')
    expect(config.capabilities).toContain('wallet-connect')
  })
})

describe('tx-core generated app', () => {
  const ctx: CapabilityContext = {
    name: 'demo',
    network: 'test',
    bsvDir: 'src/bsv',
    stack: { frontend: { framework: 'react', variant: 'react-ts' } },
    layout: 'frontend-only'
  }
  const builder = newBuilder()
  txCore.baseEdits?.({ builder, ctx })
  test('route descriptor', () => {
    expect(builder.app.routes).toContainEqual({
      path: '/transactions',
      component: 'TransactionsDemo',
      importPath: './bsv/TransactionsDemo',
      label: 'Transactions'
    })
  })
  test('App routes /transactions and Home links to it', () => {
    const app = assembleBaseFile(APP_TEMPLATE, builder, ctx)
    expect(app).toContain('<Route path="/transactions" element={<TransactionsDemo />} />')
    expect(app).toContain("import { TransactionsDemo } from './bsv/TransactionsDemo'")
    expect(assembleBaseFile(HOME_TEMPLATE, builder, ctx)).toContain(
      '<Link to="/transactions">Transactions →</Link>'
    )
  })
})

// A minimal hook runtime: useState slots and a jsx that records { type, props } trees.
interface El {
  type: unknown
  props: Record<string, unknown>
}
interface Action {
  description: string
  outputs: Array<{ lockingScript: string; satoshis: number; outputDescription?: string }>
  options: { randomizeOutputs?: boolean; acceptDelayedBroadcast?: boolean }
}
interface KeyRequest {
  protocolID?: [number, string]
  keyID?: string
  counterparty?: string
  identityKey?: boolean
}
interface Calls {
  /** Every createAction the demo made, after the wallet's own validation. */
  actions: Action[]
  /** The transactions createAction answered with (requested outputs plus change, reversed). */
  txs: Transaction[]
  /** What createAction returned, byte for byte. */
  returned: Array<{ txid?: string; tx?: number[] }>
  internalized: InternalizeActionArgs[]
  keyRequests: KeyRequest[]
  derived: Map<string, string>
  identity: string
}

function makeTx(satoshis = 7): Transaction {
  return new Transaction(1, [], [{ lockingScript: new LockingScript([]), satoshis }])
}

const DEST = PrivateKey.fromRandom().toPublicKey().toAddress('testnet')

// The demo's local example functions, exported in tests only.
interface Examples {
  publishNote: (
    wallet: unknown,
    text: string
  ) => Promise<{ txid: string; vout: number; tx: Transaction }>
  sendSats: (
    wallet: unknown,
    to: string,
    satoshis: number
  ) => Promise<{ txid: string; tx?: Transaction }>
  sendToSelf: (
    wallet: unknown,
    satoshis: number
  ) => Promise<{ txid: string; internalized: boolean }>
}

interface MountOptions {
  /** BSV_NETWORK from the generated config.js. */
  config?: 'main' | 'test' | 'ttn'
  /** Extra wallet members, e.g. a getNetwork stub. */
  walletExtra?: object
  /**
   * What createAction answers: the txid and AtomicBEEF (default), the txid only, nothing, unparseable
   * bytes, or a real transaction that lacks the requested outputs.
   */
  returns?: 'tx' | 'no-tx' | 'no-txid' | 'garbage' | 'without-outputs'
  /** internalizeAction throws 'wallet refused'. */
  internalizeFails?: boolean
}

const demoSource = (
  txCore.files({
    name: 'demo',
    network: 'test',
    bsvDir: 'src/bsv',
    stack: {},
    layout: 'frontend-only'
  }).client ?? []
).find(f => f.path === 'TransactionsDemo.tsx')?.content as string

const core = loadGenerated(TRANSACTIONS_SOURCE) as {
  dataScript: (fields: string[]) => LockingScript
}

// The demo runs the real emitted transactions.ts and txUtils.ts against a stub wallet that validates
// createAction / internalizeAction the way the real WalletClient does.
// With hold set, createAction stays pending until release() is called; with fail set it throws.
function mountDemo(connected: boolean, hold = false, fail = false, options: MountOptions = {}) {
  let release: () => void = () => {}
  const gate = hold
    ? new Promise<void>(resolve => {
        release = resolve
      })
    : Promise.resolve()
  const identity = PrivateKey.fromRandom().toPublicKey().toString()
  const calls: Calls = {
    actions: [],
    txs: [],
    returned: [],
    internalized: [],
    keyRequests: [],
    derived: new Map(),
    identity
  }
  const answer = async (args: Action): Promise<{ txid?: string; tx?: number[] }> => {
    Validation.validateCreateActionArgs(args as unknown as CreateActionArgs)
    calls.actions.push(args)
    await gate
    if (fail) throw new Error('wallet said no')
    const returns = options.returns ?? 'tx'
    if (returns === 'no-txid') return {}
    if (returns === 'garbage') return { txid: 'b'.repeat(64), tx: [1, 2, 3] }
    const requested =
      returns === 'without-outputs'
        ? []
        : args.outputs.map(o => ({
            lockingScript: LockingScript.fromHex(o.lockingScript),
            satoshis: o.satoshis
          }))
    const change = {
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()),
      satoshis: 7
    }
    const tx = new Transaction(1, [], [...requested, change].reverse())
    calls.txs.push(tx)
    return returns === 'no-tx'
      ? { txid: tx.id('hex') }
      : { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
  }
  const wallet = {
    name: 'fake-wallet',
    createAction: async (args: Action) => {
      const result = await answer(args)
      calls.returned.push(result)
      return result
    },
    getPublicKey: async (args: KeyRequest) => {
      calls.keyRequests.push(args)
      if (args.identityKey === true) return { publicKey: identity }
      const keyID = args.keyID as string
      if (!calls.derived.has(keyID))
        calls.derived.set(keyID, PrivateKey.fromRandom().toPublicKey().toString())
      return { publicKey: calls.derived.get(keyID) as string }
    },
    internalizeAction: async (args: InternalizeActionArgs) => {
      Validation.validateInternalizeActionArgs(args)
      calls.internalized.push(args)
      if (options.internalizeFails === true) throw new Error('wallet refused')
      return { accepted: true as const }
    },
    ...options.walletExtra
  }
  // The wallet useWallet hands out; switchWallet replaces it, as a reconnect to another wallet would.
  let current: object = wallet
  const states: unknown[] = []
  let cursor = 0
  // useEffect: runs right after each render when its deps changed, cleaning up the previous run first.
  const effects: Array<{ deps: unknown[]; cleanup?: () => void } | undefined> = []
  const queued: Array<() => void> = []
  let effectCursor = 0
  const react = {
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const slot = effectCursor++
      const prev = effects[slot]
      if (prev !== undefined && deps.every((d, i) => Object.is(d, prev.deps[i]))) return
      queued.push(() => {
        prev?.cleanup?.()
        effects[slot] = { deps, cleanup: fn() ?? undefined }
      })
    },
    // A ref is one stable object per slot, so it survives re-renders like React's.
    useRef: (init: unknown) => {
      const slot = cursor++
      if (!(slot in states)) states[slot] = { current: init }
      return states[slot]
    },
    useState: (init: unknown) => {
      const slot = cursor++
      if (!(slot in states)) states[slot] = init
      return [
        states[slot],
        (next: unknown) => {
          states[slot] =
            typeof next === 'function' ? (next as (v: unknown) => unknown)(states[slot]) : next
        }
      ]
    }
  }
  const jsx = (type: unknown, props: Record<string, unknown>): El => ({ type, props })
  const utils = loadGenerated(TX_UTILS_SOURCE)
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-router-dom': { Link: 'Link' },
    './ConnectWallet.js': { ConnectWallet: 'ConnectWallet' },
    './WalletContext.js': { useWallet: () => ({ wallet: connected ? current : null, connected }) },
    './transactions.js': loadGenerated(TRANSACTIONS_SOURCE),
    './config.js': { BSV_NETWORK: options.config ?? 'test' },
    './txUtils.js': utils
  }
  const Demo = loadGenerated(demoSource, modules, { jsx: true }).TransactionsDemo as () => El
  // Test-only: the same demo source with its local example functions exported, so they can be called directly.
  const examples = loadGenerated(
    demoSource + '\nexport { publishNote, sendSats, sendToSelf }\n',
    modules,
    { jsx: true }
  ) as unknown as Examples
  const walk = (node: unknown, out: El[] = []): El[] => {
    if (Array.isArray(node)) node.forEach(n => walk(n, out))
    else if (node !== null && typeof node === 'object') {
      out.push(node as El)
      walk((node as El).props.children, out)
    }
    return out
  }
  const texts = (node: unknown): string => {
    if (Array.isArray(node)) return node.map(texts).join('')
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (node !== null && typeof node === 'object') return texts((node as El).props.children)
    return ''
  }
  const buttons = (tree: El): El[] => walk(tree).filter(e => e.type === 'button')
  return {
    calls,
    release: () => release(),
    switchWallet: (next: object): void => {
      current = next
    },
    /** The demo's example functions, bound to the stub wallet. */
    examples,
    wallet,
    texts,
    buttons,
    /** txid of the nth transaction the wallet built. */
    txid: (n = 0): string => calls.txs[n].id('hex'),
    /** The address sendToSelf derived (mainnet format) and its derivation. */
    own: (): { address: string; prefix: string; suffix: string } => {
      const keyID = calls.keyRequests.find(r => r.identityKey !== true)?.keyID as string
      const [prefix, suffix] = keyID.split(' ')
      return {
        address: PublicKey.fromString(calls.derived.get(keyID) as string).toAddress(),
        prefix,
        suffix
      }
    },
    render: (): El => {
      cursor = 0
      effectCursor = 0
      const tree = Demo()
      for (const run of queued.splice(0)) run()
      return tree
    },
    button: (tree: El, label: string): El => {
      const found = buttons(tree).find(b => texts(b) === label)
      if (found === undefined) throw new Error(`no button "${label}"`)
      return found
    },
    anchors: (tree: El): El[] => walk(tree).filter(e => e.type === 'a'),
    inputs: (tree: El): El[] => walk(tree).filter(e => e.type === 'input' || e.type === 'textarea'),
    /** The reader's output (a <pre> of the summary JSON), if shown. */
    reader: (tree: El): string | undefined => {
      const pre = walk(tree).find(e => e.type === 'pre')
      return pre === undefined ? undefined : texts(pre)
    }
  }
}

const walkTypes = (node: unknown, out: unknown[] = []): unknown[] => {
  if (Array.isArray(node)) node.forEach(n => walkTypes(n, out))
  else if (node !== null && typeof node === 'object') {
    out.push((node as El).type)
    walkTypes((node as El).props.children, out)
  }
  return out
}

const click = async (el: El): Promise<void> => {
  await (el.props.onClick as () => unknown)()
  await new Promise(resolve => setTimeout(resolve, 0))
}
const typeInto = (el: El, value: string): void => {
  ;(el.props.onChange as (e: unknown) => void)({ target: { value } })
}
const toTestnet = (address: string): string =>
  Utils.toBase58Check(Utils.fromBase58Check(address).data as number[], [0x6f])

type Mounted = ReturnType<typeof mountDemo>
const publishOnce = async (m: Mounted): Promise<El> => {
  typeInto(m.inputs(m.render())[0], 'hello')
  await click(m.button(m.render(), 'Publish'))
  return m.render()
}
const sendOnce = async (m: Mounted): Promise<El> => {
  const [, dest, amt] = m.inputs(m.render())
  typeInto(dest, DEST)
  typeInto(amt, '10')
  await click(m.button(m.render(), 'Send'))
  await click(m.button(m.render(), 'Confirm'))
  return m.render()
}
const sendToSelfOnce = async (m: Mounted): Promise<El> => {
  typeInto(m.inputs(m.render())[2], '10')
  await click(m.button(m.render(), 'Send to myself'))
  await click(m.button(m.render(), 'Confirm'))
  return m.render()
}

describe('TransactionsDemo', () => {
  test('not connected: no actions', () => {
    const m = mountDemo(false)
    const tree = m.render()
    expect(m.buttons(tree)).toHaveLength(0)
    expect(m.inputs(tree)).toHaveLength(0)
    expect(walkTypes(tree)).toContain('ConnectWallet')
  })

  test('publish stays disabled for a whitespace-only note', () => {
    const m = mountDemo(true)
    typeInto(m.inputs(m.render())[0], '   ')
    expect(m.button(m.render(), 'Publish').props.disabled).toBe(true)
  })

  test('publish and send show the error message, not an Error(...) string', async () => {
    const m = mountDemo(true, false, true)
    await publishOnce(m)
    expect(m.texts(m.render())).toContain('wallet said no')
    expect(m.texts(m.render())).not.toContain('Error:')
    await sendOnce(m)
    expect(m.calls.actions).toHaveLength(2)
    expect(m.texts(m.render()).match(/wallet said no/g)).toHaveLength(2)
  })

  test('busy: Publish is disabled while a publish is pending and a second click does nothing', async () => {
    const m = mountDemo(true, true)
    typeInto(m.inputs(m.render())[0], 'hello')
    const pending = (m.button(m.render(), 'Publish').props.onClick as () => unknown)()
    await new Promise(resolve => setTimeout(resolve, 0))
    const tree = m.render()
    expect(m.button(tree, 'Publish').props.disabled).toBe(true)
    expect(m.button(tree, 'Read').props.disabled).toBe(true) // empty raw text, unrelated to busy
    await (m.button(tree, 'Publish').props.onClick as () => unknown)()
    expect(m.calls.actions).toHaveLength(1)
    m.release()
    await pending
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(m.button(m.render(), 'Publish').props.disabled).toBe(false)
  })

  test('busy: Send and Confirm are disabled while a send is pending and a second confirm does nothing', async () => {
    const m = mountDemo(true, true)
    const [, dest, amt] = m.inputs(m.render())
    typeInto(dest, DEST)
    typeInto(amt, '10')
    await click(m.button(m.render(), 'Send'))
    const confirmClick = m.button(m.render(), 'Confirm').props.onClick as () => unknown
    void confirmClick()
    await new Promise(resolve => setTimeout(resolve, 0))
    const tree = m.render()
    expect(m.button(tree, 'Send').props.disabled).toBe(true)
    expect(m.button(tree, 'Publish').props.disabled).toBe(true)
    expect(m.buttons(tree).some(b => m.texts(b) === 'Confirm')).toBe(false)
    expect(m.calls.actions).toHaveLength(1)
    // The first render's Confirm handler is still around: calling it again must not send twice.
    await confirmClick()
    expect(m.calls.actions).toHaveLength(1)
    m.release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(m.calls.actions).toHaveLength(1)
  })

  test('publish is disabled when empty, then builds one 0-satoshi data output carrying the note', async () => {
    const m = mountDemo(true)
    let tree = m.render()
    expect(m.button(tree, 'Publish').props.disabled).toBe(true)
    typeInto(m.inputs(tree)[0], 'hello')
    tree = m.render()
    expect(m.button(tree, 'Publish').props.disabled).toBe(false)
    await click(m.button(tree, 'Publish'))
    // The stub ran the wallet's own validation, so both descriptions are valid (5..2000 bytes).
    expect(m.calls.actions).toHaveLength(1)
    expect(m.calls.actions[0].description).toBe('Publish data')
    expect(m.calls.actions[0].outputs).toEqual([
      expect.objectContaining({
        lockingScript: core.dataScript(['hello']).toHex(),
        satoshis: 0,
        outputDescription: 'Data output'
      })
    ])
    expect(m.texts(m.render())).toContain(m.txid())
  })

  test('publish finds the data output by script: the wallet reversed the outputs, so it sits at vout 1', async () => {
    const m = mountDemo(true)
    const tree = await publishOnce(m)
    expect(m.texts(tree)).not.toContain('expected exactly one')
    await click(m.button(tree, 'Try with the tx reader'))
    const summary = JSON.parse(m.reader(m.render()) as string) as {
      outputs: Array<{ vout: number; data?: string[] }>
    }
    expect(summary.outputs[1]).toMatchObject({ vout: 1, data: ['hello'] })
  })

  test('publishNote returns the vout it looked up: the wallet reversed the outputs, so it is 1, not 0', async () => {
    const m = mountDemo(true)
    const result = await m.examples.publishNote(m.wallet, 'hello')
    expect(result.vout).toBe(1)
    expect(result.txid).toBe(m.txid())
    expect(result.tx.outputs[result.vout].lockingScript.toHex()).toBe(
      core.dataScript(['hello']).toHex()
    )
  })

  test('sendSats rejects an empty destination without touching the wallet', async () => {
    const m = mountDemo(true)
    await expect(m.examples.sendSats(m.wallet, '', 1000)).rejects.toThrow('destination is required')
    expect(m.calls.actions).toHaveLength(0)
    expect(m.calls.keyRequests).toHaveLength(0)
  })

  test.each([0, -1, 1.5])(
    'sendSats and sendToSelf reject satoshis=%j without touching the wallet',
    async sats => {
      const m = mountDemo(true)
      await expect(m.examples.sendSats(m.wallet, DEST, sats)).rejects.toThrow(
        'satoshis must be a positive whole number'
      )
      await expect(m.examples.sendToSelf(m.wallet, sats)).rejects.toThrow(
        'satoshis must be a positive whole number'
      )
      expect(m.calls.actions).toHaveLength(0)
      expect(m.calls.keyRequests).toHaveLength(0)
      expect(m.calls.internalized).toHaveLength(0)
    }
  )

  test('publish fails loudly when the data output is missing from what the wallet returned', async () => {
    const m = mountDemo(true, false, false, { returns: 'without-outputs' })
    const tree = await publishOnce(m)
    expect(m.texts(tree)).toContain(
      'expected exactly one matching output in ' + m.txid() + ', found 0'
    )
    expect(m.anchors(tree)).toHaveLength(0)
  })

  test.each([
    ['no-txid', 'wallet returned no txid'],
    ['no-tx', 'wallet returned no transaction']
  ] as const)('publish with a wallet that returns %s shows "%s"', async (returns, message) => {
    const m = mountDemo(true, false, false, { returns })
    const tree = await publishOnce(m)
    expect(m.texts(tree)).toContain(message)
    expect(m.anchors(tree)).toHaveLength(0)
  })

  test.each([
    ['', '10'],
    ['addr', ''],
    ['addr', '0'],
    ['addr', '-5'],
    ['addr', '1.5']
  ])('send stays disabled for (%j, %j)', (to, amount) => {
    const m = mountDemo(true)
    const [, dest, amt] = m.inputs(m.render())
    typeInto(dest, to)
    typeInto(amt, amount)
    expect(m.button(m.render(), 'Send').props.disabled).toBe(true)
  })

  test('send to myself is disabled until the amount is valid and needs no destination', () => {
    const m = mountDemo(true)
    const [, , amt] = m.inputs(m.render())
    expect(m.button(m.render(), 'Send to myself').props.disabled).toBe(true)
    typeInto(amt, '1.5')
    expect(m.button(m.render(), 'Send to myself').props.disabled).toBe(true)
    typeInto(amt, '10')
    expect(m.button(m.render(), 'Send to myself').props.disabled).toBe(false)
    expect(m.button(m.render(), 'Send').props.disabled).toBe(true)
  })

  test('send to myself confirms first, without the address warning, then pays a derived address of the wallet', async () => {
    const m = mountDemo(true)
    typeInto(m.inputs(m.render())[2], '10')
    await click(m.button(m.render(), 'Send to myself'))
    expect(m.calls.actions).toHaveLength(0)
    const tree = m.render()
    const shown = m.texts(tree)
    expect(shown).toContain('Send 10 satoshis to yourself?')
    expect(shown).toContain(
      'Your wallet derives a fresh address and adds the payment back to your balance.'
    )
    expect(shown).not.toContain('not detected by BRC-100 wallets')
    await click(m.button(tree, 'Cancel'))
    expect(m.calls.actions).toHaveLength(0)
    expect(m.calls.keyRequests).toHaveLength(0)
    await click(m.button(m.render(), 'Send to myself'))
    await click(m.button(m.render(), 'Confirm'))
    const derivation = m.calls.keyRequests.find(r => r.identityKey !== true) as KeyRequest
    expect(derivation.protocolID).toEqual([2, '3241645161d8'])
    expect(derivation.counterparty).toBe('self')
    expect(m.calls.actions).toHaveLength(1)
    expect(m.calls.actions[0].outputs).toEqual([
      expect.objectContaining({
        lockingScript: new P2PKH().lock(m.own().address).toHex(),
        satoshis: 10
      })
    ])
    expect(m.calls.actions[0].description).toBe('Send to self')
  })

  test('send to myself broadcasts now and internalizes the exact bytes at the vout found by script', async () => {
    const m = mountDemo(true)
    await sendToSelfOnce(m)
    const { prefix, suffix } = m.own()
    expect(m.calls.actions[0].options.acceptDelayedBroadcast).toBe(false)
    expect(m.calls.actions[0].options.randomizeOutputs).toBe(false)
    expect(m.calls.internalized).toHaveLength(1)
    // The exact bytes the wallet returned go back to it.
    expect(m.calls.internalized[0].tx).toEqual(m.calls.returned[0].tx)
    // The stub reversed the outputs, so the payment is at index 1, not 0.
    expect(m.calls.internalized[0].outputs).toEqual([
      {
        outputIndex: 1,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: prefix,
          derivationSuffix: suffix,
          senderIdentityKey: m.calls.identity
        }
      }
    ])
    // The live-tested description, passed explicitly (the core default is 'Receive payment').
    expect(m.calls.internalized[0].description).toBe('Receive own payment')
  })

  test('editing the amount cancels a pending send-to-myself confirm', async () => {
    const m = mountDemo(true)
    const amt = m.inputs(m.render())[2]
    typeInto(amt, '10')
    await click(m.button(m.render(), 'Send to myself'))
    typeInto(amt, '11')
    expect(m.texts(m.render())).not.toContain('to yourself?')
    expect(m.calls.actions).toHaveLength(0)
  })

  test('send to myself, internalized: txid link, reader button and the added-back line', async () => {
    const m = mountDemo(true, false, false, { config: 'test' })
    const tree = await sendToSelfOnce(m)
    expect(m.anchors(tree)[0].props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
    expect(m.buttons(tree).some(b => m.texts(b) === 'Try with the tx reader')).toBe(true)
    expect(m.texts(tree)).toContain('Added back to your wallet balance.')
    expect(m.texts(tree)).not.toContain('did not take the payment back')
  })

  test('send to myself, not internalized: warning with address, prefix, suffix and outpoint', async () => {
    const m = mountDemo(true, false, false, { internalizeFails: true })
    const shown = m.texts(await sendToSelfOnce(m))
    const { address, prefix, suffix } = m.own()
    expect(shown).toContain(m.txid())
    expect(shown).toContain(
      'Your wallet did not take the payment back: wallet refused. The sats are at ' +
        toTestnet(address) +
        '; derivation prefix/suffix: ' +
        prefix +
        ' / ' +
        suffix +
        ' (BRC-29, counterparty self). Look for output ' +
        m.txid() +
        '.1.'
    )
    expect(shown).not.toContain('Added back to your wallet balance.')
    expect(m.calls.internalized).toHaveLength(1)
  })

  test('recovery address is shown in the network of the app', async () => {
    const run = async (config: 'main' | 'test'): Promise<{ shown: string; address: string }> => {
      const m = mountDemo(true, false, false, { config, internalizeFails: true })
      const shown = m.texts(await sendToSelfOnce(m))
      return { shown, address: m.own().address }
    }
    const onTest = await run('test')
    expect(onTest.shown).toContain('The sats are at ' + toTestnet(onTest.address) + ';')
    expect(onTest.shown).not.toContain(onTest.address)
    const onMain = await run('main')
    expect(onMain.shown).toContain('The sats are at ' + onMain.address + ';')
  })

  test('send to myself with unparseable bytes back: recovery without outpoint, no internalize, no throw', async () => {
    const m = mountDemo(true, false, false, { returns: 'garbage' })
    const tree = await sendToSelfOnce(m)
    const shown = m.texts(tree)
    expect(shown).toContain('b'.repeat(64))
    expect(shown).toContain(
      'Your wallet did not take the payment back: Could not parse a transaction'
    )
    expect(shown).toContain('The sats are at ' + toTestnet(m.own().address) + ';')
    expect(shown).not.toContain('Look for output')
    expect(m.buttons(tree).some(b => m.texts(b) === 'Try with the tx reader')).toBe(false)
    expect(m.calls.internalized).toHaveLength(0)
  })

  test('send to myself when the payment output is missing: recovery without outpoint, no internalize', async () => {
    const m = mountDemo(true, false, false, { returns: 'without-outputs' })
    const shown = m.texts(await sendToSelfOnce(m))
    expect(shown).toContain(
      'Your wallet did not take the payment back: expected exactly one matching output in ' +
        m.txid() +
        ', found 0.'
    )
    expect(shown).not.toContain('Look for output')
    expect(m.calls.internalized).toHaveLength(0)
  })

  test('send to myself when the wallet returns no transaction: recovery without outpoint', async () => {
    const m = mountDemo(true, false, false, { returns: 'no-tx' })
    const shown = m.texts(await sendToSelfOnce(m))
    expect(shown).toContain(m.txid())
    expect(shown).toContain(
      'Your wallet did not take the payment back: wallet returned no transaction to internalize.'
    )
    expect(shown).not.toContain('Look for output')
    expect(m.calls.internalized).toHaveLength(0)
  })

  test('busy: Send to myself is disabled while a send is pending', async () => {
    const m = mountDemo(true, true)
    typeInto(m.inputs(m.render())[2], '10')
    await click(m.button(m.render(), 'Send to myself'))
    void (m.button(m.render(), 'Confirm').props.onClick as () => unknown)()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(m.button(m.render(), 'Send to myself').props.disabled).toBe(true)
    m.release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(m.calls.actions).toHaveLength(1)
  })

  test('send confirms first; cancel sends nothing; confirm pays the address with P2PKH, unrandomised', async () => {
    const m = mountDemo(true)
    const [, dest, amt] = m.inputs(m.render())
    typeInto(dest, DEST)
    typeInto(amt, '10')
    let tree = m.render()
    expect(m.button(tree, 'Send').props.disabled).toBe(false)
    await click(m.button(tree, 'Send'))
    expect(m.calls.actions).toHaveLength(0)
    tree = m.render()
    expect(m.texts(tree)).toContain('Send 10 satoshis to ' + DEST + '?')
    expect(m.texts(tree)).toContain(
      'Plain payments to an address or identity key are not detected by BRC-100 wallets unless the recipient internalizes them.'
    )
    await click(m.button(tree, 'Cancel'))
    expect(m.calls.actions).toHaveLength(0)
    expect(m.texts(m.render())).not.toContain('Send 10 satoshis to ' + DEST + '?')
    await click(m.button(m.render(), 'Send'))
    await click(m.button(m.render(), 'Confirm'))
    expect(m.calls.actions).toHaveLength(1)
    expect(m.calls.actions[0].outputs).toEqual([
      expect.objectContaining({ lockingScript: new P2PKH().lock(DEST).toHex(), satoshis: 10 })
    ])
    expect(m.calls.actions[0].options.randomizeOutputs).toBe(false)
    expect(m.calls.actions[0].description).toBe('Send satoshis')
    expect(m.calls.internalized).toHaveLength(0)
    expect(m.texts(m.render())).toContain(m.txid())
  })

  test('send to a 66-hex public key pays its P2PKH', async () => {
    const pub = PrivateKey.fromRandom().toPublicKey()
    const m = mountDemo(true)
    const [, dest, amt] = m.inputs(m.render())
    typeInto(dest, '  ' + pub.toString() + ' ')
    typeInto(amt, '500')
    await click(m.button(m.render(), 'Send'))
    expect(m.texts(m.render())).toContain('Send 500 satoshis to ' + pub.toString() + '?')
    await click(m.button(m.render(), 'Confirm'))
    expect(m.calls.actions[0].outputs).toEqual([
      expect.objectContaining({
        lockingScript: new P2PKH().lock(pub.toAddress()).toHex(),
        satoshis: 500
      })
    ])
  })

  test('send with a wallet that returns no txid shows the error', async () => {
    const m = mountDemo(true, false, false, { returns: 'no-txid' })
    const tree = await sendOnce(m)
    expect(m.texts(tree)).toContain('wallet returned no txid')
    expect(m.anchors(tree)).toHaveLength(0)
  })

  test('publish result is only the txid, linked to the test explorer in a new tab', async () => {
    const m = mountDemo(true, false, false, { config: 'test' })
    const tree = await publishOnce(m)
    const [link] = m.anchors(tree)
    expect(link.props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
    expect(link.props.target).toBe('_blank')
    expect(String(link.props.rel)).toContain('noopener')
    expect(m.texts(link)).toBe(m.txid())
    expect(m.texts(tree)).not.toContain('scriptType')
    expect(m.texts(tree)).not.toContain('outputs')
  })

  test('send result is only the txid link', async () => {
    const m = mountDemo(true, false, false, { config: 'main' })
    const tree = await sendOnce(m)
    const [link] = m.anchors(tree)
    expect(link.props.href).toBe('https://whatsonchain.com/tx/' + m.txid())
    expect(m.texts(tree)).not.toContain('scriptType')
  })

  test('the wallet network wins over the config network', async () => {
    const getNetwork = async () => ({ network: 'mainnet' })
    const m = mountDemo(true, false, false, { config: 'test', walletExtra: { getNetwork } })
    const [link] = m.anchors(await publishOnce(m))
    expect(link.props.href).toBe('https://whatsonchain.com/tx/' + m.txid())
  })

  test('a testnet wallet gives the test explorer even when config says main', async () => {
    const getNetwork = async () => ({ network: 'testnet' })
    const m = mountDemo(true, false, false, { config: 'main', walletExtra: { getNetwork } })
    const [link] = m.anchors(await publishOnce(m))
    expect(link.props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
  })

  test('a throwing getNetwork falls back to the config network', async () => {
    const getNetwork = async () => {
      throw new Error('not supported over relay')
    }
    const m = mountDemo(true, false, false, { config: 'test', walletExtra: { getNetwork } })
    const tree = await publishOnce(m)
    expect(m.anchors(tree)[0].props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
    expect(m.texts(tree)).not.toContain('not supported over relay')
  })

  test('a getNetwork that never resolves blocks nothing: txid links to the config network and Publish re-enables', async () => {
    const getNetwork = () => new Promise<never>(() => {})
    const m = mountDemo(true, false, false, { config: 'test', walletExtra: { getNetwork } })
    typeInto(m.inputs(m.render())[0], 'hello')
    // Not awaited: if publish ever waits on getNetwork this would hang, so the test flushes a fixed time and asserts instead.
    void (m.button(m.render(), 'Publish').props.onClick as () => unknown)()
    await new Promise(resolve => setTimeout(resolve, 20))
    const tree = m.render()
    expect(m.anchors(tree)[0].props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
    expect(m.button(tree, 'Publish').props.disabled).toBe(false)
  })

  test("switching wallets drops the previous wallet's network until the new wallet answers", async () => {
    let answerA: (v: { network: string }) => void = () => {}
    let answerB: (v: { network: string }) => void = () => {}
    const getNetwork = () =>
      new Promise<{ network: string }>(resolve => {
        answerA = resolve
      })
    const m = mountDemo(true, false, false, { config: 'test', walletExtra: { getNetwork } })
    const tree = await publishOnce(m)
    expect(m.anchors(tree)[0].props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
    answerA({ network: 'mainnet' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(m.anchors(m.render())[0].props.href).toBe('https://whatsonchain.com/tx/' + m.txid())
    m.switchWallet({
      name: 'other-wallet',
      getNetwork: () =>
        new Promise<{ network: string }>(resolve => {
          answerB = resolve
        })
    })
    // The first render with the new wallet already ignores the old wallet's answer.
    expect(m.anchors(m.render())[0].props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
    answerB({ network: 'mainnet' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(m.anchors(m.render())[0].props.href).toBe('https://whatsonchain.com/tx/' + m.txid())
  })

  test("a late answer from a wallet that was switched away does not overwrite the new wallet's answer", async () => {
    let answerA: (v: { network: string }) => void = () => {}
    const getNetwork = () =>
      new Promise<{ network: string }>(resolve => {
        answerA = resolve
      })
    const m = mountDemo(true, false, false, { config: 'main', walletExtra: { getNetwork } })
    await publishOnce(m)
    m.switchWallet({ name: 'other-wallet', getNetwork: async () => ({ network: 'testnet' }) })
    m.render()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(m.anchors(m.render())[0].props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
    // The first wallet answers only now; the link stays on the current wallet's network.
    answerA({ network: 'mainnet' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(m.anchors(m.render())[0].props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
  })

  test('a getNetwork that resolves later to mainnet updates the link', async () => {
    let answer: (v: { network: string }) => void = () => {}
    const getNetwork = () =>
      new Promise<{ network: string }>(resolve => {
        answer = resolve
      })
    const m = mountDemo(true, false, false, { config: 'test', walletExtra: { getNetwork } })
    const tree = await publishOnce(m)
    expect(m.anchors(tree)[0].props.href).toBe('https://test.whatsonchain.com/tx/' + m.txid())
    answer({ network: 'mainnet' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(m.anchors(m.render())[0].props.href).toBe('https://whatsonchain.com/tx/' + m.txid())
  })

  test('ttn config stays ttn even when the wallet says testnet', async () => {
    const getNetwork = async () => ({ network: 'testnet' })
    const m = mountDemo(true, false, false, { config: 'ttn', walletExtra: { getNetwork } })
    const tree = await publishOnce(m)
    expect(m.anchors(tree)).toHaveLength(0)
    expect(m.texts(tree)).toContain(m.txid())
  })

  test('ttn has no explorer: the txid is plain text, not a link', async () => {
    const m = mountDemo(true, false, false, { config: 'ttn' })
    const tree = await publishOnce(m)
    expect(m.anchors(tree)).toHaveLength(0)
    expect(m.texts(tree)).toContain(m.txid())
  })

  test('"Try with the tx reader" on a publish result fills the reader and shows the summary', async () => {
    const m = mountDemo(true)
    // a previous reader error is cleared
    const area = m.inputs(m.render()).find(i => i.type === 'textarea') as El
    typeInto(area, 'garbage')
    await click(m.button(m.render(), 'Read'))
    expect(m.texts(m.render())).toContain('Could not parse a transaction')
    const tree = await publishOnce(m)
    expect(m.button(tree, 'Try with the tx reader').props.className).toBe('bsv-btn-ghost')
    await click(m.button(tree, 'Try with the tx reader'))
    const after = m.render()
    expect(m.inputs(after).find(i => i.type === 'textarea')?.props.value).toBe(
      m.calls.txs[0].toHex()
    )
    expect(m.texts(after)).not.toContain('Could not parse a transaction')
    expect(m.texts(after)).toContain('scriptType')
    expect(m.calls.actions).toHaveLength(1)
  })

  test('"Try with the tx reader" on a send result fills the reader', async () => {
    const m = mountDemo(true)
    const tree = await sendOnce(m)
    await click(m.button(tree, 'Try with the tx reader'))
    expect(m.inputs(m.render()).find(i => i.type === 'textarea')?.props.value).toBe(
      m.calls.txs[0].toHex()
    )
  })

  test('no "Try with the tx reader" when the send result has no tx', async () => {
    const m = mountDemo(true, false, false, { returns: 'no-tx' })
    const tree = await sendOnce(m)
    expect(m.texts(tree)).toContain(m.txid())
    expect(m.buttons(tree).some(b => m.texts(b) === 'Try with the tx reader')).toBe(false)
  })

  test('read shows the parse error for garbage and a summary for a valid tx; no wallet call', async () => {
    const m = mountDemo(true)
    const area = m.inputs(m.render()).find(i => i.type === 'textarea') as El
    typeInto(area, 'not a transaction')
    await click(m.button(m.render(), 'Read'))
    expect(m.texts(m.render())).toContain('Could not parse a transaction')
    const tx = makeTx()
    typeInto(area, tx.toHex())
    await click(m.button(m.render(), 'Read'))
    const shown = m.texts(m.render())
    expect(shown).toContain(tx.id('hex'))
    expect(shown).not.toContain('Could not parse a transaction')
    expect(m.calls.actions).toHaveLength(0)
    expect(m.calls.keyRequests).toHaveLength(0)
  })

  test('the network effect never sets state synchronously (react-hooks/set-state-in-effect)', () => {
    const effect = /useEffect\(\(\) => \{([\s\S]*?)\}, \[wallet\]\)/.exec(demoSource)?.[1]
    expect(effect).toBeDefined()
    expect(effect).not.toMatch(/^\s*set[A-Z]\w*\(/m)
    expect(effect).toContain('.then(')
  })

  test('the example flows stay local to the demo and are built from the core blocks', () => {
    expect(demoSource).toContain("from './transactions.js'")
    expect(demoSource).not.toMatch(/export (async )?function (publishNote|sendSats|sendToSelf)/)
    expect(demoSource).not.toContain('completeBoundAction')
    expect(demoSource).not.toContain('outputs[0]')
    expect(demoSource).not.toMatch(/: any\b|<any>|as any\b/)
  })
})

describe('tx-core AGENTS section', () => {
  const section = txCore.agentsSection({
    name: 'demo',
    network: 'test',
    bsvDir: 'src/bsv',
    stack: {},
    layout: 'frontend-only'
  })
  test.each([
    'TransactionBuilder',
    'dataScript',
    'deriveOwnAddress',
    'internalizePayment',
    'internalizeAction',
    'acceptDelayedBroadcast: false',
    'TransactionsDemo.tsx',
    'publishNote',
    'sendSats(',
    'sendToSelf',
    'not detected by BRC-100 wallets',
    'parseTransaction',
    'summarizeTransaction',
    'explorerTxUrl',
    'Try with the tx reader',
    'addCustomInput',
    '## tx-core'
  ])('mentions %s', term => {
    expect(section).toContain(term)
  })
  test('does not present the removed helpers as core exports', () => {
    expect(section).not.toContain('sendSatoshis')
    expect(section).not.toContain('publishData')
  })
  test('states the phone-abort limit and avoids completeBoundAction', () => {
    expect(section).toContain('cannot abort a failed custom spend')
    expect(section).not.toContain('completeBoundAction')
    expect(section).toContain('wallet-relay ' + WALLET_RELAY_RANGE)
  })
})

describe('tx-core AGENTS section without a client', () => {
  const section = txCore.agentsSection({
    name: 'demo',
    network: 'test',
    bsvDir: 'src/bsv',
    stack: { backend: { framework: 'express' } },
    layout: 'backend-only'
  })
  test('omits the demo page, which backend-only does not write', () => {
    for (const term of ['TransactionsDemo', '/transactions', 'publishNote', 'demo page'])
      expect(section).not.toContain(term)
  })
  test('keeps the core and helper docs', () => {
    for (const term of ['transactions.ts', 'txUtils.ts', 'deriveOwnAddress', 'parseTransaction'])
      expect(section).toContain(term)
    expect(section).not.toMatch(/\n{3,}/)
  })
})
