import { Overlay, createOverlayMethods } from '../overlay'
import { TopicBroadcaster, type Transaction } from '@bsv/sdk'

describe('Overlay', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('accepts the TerraTestNet overlay preset', async () => {
    const overlay = await Overlay.create({
      topics: ['tm_example'],
      network: 'teratestnet'
    })

    expect(overlay.getInfo()).toEqual({
      topics: ['tm_example'],
      network: 'teratestnet'
    })
  })

  it('preserves acknowledgement policy for per-call topic overrides', async () => {
    const allHosts = ['tm_required_all']
    const anyHost = ['tm_required_any']
    const overlay = await Overlay.create({
      topics: ['tm_default', 'tm_required_all', 'tm_required_any'],
      requireAckFromAllHosts: allHosts,
      requireAckFromAnyHost: anyHost
    })
    allHosts[0] = 'tm_mutated_all'
    anyHost[0] = 'tm_mutated_any'

    const observed: Array<{ topics: unknown }> = []
    const broadcast = jest
      .spyOn(TopicBroadcaster.prototype, 'broadcast')
      .mockImplementation(async function (this: TopicBroadcaster) {
        observed.push({
          topics: (this as any).topics
        })
        return { status: 'error', code: 'TEST', description: 'test' }
      })

    await expect(overlay.broadcast({} as Transaction, ['tm_override'])).rejects.toThrow(
      'may only reference topics included in this broadcast'
    )
    await overlay.broadcast({} as Transaction, [
      'tm_override',
      'tm_required_all',
      'tm_required_any'
    ])

    expect(observed).toEqual([
      {
        topics: ['tm_override', 'tm_required_all', 'tm_required_any']
      }
    ])
    broadcast.mockRestore()
  })

  it('owns its topic configuration and rejects malformed or excessive topics', async () => {
    const topics = ['tm_original']
    const overlay = await Overlay.create({ topics })
    topics[0] = 'tm_mutated'

    expect(overlay.getInfo().topics).toEqual(['tm_original'])
    await expect(
      Overlay.create({ topics: Array.from({ length: 65 }, (_, i) => `tm_${i}`) })
    ).rejects.toThrow('too many')
    await expect(Overlay.create({ topics: ['tm_bad topic'] })).rejects.toThrow(
      'bounded "tm_" identifier'
    )
  })

  it('ignores inherited redirect, network, tracker, and acknowledgement policy', async () => {
    const redirectGetter = jest.fn(() => ({ ls_identity: ['https://ambient.invalid'] }))
    Object.defineProperties(Object.prototype, {
      network: { value: 'testnet', configurable: true, writable: true },
      hostOverrides: {
        get: redirectGetter,
        set(value) {
          Object.defineProperty(this, 'hostOverrides', {
            value,
            configurable: true,
            writable: true
          })
        },
        configurable: true
      },
      additionalHosts: {
        value: { ls_identity: ['https://ambient.invalid'] },
        configurable: true,
        writable: true
      },
      slapTrackers: {
        value: ['https://ambient.invalid'],
        configurable: true,
        writable: true
      },
      requireAckFromAllHosts: { value: 'all', configurable: true, writable: true },
      requireAckFromAnyHost: { value: 'any', configurable: true, writable: true }
    })
    try {
      const overlay = await Overlay.create({ topics: ['tm_original'] })
      expect(overlay.getInfo()).toEqual({ topics: ['tm_original'], network: 'mainnet' })
      expect(redirectGetter).not.toHaveBeenCalled()
    } finally {
      for (const property of [
        'network',
        'hostOverrides',
        'additionalHosts',
        'slapTrackers',
        'requireAckFromAllHosts',
        'requireAckFromAnyHost'
      ]) {
        Reflect.deleteProperty(Object.prototype, property)
      }
    }
  })

  it('does not leave a stale broadcaster active after removing the final topic', async () => {
    const overlay = await Overlay.create({ topics: ['tm_only'] })

    expect(() => overlay.removeTopic('tm_only')).toThrow('retain at least one topic')
    expect(overlay.getInfo().topics).toEqual(['tm_only'])
  })

  it.each([
    ['a null configuration', null],
    ['an invalid network', { topics: ['tm_valid'], network: 'regtest' }],
    ['a non-array topic list', { topics: 'tm_valid' }],
    ['an empty topic list', { topics: [] }],
    ['duplicate topics', { topics: ['tm_same', 'tm_same'] }],
    ['an overlong topic', { topics: [`tm_${'a'.repeat(125)}`] }],
    ['too many topics', { topics: Array.from({ length: 65 }, (_, i) => `tm_${i}`) }]
  ])('rejects %s', async (_name, config) => {
    await expect(Overlay.create(config as any)).rejects.toThrow()
  })

  it('rejects sparse and exotic topic arrays without reading inherited values', async () => {
    const sparse = Array(1)
    await expect(Overlay.create({ topics: sparse as string[] })).rejects.toThrow('dense array')

    class TopicArray extends Array<string> {}
    await expect(Overlay.create({ topics: new TopicArray('tm_valid') })).rejects.toThrow(
      'standard array'
    )
  })

  it('accepts bounded acknowledgement selectors and all supported network presets', async () => {
    for (const network of ['mainnet', 'testnet', 'teratestnet', 'local'] as const) {
      const overlay = await Overlay.create({
        topics: ['tm_primary', 'tm_required'],
        network,
        requireAckFromAllHosts: 'all',
        requireAckFromAnyHost: [],
        slapTrackers: ['https://tracker.example'],
        hostOverrides: { ls_identity: ['https://lookup.example'] },
        additionalHosts: Object.assign(Object.create(null), {
          ls_messages: ['https://messages.example']
        })
      })
      expect(overlay.getInfo().network).toBe(network)
    }
  })

  it.each([
    ['non-array acknowledgement selector', { requireAckFromAllHosts: 'some' }],
    ['duplicate acknowledgement topic', { requireAckFromAnyHost: ['tm_x', 'tm_x'] }],
    ['too many trackers', { slapTrackers: Array(33).fill('https://tracker.example') }],
    [
      'duplicate trackers',
      { slapTrackers: ['https://tracker.example', 'https://tracker.example'] }
    ],
    ['empty tracker', { slapTrackers: [''] }],
    ['overlong tracker', { slapTrackers: ['x'.repeat(2049)] }],
    ['non-record host map', { hostOverrides: [] }],
    ['invalid service identifier', { hostOverrides: { identity: ['https://lookup.example'] } }],
    ['duplicate service hosts', { hostOverrides: { ls_identity: ['https://x', 'https://x'] } }],
    ['too many service hosts', { hostOverrides: { ls_identity: Array(33).fill('https://x') } }],
    [
      'too many mapped services',
      {
        hostOverrides: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`ls_${index}`, ['https://x']])
        )
      }
    ]
  ])('rejects a configuration with %s', async (_name, patch) => {
    await expect(Overlay.create({ topics: ['tm_valid'], ...patch } as any)).rejects.toThrow()
  })

  it('rejects host-map accessors without invoking them', async () => {
    const getter = jest.fn(() => ['https://lookup.example'])
    const hostOverrides = Object.create(null)
    Object.defineProperty(hostOverrides, 'ls_identity', { enumerable: true, get: getter })

    await expect(Overlay.create({ topics: ['tm_valid'], hostOverrides })).rejects.toThrow(
      'data properties only'
    )
    expect(getter).not.toHaveBeenCalled()
  })

  it('validates dynamic topic changes before replacing the broadcaster', async () => {
    const overlay = await Overlay.create({
      topics: ['tm_one', 'tm_two'],
      requireAckFromAllHosts: 'all',
      requireAckFromAnyHost: 'any'
    })
    const original = overlay.getBroadcaster()

    expect(() => overlay.addTopic('bad topic')).toThrow('bounded "tm_" identifier')
    overlay.addTopic('tm_one')
    expect(overlay.getBroadcaster()).toBe(original)

    overlay.addTopic('tm_three')
    const expanded = overlay.getBroadcaster()
    expect(expanded).not.toBe(original)
    expect(overlay.getInfo().topics).toEqual(['tm_one', 'tm_two', 'tm_three'])

    overlay.removeTopic('not-present')
    expect(overlay.getBroadcaster()).toBe(expanded)

    overlay.removeTopic('tm_two')
    expect(overlay.getInfo().topics).toEqual(['tm_one', 'tm_three'])
    expect(overlay.getBroadcaster()).not.toBe(expanded)
  })

  it('rejects inherited action outputs and inherited createAction transaction evidence', async () => {
    const output = {
      lockingScript: '51',
      satoshis: 1,
      outputDescription: 'Overlay test output'
    }
    const createAction = jest.fn().mockResolvedValue({})
    const methods = createOverlayMethods({ getClient: () => ({ createAction }) } as never)
    const broadcast = jest.fn()
    Object.defineProperties(Object.prototype, {
      outputs: { value: [output], configurable: true },
      txid: { value: '11'.repeat(32), configurable: true },
      tx: { value: [0], configurable: true }
    })
    try {
      await expect(methods.broadcastAction({ broadcast } as never, {} as never)).rejects.toThrow(
        'Overlay action outputs'
      )
      await expect(
        methods.broadcastAction({ broadcast } as never, { outputs: [output] })
      ).rejects.toThrow()
      expect(broadcast).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'outputs')
      Reflect.deleteProperty(Object.prototype, 'txid')
      Reflect.deleteProperty(Object.prototype, 'tx')
    }
  })
})
