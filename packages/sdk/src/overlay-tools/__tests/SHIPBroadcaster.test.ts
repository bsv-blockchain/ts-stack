import SHIPCast, { HTTPSOverlayBroadcastFacilitator } from '../../overlay-tools/SHIPBroadcaster'
import LookupResolver from '../../overlay-tools/LookupResolver'
import { PrivateKey, Utils } from '../../primitives/index'
import { Transaction } from '../../transaction/index'
import OverlayAdminTokenTemplate from '../../overlay-tools/OverlayAdminTokenTemplate'
import { CompletedProtoWallet } from '../../auth/certificates/__tests/CompletedProtoWallet'
import PushDrop from '../../script/templates/PushDrop'

const mockFacilitator = {
  send: jest.fn()
}

const mockResolver = {
  query: jest.fn()
}

describe('SHIPCast', () => {
  let consoleErrorSpy: jest.SpyInstance

  beforeEach(() => {
    mockFacilitator.send.mockReset()
    mockResolver.query.mockReset()
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
    jest.useRealTimers()
  })

  it('uses the configured HTTP client and canonical comma-separated X-Topics header', async () => {
    const httpClient = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tm_foo: { outputsToAdmit: [], coinsToRetain: [] } })
    })
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await facilitator.send('https://overlay.example', {
      beef: [1, 2, 3],
      topics: ['tm_foo', 'tm_bar']
    })

    expect(httpClient).toHaveBeenCalledWith(
      'https://overlay.example/submit',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Topics': 'tm_foo,tm_bar'
        },
        body: new Uint8Array([1, 2, 3])
      })
    )
  })

  it('rejects insecure facilitator URLs unless HTTP is explicitly enabled', async () => {
    const httpClient = jest.fn()
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await expect(
      facilitator.send('http://overlay.example', {
        beef: [1, 2, 3],
        topics: ['tm_foo']
      })
    ).rejects.toThrow('HTTPS facilitator can only use URLs that start with "https:"')
    expect(httpClient).not.toHaveBeenCalled()
  })

  it.each([
    ['not a URL', 'valid absolute URL'],
    ['ftp://overlay.example', 'HTTPS facilitator'],
    ['https://user:secret@overlay.example', 'HTTPS facilitator'],
    ['https://overlay.example/path', 'HTTPS facilitator'],
    ['https://overlay.example?target=other', 'HTTPS facilitator'],
    ['https://overlay.example#fragment', 'HTTPS facilitator']
  ])('rejects unsafe facilitator target %s before transport', async (url, message) => {
    const httpClient = jest.fn()
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await expect(facilitator.send(url, { beef: [1], topics: ['tm_foo'] })).rejects.toThrow(message)
    expect(httpClient).not.toHaveBeenCalled()
  })

  it('allows explicit local HTTP while retaining the canonical submit endpoint', async () => {
    const httpClient = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ tm_foo: { outputsToAdmit: [0], coinsToRetain: [] } }), {
        status: 200
      })
    )
    const facilitator = new HTTPSOverlayBroadcastFacilitator(
      httpClient as unknown as typeof fetch,
      true
    )

    await expect(
      facilitator.send('http://localhost:8080', { beef: [1], topics: ['tm_foo'] })
    ).resolves.toEqual({ tm_foo: { outputsToAdmit: [0], coinsToRetain: [] } })
    expect(httpClient).toHaveBeenCalledWith(
      'http://localhost:8080/submit',
      expect.objectContaining({ redirect: 'error' })
    )
  })

  it.each([
    ['a typed array', new Uint8Array([1])],
    ['an empty array', []],
    [
      'a sparse array',
      (() => {
        const value: number[] = []
        value.length = 1
        return value
      })()
    ],
    ['a fractional byte', [1.5]],
    ['a negative byte', [-1]],
    ['an oversized byte', [256]]
  ])('rejects %s as BEEF before transport', async (_name, beef) => {
    const httpClient = jest.fn()
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await expect(
      facilitator.send('https://overlay.example', {
        beef: beef as number[],
        topics: ['tm_foo']
      })
    ).rejects.toThrow('BEEF must be a non-empty byte array')
    expect(httpClient).not.toHaveBeenCalled()
  })

  it('does not invoke accessors while validating BEEF bytes', async () => {
    const getter = jest.fn(() => 1)
    const beef: number[] = []
    Object.defineProperty(beef, 0, { configurable: true, enumerable: true, get: getter })
    beef.length = 1
    const httpClient = jest.fn()
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await expect(
      facilitator.send('https://overlay.example', { beef, topics: ['tm_foo'] })
    ).rejects.toThrow('BEEF must be a non-empty byte array')
    expect(getter).not.toHaveBeenCalled()
    expect(httpClient).not.toHaveBeenCalled()
  })

  it.each([
    new Uint8Array([1]),
    [256],
    (() => {
      const value: number[] = []
      value.length = 1
      return value
    })()
  ])('rejects malformed off-chain values before transport', async offChainValues => {
    const httpClient = jest.fn()
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await expect(
      facilitator.send('https://overlay.example', {
        beef: [1],
        topics: ['tm_foo'],
        offChainValues: offChainValues as number[]
      })
    ).rejects.toThrow('off-chain values must be a byte array')
    expect(httpClient).not.toHaveBeenCalled()
  })

  it('encodes bounded off-chain values and parses a chunked UTF-8 response', async () => {
    const json = JSON.stringify({
      tm_foo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [1] }
    })
    const bytes = new TextEncoder().encode(json)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 7))
        controller.enqueue(bytes.subarray(7))
        controller.close()
      }
    })
    const httpClient = jest.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Length': String(bytes.byteLength) }
      })
    )
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await expect(
      facilitator.send('https://overlay.example', {
        beef: [1, 2],
        topics: ['tm_foo'],
        offChainValues: [3, 4]
      })
    ).resolves.toEqual({
      tm_foo: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [1] }
    })
    expect(httpClient).toHaveBeenCalledWith(
      'https://overlay.example/submit',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Topics': 'tm_foo',
          'x-includes-off-chain-values': 'true'
        },
        body: new Uint8Array([2, 1, 2, 3, 4])
      })
    )
  })

  it.each(['01', '-1', String(1024 * 1024 + 1)])(
    'rejects unsafe declared response length %s before reading',
    async contentLength => {
      const httpClient = jest.fn().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'Content-Length': contentLength }
        })
      )
      const facilitator = new HTTPSOverlayBroadcastFacilitator(
        httpClient as unknown as typeof fetch
      )

      await expect(
        facilitator.send('https://overlay.example', { beef: [1], topics: ['tm_foo'] })
      ).rejects.toThrow('maximum permitted size')
    }
  )

  it('cancels an oversized streamed response', async () => {
    const cancel = jest.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1))
      },
      cancel
    })
    const httpClient = jest.fn().mockResolvedValue(new Response(body, { status: 200 }))
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await expect(
      facilitator.send('https://overlay.example', { beef: [1], topics: ['tm_foo'] })
    ).rejects.toThrow('maximum permitted size')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28]), 'not valid UTF-8'],
    ['malformed JSON', new TextEncoder().encode('{'), 'not valid JSON']
  ])('rejects %s response bytes', async (_name, bytes, message) => {
    const httpClient = jest.fn().mockResolvedValue(new Response(bytes, { status: 200 }))
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await expect(
      facilitator.send('https://overlay.example', { beef: [1], topics: ['tm_foo'] })
    ).rejects.toThrow(message)
  })

  it('rejects failed HTTP responses', async () => {
    const httpClient = jest.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)

    await expect(
      facilitator.send('https://overlay.example', { beef: [1], topics: ['tm_foo'] })
    ).rejects.toThrow('Failed to facilitate broadcast')
  })

  it('aborts a facilitator request at its fixed deadline', async () => {
    jest.useFakeTimers()
    const httpClient = jest.fn(
      async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
    )
    const facilitator = new HTTPSOverlayBroadcastFacilitator(httpClient as unknown as typeof fetch)
    const request = facilitator.send('https://overlay.example', {
      beef: [1],
      topics: ['tm_foo']
    })
    const rejection = expect(request).rejects.toThrow('SHIP request timed out')

    await jest.advanceTimersByTimeAsync(30_000)
    await rejection
    expect(jest.getTimerCount()).toBe(0)
  })

  it('rejects unsafe specific-host acknowledgment maps without reading accessors', () => {
    const getter = jest.fn(() => ['tm_foo'])
    const accessorMap: Record<string, unknown> = {}
    Object.defineProperty(accessorMap, 'https://overlay.example', {
      enumerable: true,
      get: getter
    })
    expect(
      () =>
        new SHIPCast(['tm_foo'], {
          requireAcknowledgmentFromSpecificHostsForTopics: accessorMap as never
        })
    ).toThrow('must be a plain object')
    expect(getter).not.toHaveBeenCalled()

    const tooManyHosts = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`https://host-${index}.example`, 'all'])
    )
    expect(
      () =>
        new SHIPCast(['tm_foo'], {
          requireAcknowledgmentFromSpecificHostsForTopics: tooManyHosts as never
        })
    ).toThrow('too many hosts')

    expect(
      () =>
        new SHIPCast(['tm_foo'], {
          requireAcknowledgmentFromSpecificHostsForTopics: {
            'https://overlay.example': 'all',
            'https://overlay.example/': 'all'
          }
        })
    ).toThrow('duplicate host')
  })

  it('rejects an unknown network preset before creating default transports', () => {
    expect(() => new SHIPCast(['tm_foo'], { networkPreset: 'unknown' as never })).toThrow(
      'network preset is invalid'
    )
  })

  it('reports the all-host acknowledgment failure directly', () => {
    const broadcaster = new SHIPCast(['tm_foo'], {
      requireAcknowledgmentFromAllHostsForTopics: 'all'
    })
    expect(
      (broadcaster as any).checkAllHostsRequirement({
        'https://overlay.example': new Set()
      })
    ).toEqual({
      status: 'error',
      code: 'ERR_REQUIRE_ACK_FROM_ALL_HOSTS_FAILED',
      description: 'Not all hosts acknowledged the required topics.'
    })
  })

  it('accepts BRC-207 per-asset topic names and keeps rejecting noncanonical ones', () => {
    const assetTopic = `tm_color_${'0123456789abcdef'.repeat(4)}_0`
    expect(
      () =>
        new SHIPCast([assetTopic, 'tm_uhrp_files'], {
          requireAcknowledgmentFromAnyHostForTopics: [assetTopic]
        })
    ).not.toThrow()
    for (const topic of [
      'tm_',
      'tm__x',
      'tm_x_',
      'tm_Color',
      'tm_' + 'a'.repeat(297),
      `color_${'0123456789abcdef'.repeat(4)}_0`
    ]) {
      expect(() => new SHIPCast([topic])).toThrow(
        new Error('Broadcast topics must contain unique canonical tm_ topic names.')
      )
    }
  })

  it('Handles constructor errors', () => {
    expect(() => new SHIPCast([])).toThrow(
      new Error('Broadcast topics must be a bounded array of canonical topic names.')
    )
    expect(() => new SHIPCast(['badprefix_foo'])).toThrow(
      new Error('Broadcast topics must contain unique canonical tm_ topic names.')
    )
    const sparse: string[] = []
    sparse.length = 1
    expect(() => new SHIPCast(sparse)).toThrow('canonical tm_ topic names')
    expect(
      () =>
        new SHIPCast(['tm_foo'], {
          requireAcknowledgmentFromAnyHostForTopics: ['tm_other']
        })
    ).toThrow('may only reference topics included in this broadcast')
  })

  it('owns routing and acknowledgment configuration snapshots', () => {
    const topics = ['tm_foo']
    const allHosts = ['tm_foo']
    const specificHost = ['tm_foo']
    const hostRequirements = { 'https://shiphost.com/': specificHost }
    const broadcaster = new SHIPCast(topics, {
      requireAcknowledgmentFromAllHostsForTopics: allHosts,
      requireAcknowledgmentFromSpecificHostsForTopics: hostRequirements
    })

    topics[0] = 'tm_attacker'
    allHosts[0] = 'tm_attacker'
    specificHost[0] = 'tm_attacker'
    delete hostRequirements['https://shiphost.com/']

    expect((broadcaster as any).topics).toEqual(['tm_foo'])
    expect(
      (broadcaster as any).checkAllHostsRequirement({
        'https://shiphost.com': new Set(['tm_foo'])
      })
    ).toBeNull()
    expect(
      (broadcaster as any).checkSpecificHostsRequirement({
        'https://shiphost.com': new Set(['tm_foo'])
      })
    ).toBeNull()
  })

  it('should broadcast to a single SHIP host found via resolver', async () => {
    const shipHostKey = new PrivateKey(42)
    const shipWallet = new CompletedProtoWallet(shipHostKey)
    const shipLib = new OverlayAdminTokenTemplate(shipWallet)
    const shipScript = await shipLib.lock('SHIP', 'https://shiphost.com', 'tm_foo')
    const shipTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns one host interested in 'tm_foo' topic
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        {
          beef: shipTx.toBEEF(),
          outputIndex: 0
        }
      ]
    })

    // Host responds successfully
    mockFacilitator.send.mockReturnValueOnce({
      tm_foo: {
        outputsToAdmit: [0],
        coinsToRetain: []
      }
    })

    const b = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'success',
      txid: testTx.id('hex'),
      message: 'Sent to 1 Overlay Services host.'
    })

    expect(mockResolver.query).toHaveBeenCalledWith(
      {
        service: 'ls_ship',
        query: {
          topics: ['tm_foo']
        }
      },
      5000
    )

    expect(mockFacilitator.send).toHaveBeenCalledWith('https://shiphost.com', {
      beef: testTx.toBEEF(),
      topics: ['tm_foo']
    })
  })

  it('should be resilient to malformed or corrupted SHIP data, to the extent possible', async () => {
    const shipHostKey = new PrivateKey(42)
    const shipWallet = new CompletedProtoWallet(shipHostKey)
    const shipLib = new OverlayAdminTokenTemplate(shipWallet)
    // First SHIP is for wrong topic
    const shipScript = await shipLib.lock('SHIP', 'https://shiphost.com', 'tm_wrong')
    const shipTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript,
          satoshis: 1
        }
      ],
      0
    )
    const shipHostKey2 = new PrivateKey(43)
    const shipWallet2 = new CompletedProtoWallet(shipHostKey2)
    const shipLib2 = new OverlayAdminTokenTemplate(shipWallet2)
    // Second SHIP is for correct topic
    const shipScript2 = await shipLib2.lock('SHIP', 'https://shiphost2.com', 'tm_foo')
    const shipTx2 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript2,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns two hosts, both the correct and the corrupted ones.
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        {
          beef: shipTx.toBEEF(),
          outputIndex: 0
        },
        {
          beef: shipTx2.toBEEF(),
          outputIndex: 0
        }
      ]
    })

    // Host responds successfully
    mockFacilitator.send.mockReturnValue({
      tm_foo: {
        outputsToAdmit: [0],
        coinsToRetain: []
      }
    })

    const b = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    const testTx = new Transaction(1, [], [], 0)
    let response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'success',
      txid: testTx.id('hex'),
      // One SHIP advertisement should be used, but the second one was invalid
      message: 'Sent to 1 Overlay Services host.'
    })

    // Transaction should have been sent to the second host, but the first one was invalid
    expect(mockFacilitator.send).toHaveBeenCalledWith('https://shiphost2.com', {
      beef: testTx.toBEEF(),
      topics: ['tm_foo']
    })
    mockFacilitator.send.mockClear()

    // Resolver returns the wrong type of data — new broadcaster so cache is empty
    mockResolver.query.mockReturnValueOnce({
      type: 'invalid',
      bogus: true,
      outputs: {
        different: 'structure'
      }
    })
    const b2 = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    await expect(async () => await b2.broadcast(testTx)).rejects.toThrow(
      'SHIP answer is not a bounded output list.'
    )
    expect(mockFacilitator.send).not.toHaveBeenCalled()

    // Resolver returns the wrong output structure — new broadcaster so cache is empty
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: {
        different: 'structure'
      }
    })
    const b3 = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    await expect(async () => await b3.broadcast(testTx)).rejects.toThrow(
      'SHIP answer is not a bounded output list.'
    )
    expect(mockFacilitator.send).not.toHaveBeenCalled()

    // Resolver returns corrupted BEEF alongside good data
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        {
          beef: shipTx.toBEEF(), // Wrong topic
          outputIndex: 0
        },
        {
          beef: [0], // corrupted "rotten" BEEF
          outputIndex: 4
        },
        {
          beef: shipTx2.toBEEF(),
          outputIndex: 1 // Wrong output index
        },
        {
          beef: shipTx2.toBEEF(),
          outputIndex: 0 // correct
        }
      ]
    })
    const b4 = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    response = await b4.broadcast(testTx)
    expect(response).toEqual({
      status: 'success',
      txid: testTx.id('hex'),
      // One SHIP advertisement should be used, but the second one was invalid
      message: 'Sent to 1 Overlay Services host.'
    })

    // Transaction should have been sent to the second host, but the first one was invalid
    expect(mockFacilitator.send).toHaveBeenCalledWith('https://shiphost2.com', {
      beef: testTx.toBEEF(),
      topics: ['tm_foo']
    })
  })

  it('should fail when transaction cannot be serialized to BEEF', async () => {
    const b = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    const testTx = {
      toBEEF: () => {
        throw new Error('Cannot serialize to BEEF')
      },
      metadata: new Map()
    } as unknown as Transaction

    await expect(b.broadcast(testTx)).rejects.toThrow(
      'Transactions sent via SHIP to Overlay Services must be serializable to BEEF format.'
    )
  })

  it('should fail when no hosts are interested in the topics', async () => {
    // Resolver returns empty output list
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: []
    })

    const b = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    const testTx = new Transaction(1, [], [], 0)

    const result = await b.broadcast(testTx)

    expect(result).toEqual({
      status: 'error',
      code: 'ERR_NO_HOSTS_INTERESTED',
      description: 'No mainnet hosts are interested in receiving this transaction.'
    })

    expect(mockResolver.query).toHaveBeenCalledWith(
      {
        service: 'ls_ship',
        query: {
          topics: ['tm_foo']
        }
      },
      5000
    )

    expect(mockFacilitator.send).not.toHaveBeenCalled()
  })

  it('does not route a transaction to an unauthenticated SHIP advertisement', async () => {
    const key = new PrivateKey(44)
    const wallet = new CompletedProtoWallet(key)
    const unauthenticated = await new PushDrop(wallet).lock(
      [
        Utils.toArray('SHIP', 'utf8'),
        Utils.toArray(key.toPublicKey().toString(), 'hex'),
        Utils.toArray('https://attacker.example', 'utf8'),
        Utils.toArray('tm_foo', 'utf8')
      ],
      [2, 'Service Host Interconnect'],
      '1',
      'self'
    )
    const advertisementTx = new Transaction(
      1,
      [],
      [{ lockingScript: unauthenticated, satoshis: 1 }],
      0
    )
    const validScript = await new OverlayAdminTokenTemplate(wallet).lock(
      'SHIP',
      'https://wrong-value.example',
      'tm_foo'
    )
    const wrongValueTx = new Transaction(1, [], [{ lockingScript: validScript, satoshis: 2 }], 0)
    const mismatchedTxidTx = new Transaction(
      1,
      [],
      [{ lockingScript: validScript, satoshis: 1 }],
      0
    )
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        { beef: advertisementTx.toBEEF(), outputIndex: 0 },
        { beef: wrongValueTx.toBEEF(), outputIndex: 0 },
        {
          beef: mismatchedTxidTx.toBEEF(),
          outputIndex: 0,
          txid: '00'.repeat(32)
        }
      ]
    })

    const broadcaster = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    await expect(broadcaster.broadcast(new Transaction(1, [], [], 0))).resolves.toEqual({
      status: 'error',
      code: 'ERR_NO_HOSTS_INTERESTED',
      description: 'No mainnet hosts are interested in receiving this transaction.'
    })
    expect(mockFacilitator.send).not.toHaveBeenCalled()
  })

  it('should fail when all hosts reject the transaction', async () => {
    const shipHostKey = new PrivateKey(42)
    const shipWallet = new CompletedProtoWallet(shipHostKey)
    const shipLib = new OverlayAdminTokenTemplate(shipWallet)
    const shipScript = await shipLib.lock('SHIP', 'https://shiphost.com', 'tm_foo')
    const shipTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns one host
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        {
          beef: shipTx.toBEEF(),
          outputIndex: 0
        }
      ]
    })

    // Host fails
    mockFacilitator.send.mockImplementationOnce(() => {
      throw new Error('Host failed')
    })

    const b = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    const testTx = new Transaction(1, [], [], 0)

    const result = await b.broadcast(testTx)

    expect(result).toEqual({
      status: 'error',
      code: 'ERR_ALL_HOSTS_REJECTED',
      description: 'All mainnet topical hosts have rejected the transaction.'
    })

    expect(mockFacilitator.send).toHaveBeenCalled()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('should fail when required specific hosts are not among interested hosts', async () => {
    const shipHostKey = new PrivateKey(42)
    const shipWallet = new CompletedProtoWallet(shipHostKey)
    const shipLib = new OverlayAdminTokenTemplate(shipWallet)
    const shipScript = await shipLib.lock('SHIP', 'https://shiphost.com', 'tm_foo')
    const shipTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns one host
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        {
          beef: shipTx.toBEEF(),
          outputIndex: 0
        }
      ]
    })

    // First host acknowledges 'tm_foo', but it's not the right host.
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: topic === 'tm_foo' ? [0] : [],
          coinsToRetain: []
        }
      }
      return steak
    })

    const b = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver,
      requireAcknowledgmentFromSpecificHostsForTopics: {
        'https://anotherhost.com': ['tm_foo']
      },
      requireAcknowledgmentFromAllHostsForTopics: [],
      requireAcknowledgmentFromAnyHostForTopics: []
    })
    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'error',
      code: 'ERR_REQUIRE_ACK_FROM_SPECIFIC_HOSTS_FAILED',
      description: 'Specific hosts did not acknowledge the required topics.'
    })
  })

  it('should succeed quietly when one host fails and another acknowledges all topics', async () => {
    const shipHostKey1 = new PrivateKey(42)
    const shipWallet1 = new CompletedProtoWallet(shipHostKey1)
    const shipLib1 = new OverlayAdminTokenTemplate(shipWallet1)
    const shipScript1 = await shipLib1.lock('SHIP', 'https://shiphost1.com', 'tm_foo')
    const shipScript1b = await shipLib1.lock('SHIP', 'https://shiphost1.com', 'tm_bar')
    const shipTx1 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript1,
          satoshis: 1
        },
        {
          lockingScript: shipScript1b,
          satoshis: 1
        }
      ],
      0
    )

    const shipHostKey2 = new PrivateKey(43)
    const shipWallet2 = new CompletedProtoWallet(shipHostKey2)
    const shipLib2 = new OverlayAdminTokenTemplate(shipWallet2)
    const shipScript2 = await shipLib2.lock('SHIP', 'https://shiphost2.com', 'tm_bar')
    const shipScript2b = await shipLib2.lock('SHIP', 'https://shiphost2.com', 'tm_foo')
    const shipTx2 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript2,
          satoshis: 1
        },
        {
          lockingScript: shipScript2b,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns two hosts
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        { beef: shipTx1.toBEEF(), outputIndex: 0 },
        { beef: shipTx1.toBEEF(), outputIndex: 1 },
        { beef: shipTx2.toBEEF(), outputIndex: 0 },
        { beef: shipTx2.toBEEF(), outputIndex: 1 }
      ]
    })

    // One interested host fails while the other acknowledges all topics.
    mockFacilitator.send.mockImplementation(async (host, { topics }) => {
      if (host === 'https://shiphost1.com') {
        throw new Error('Host failed')
      }
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: [0],
          coinsToRetain: []
        }
      }
      return steak
    })

    const b = new SHIPCast(['tm_foo', 'tm_bar'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'success',
      txid: testTx.id('hex'),
      message: 'Sent to 1 Overlay Services host.'
    })

    expect(mockResolver.query).toHaveBeenCalledWith(
      {
        service: 'ls_ship',
        query: {
          topics: ['tm_foo', 'tm_bar']
        }
      },
      5000
    )

    expect(mockFacilitator.send).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('should fail if at least one host does not acknowledge every topic (default behavior)', async () => {
    const shipHostKey1 = new PrivateKey(42)
    const shipWallet1 = new CompletedProtoWallet(shipHostKey1)
    const shipLib1 = new OverlayAdminTokenTemplate(shipWallet1)
    const shipScript1 = await shipLib1.lock('SHIP', 'https://shiphost1.com', 'tm_foo')
    const shipTx1 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript1,
          satoshis: 1
        }
      ],
      0
    )

    const shipHostKey2 = new PrivateKey(43)
    const shipWallet2 = new CompletedProtoWallet(shipHostKey2)
    const shipLib2 = new OverlayAdminTokenTemplate(shipWallet2)
    const shipScript2 = await shipLib2.lock('SHIP', 'https://shiphost2.com', 'tm_bar')
    const shipTx2 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript2,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns two hosts
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        { beef: shipTx1.toBEEF(), outputIndex: 0 },
        { beef: shipTx2.toBEEF(), outputIndex: 0 }
      ]
    })

    // First host acknowledges 'tm_foo'
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: []
        }
      }
      return steak
    })

    // Second host does not acknowledge any topics
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: []
        }
      }
      return steak
    })

    const b = new SHIPCast(['tm_foo', 'tm_bar'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'error',
      code: 'ERR_REQUIRE_ACK_FROM_ANY_HOST_FAILED',
      description: 'No host acknowledged the required topics.'
    })
  })

  it('should succeed when at least one host acknowledges required topics with requireAcknowledgmentFromAnyHostForTopics set to "any"', async () => {
    const shipHostKey1 = new PrivateKey(42)
    const shipWallet1 = new CompletedProtoWallet(shipHostKey1)
    const shipLib1 = new OverlayAdminTokenTemplate(shipWallet1)
    const shipScript1 = await shipLib1.lock('SHIP', 'https://shiphost1.com', 'tm_foo')
    const shipTx1 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript1,
          satoshis: 1
        }
      ],
      0
    )

    const shipHostKey2 = new PrivateKey(43)
    const shipWallet2 = new CompletedProtoWallet(shipHostKey2)
    const shipLib2 = new OverlayAdminTokenTemplate(shipWallet2)
    const shipScript2 = await shipLib2.lock('SHIP', 'https://shiphost2.com', 'tm_bar')
    const shipTx2 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript2,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns two hosts
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        { beef: shipTx1.toBEEF(), outputIndex: 0 },
        { beef: shipTx2.toBEEF(), outputIndex: 0 }
      ]
    })

    // First host acknowledges no topics
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: []
        }
      }
      return steak
    })

    // Second host acknowledges 'tm_bar'
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: topic === 'tm_bar' ? [0] : [],
          coinsToRetain: []
        }
      }
      return steak
    })

    const b = new SHIPCast(['tm_foo', 'tm_bar'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver,
      requireAcknowledgmentFromAnyHostForTopics: 'any',
      requireAcknowledgmentFromAllHostsForTopics: []
    })

    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'success',
      txid: testTx.id('hex'),
      message: 'Sent to 2 Overlay Services hosts.'
    })
  })

  it('should fail when no hosts acknowledge required topics with requireAcknowledgmentFromAnyHostForTopics set to "any"', async () => {
    const shipHostKey1 = new PrivateKey(42)
    const shipWallet1 = new CompletedProtoWallet(shipHostKey1)
    const shipLib1 = new OverlayAdminTokenTemplate(shipWallet1)
    const shipScript1 = await shipLib1.lock('SHIP', 'https://shiphost1.com', 'tm_foo')
    const shipTx1 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript1,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns one host
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [{ beef: shipTx1.toBEEF(), outputIndex: 0 }]
    })

    // Host acknowledges no topics
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: []
        }
      }
      return steak
    })

    const b = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver,
      requireAcknowledgmentFromAnyHostForTopics: 'any',
      requireAcknowledgmentFromAllHostsForTopics: []
    })

    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'error',
      code: 'ERR_REQUIRE_ACK_FROM_ANY_HOST_FAILED',
      description: 'No host acknowledged the required topics.'
    })
  })

  it('should succeed when specific hosts acknowledge required topics', async () => {
    const shipHostKey1 = new PrivateKey(42)
    const shipWallet1 = new CompletedProtoWallet(shipHostKey1)
    const shipLib1 = new OverlayAdminTokenTemplate(shipWallet1)
    const shipScript1 = await shipLib1.lock('SHIP', 'https://shiphost1.com', 'tm_foo')
    const shipTx1 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript1,
          satoshis: 1
        }
      ],
      0
    )

    const shipHostKey2 = new PrivateKey(43)
    const shipWallet2 = new CompletedProtoWallet(shipHostKey2)
    const shipLib2 = new OverlayAdminTokenTemplate(shipWallet2)
    const shipScript2 = await shipLib2.lock('SHIP', 'https://shiphost2.com', 'tm_bar')
    const shipTx2 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript2,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns two hosts
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        { beef: shipTx1.toBEEF(), outputIndex: 0 },
        { beef: shipTx2.toBEEF(), outputIndex: 0 }
      ]
    })

    // First host acknowledges 'tm_foo'
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: topic === 'tm_foo' ? [0] : [],
          coinsToRetain: []
        }
      }
      return steak
    })

    // Second host does not acknowledge 'tm_bar'
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: []
        }
      }
      return steak
    })

    const b = new SHIPCast(['tm_foo', 'tm_bar'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver,
      requireAcknowledgmentFromSpecificHostsForTopics: {
        'https://shiphost1.com': ['tm_foo']
      },
      requireAcknowledgmentFromAllHostsForTopics: [],
      requireAcknowledgmentFromAnyHostForTopics: []
    })
    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'success',
      txid: testTx.id('hex'),
      message: 'Sent to 2 Overlay Services hosts.'
    })
  })

  it('should succeed when interested hosts only remove coins in a transaction broadcast', async () => {
    const shipHostKey1 = new PrivateKey(42)
    const shipWallet1 = new CompletedProtoWallet(shipHostKey1)
    const shipLib1 = new OverlayAdminTokenTemplate(shipWallet1)
    const shipScript1 = await shipLib1.lock('SHIP', 'https://shiphost1.com', 'tm_foo')
    const shipTx1 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript1,
          satoshis: 1
        }
      ],
      0
    )

    const shipHostKey2 = new PrivateKey(43)
    const shipWallet2 = new CompletedProtoWallet(shipHostKey2)
    const shipLib2 = new OverlayAdminTokenTemplate(shipWallet2)
    const shipScript2 = await shipLib2.lock('SHIP', 'https://shiphost2.com', 'tm_bar')
    const shipTx2 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript2,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns two hosts
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        { beef: shipTx1.toBEEF(), outputIndex: 0 },
        { beef: shipTx2.toBEEF(), outputIndex: 0 }
      ]
    })

    // First host acknowledges 'tm_foo' with coinsRemoved
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: [],
          coinsRemoved: topic === 'tm_foo' ? [0] : []
        }
      }
      return steak
    })

    // Second host does not acknowledge 'tm_bar'
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: [],
          coinsRemoved: []
        }
      }
      return steak
    })

    const b = new SHIPCast(['tm_foo', 'tm_bar'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver,
      requireAcknowledgmentFromSpecificHostsForTopics: {
        'https://shiphost1.com': ['tm_foo']
      },
      requireAcknowledgmentFromAllHostsForTopics: [],
      requireAcknowledgmentFromAnyHostForTopics: []
    })

    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'success',
      txid: testTx.id('hex'),
      message: 'Sent to 2 Overlay Services hosts.'
    })

    // Verify the resolver was queried correctly
    expect(mockResolver.query).toHaveBeenCalledWith(
      {
        service: 'ls_ship',
        query: {
          topics: ['tm_foo', 'tm_bar']
        }
      },
      5000
    )
  })

  it('should fail when specific hosts do not acknowledge required topics', async () => {
    const shipHostKey1 = new PrivateKey(42)
    const shipWallet1 = new CompletedProtoWallet(shipHostKey1)
    const shipLib1 = new OverlayAdminTokenTemplate(shipWallet1)
    const shipScript1 = await shipLib1.lock('SHIP', 'https://shiphost1.com', 'tm_foo')
    const shipTx1 = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript1,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns one host
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [{ beef: shipTx1.toBEEF(), outputIndex: 0 }]
    })

    // Host does not acknowledge 'tm_foo'
    mockFacilitator.send.mockImplementationOnce(async (host, { beef: _beef, topics }) => {
      const steak = {}
      for (const topic of topics) {
        steak[topic] = {
          outputsToAdmit: [],
          coinsToRetain: []
        }
      }
      return steak
    })

    const b = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver,
      requireAcknowledgmentFromSpecificHostsForTopics: {
        'https://shiphost1.com': ['tm_foo']
      },
      requireAcknowledgmentFromAllHostsForTopics: [],
      requireAcknowledgmentFromAnyHostForTopics: []
    })

    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    expect(response).toEqual({
      status: 'error',
      code: 'ERR_REQUIRE_ACK_FROM_SPECIFIC_HOSTS_FAILED',
      description: 'Specific hosts did not acknowledge the required topics.'
    })
  })

  it('should handle invalid acknowledgments from hosts gracefully', async () => {
    const shipHostKey = new PrivateKey(42)
    const shipWallet = new CompletedProtoWallet(shipHostKey)
    const shipLib = new OverlayAdminTokenTemplate(shipWallet)
    const shipScript = await shipLib.lock('SHIP', 'https://shiphost.com', 'tm_foo')
    const shipTx = new Transaction(
      1,
      [],
      [
        {
          lockingScript: shipScript,
          satoshis: 1
        }
      ],
      0
    )

    // Resolver returns one host
    mockResolver.query.mockReturnValueOnce({
      type: 'output-list',
      outputs: [
        {
          beef: shipTx.toBEEF(),
          outputIndex: 0
        }
      ]
    })

    // Host returns invalid acknowledgment
    mockFacilitator.send.mockReturnValueOnce(null)
    const b = new SHIPCast(['tm_foo'], {
      facilitator: mockFacilitator,
      resolver: mockResolver as unknown as LookupResolver
    })
    const testTx = new Transaction(1, [], [], 0)
    const response = await b.broadcast(testTx)

    // Since the host responded (successfully in terms of HTTP), but with invalid data, we should consider it a failure
    expect(response).toEqual({
      status: 'error',
      code: 'ERR_ALL_HOSTS_REJECTED',
      description: 'All mainnet topical hosts have rejected the transaction.'
    })
  })
  describe('SHIPCast private methods', () => {
    let shipCast: SHIPCast

    beforeEach(() => {
      shipCast = new SHIPCast(['tm_foo', 'tm_bar'], {
        facilitator: mockFacilitator,
        resolver: mockResolver as unknown as LookupResolver
      })
    })

    describe('checkAcknowledgmentFromAllHosts', () => {
      it('should return true when all hosts acknowledge all required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo', 'tm_bar']),
          'https://host2.com': new Set(['tm_foo', 'tm_bar'])
        }
        const result = (shipCast as any).checkAcknowledgmentFromAllHosts(
          hostAcknowledgments,
          ['tm_foo', 'tm_bar'],
          'all'
        )
        expect(result).toBe(true)
      })

      it('should return false when any host does not acknowledge all required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo']),
          'https://host2.com': new Set(['tm_foo', 'tm_bar'])
        }
        const result = (shipCast as any).checkAcknowledgmentFromAllHosts(
          hostAcknowledgments,
          ['tm_foo', 'tm_bar'],
          'all'
        )
        expect(result).toBe(false)
      })

      it('should return true when all hosts acknowledge any of the required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo']),
          'https://host2.com': new Set(['tm_bar'])
        }
        const result = (shipCast as any).checkAcknowledgmentFromAllHosts(
          hostAcknowledgments,
          ['tm_foo', 'tm_bar'],
          'any'
        )
        expect(result).toBe(true)
      })

      it('should return false when any host does not acknowledge any of the required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(),
          'https://host2.com': new Set(['tm_bar'])
        }
        const result = (shipCast as any).checkAcknowledgmentFromAllHosts(
          hostAcknowledgments,
          ['tm_foo', 'tm_bar'],
          'any'
        )
        expect(result).toBe(false)
      })
    })

    describe('checkAcknowledgmentFromAnyHost', () => {
      it('should return true when at least one host acknowledges all required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo', 'tm_bar']),
          'https://host2.com': new Set(['tm_foo'])
        }
        const result = (shipCast as any).checkAcknowledgmentFromAnyHost(
          hostAcknowledgments,
          ['tm_foo', 'tm_bar'],
          'all'
        )
        expect(result).toBe(true)
      })

      it('should return false when no host acknowledges all required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo']),
          'https://host2.com': new Set(['tm_bar'])
        }
        const result = (shipCast as any).checkAcknowledgmentFromAnyHost(
          hostAcknowledgments,
          ['tm_foo', 'tm_bar'],
          'all'
        )
        expect(result).toBe(false)
      })

      it('should return true when at least one host acknowledges any of the required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo']),
          'https://host2.com': new Set()
        }
        const result = (shipCast as any).checkAcknowledgmentFromAnyHost(
          hostAcknowledgments,
          ['tm_foo', 'tm_bar'],
          'any'
        )
        expect(result).toBe(true)
      })

      it('should return false when no host acknowledges any of the required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(),
          'https://host2.com': new Set()
        }
        const result = (shipCast as any).checkAcknowledgmentFromAnyHost(
          hostAcknowledgments,
          ['tm_foo', 'tm_bar'],
          'any'
        )
        expect(result).toBe(false)
      })
    })

    describe('checkAcknowledgmentFromSpecificHosts', () => {
      it('should return true when specific hosts acknowledge all required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo', 'tm_bar']),
          'https://host2.com': new Set(['tm_foo'])
        }
        const requirements = {
          'https://host1.com': ['tm_foo', 'tm_bar']
        }
        const result = (shipCast as any).checkAcknowledgmentFromSpecificHosts(
          hostAcknowledgments,
          requirements
        )
        expect(result).toBe(true)
      })

      it('should return false when specific hosts do not acknowledge all required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo']),
          'https://host2.com': new Set(['tm_bar'])
        }
        const requirements = {
          'https://host1.com': ['tm_foo', 'tm_bar']
        }
        const result = (shipCast as any).checkAcknowledgmentFromSpecificHosts(
          hostAcknowledgments,
          requirements
        )
        expect(result).toBe(false)
      })

      it('should return true when specific hosts acknowledge any of the required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo']),
          'https://host2.com': new Set(['tm_bar'])
        }
        const requirements = {
          'https://host1.com': 'any'
        }
        const result = (shipCast as any).checkAcknowledgmentFromSpecificHosts(
          hostAcknowledgments,
          requirements
        )
        expect(result).toBe(true)
      })

      it('should return false when specific hosts do not acknowledge any of the required topics', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(),
          'https://host2.com': new Set(['tm_bar'])
        }
        const requirements = {
          'https://host1.com': 'any'
        }
        const result = (shipCast as any).checkAcknowledgmentFromSpecificHosts(
          hostAcknowledgments,
          requirements
        )
        expect(result).toBe(false)
      })

      it('should handle multiple hosts with different requirements', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo']),
          'https://host2.com': new Set(['tm_bar']),
          'https://host3.com': new Set(['tm_foo', 'tm_bar'])
        }
        const requirements = {
          'https://host1.com': ['tm_foo'],
          'https://host2.com': 'any',
          'https://host3.com': 'all'
        }
        const result = (shipCast as any).checkAcknowledgmentFromSpecificHosts(
          hostAcknowledgments,
          requirements
        )
        expect(result).toBe(true)
      })

      it('should return false if any specific host fails to meet its requirement', () => {
        const hostAcknowledgments = {
          'https://host1.com': new Set(['tm_foo']),
          'https://host2.com': new Set(),
          'https://host3.com': new Set(['tm_foo'])
        }
        const requirements = {
          'https://host1.com': ['tm_foo'],
          'https://host2.com': 'any',
          'https://host3.com': ['tm_foo', 'tm_bar']
        }
        const result = (shipCast as any).checkAcknowledgmentFromSpecificHosts(
          hostAcknowledgments,
          requirements
        )
        expect(result).toBe(false)
      })
    })
  })
})
