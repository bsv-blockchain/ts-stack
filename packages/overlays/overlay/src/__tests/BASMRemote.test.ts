import { BASMProtocolError, BASMRemote } from '../BASMRemote'

const ENDPOINT = 'https://peer.example/overlay'
const TOPIC = 'tm_example'
const ZERO = '0000000000000000000000000000000000000000000000000000000000000000'
const TXID_1 = '0101010101010101010101010101010101010101010101010101010101010101'
const TXID_2 = '0202020202020202020202020202020202020202020202020202020202020202'
const TXID_3 = '0303030303030303030303030303030303030303030303030303030303030303'
const BLOCK_HASH = '0404040404040404040404040404040404040404040404040404040404040404'
const BASM_ROOT = '0505050505050505050505050505050505050505050505050505050505050505'
const TAC = '0606060606060606060606060606060606060606060606060606060606060606'

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function remoteFor(value: unknown, limits = {}): BASMRemote {
  return new BASMRemote(ENDPOINT, TOPIC, async () => response(value), limits)
}

function anchor(blockHeight: number): Record<string, unknown> {
  return {
    topic: TOPIC,
    blockHeight,
    blockHash: BLOCK_HASH,
    basmRoot: BASM_ROOT,
    admittedCount: 0,
    tac: TAC
  }
}

describe('BASMRemote', () => {
  it('preserves the BASM request URL and wire shape while accepting legacy minimal responses', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const injectedFetch: typeof fetch = async (input, init) => {
      calls.push([input, init])
      if (String(input).endsWith('/requestTopicAnchorTip')) {
        return response({ topic: TOPIC, blockHeight: -1, tac: ZERO })
      }
      return response({ topic: TOPIC, blockHeight: 42, admitted: [] })
    }
    const remote = new BASMRemote(ENDPOINT, TOPIC, injectedFetch)

    await expect(remote.requestTopicAnchorTip()).resolves.toEqual({
      topic: TOPIC,
      blockHeight: -1,
      tac: ZERO
    })
    await expect(remote.requestAdmittedList(42)).resolves.toEqual({
      topic: TOPIC,
      blockHeight: 42,
      admitted: []
    })
    expect(calls).toEqual([
      [
        'https://peer.example/requestTopicAnchorTip',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'x-bsv-topic': TOPIC
          },
          body: '{}',
          signal: expect.any(AbortSignal)
        }
      ],
      [
        'https://peer.example/requestAdmittedList',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'x-bsv-topic': TOPIC
          },
          body: JSON.stringify({ blockHeight: 42 }),
          signal: expect.any(AbortSignal)
        }
      ]
    ])
  })

  it.each([
    ['wrong topic', { topic: 'tm_other', blockHeight: 7, tac: TAC }],
    ['wrong height', { topic: TOPIC, blockHeight: 8, admitted: [] }],
    [
      'conflicting block hash',
      { topic: TOPIC, blockHeight: 7, blockHash: BLOCK_HASH, admitted: [] }
    ]
  ])('rejects an admitted response with a %s', async (_label, value) => {
    const remote = remoteFor(value)
    await expect(remote.requestAdmittedList(7, TXID_1)).rejects.toMatchObject({
      name: 'BASMProtocolError',
      code: 'BASM_INVALID_RESPONSE'
    })
  })

  it('caps the admitted list before accepting unbounded peer data', async () => {
    const remote = remoteFor(
      {
        topic: TOPIC,
        blockHeight: 7,
        admitted: [
          { txid: TXID_1, blockIndex: 0 },
          { txid: TXID_2, blockIndex: 1 }
        ]
      },
      { maxAdmittedTxids: 1 }
    )

    await expect(remote.requestAdmittedList(7)).rejects.toMatchObject({
      code: 'BASM_RESOURCE_LIMIT'
    })
  })

  it.each([
    ['unordered anchors', [anchor(5), anchor(4)]],
    ['a gap between anchors', [anchor(4), anchor(6)]]
  ])('rejects an anchor range with %s', async (_label, anchors) => {
    const remote = remoteFor({ topic: TOPIC, anchors })
    await expect(remote.requestTopicAnchorRange(4, 6)).rejects.toMatchObject({
      code: 'BASM_INVALID_RESPONSE'
    })
  })

  it('rejects an anchor response with more entries than the requested range', async () => {
    const remote = remoteFor({ topic: TOPIC, anchors: [anchor(4), anchor(5), anchor(6)] })
    await expect(remote.requestTopicAnchorRange(4, 5)).rejects.toMatchObject({
      code: 'BASM_RESOURCE_LIMIT'
    })
  })

  it.each([
    [
      'a duplicate txid',
      [
        { txid: TXID_1, blockIndex: 0 },
        { txid: TXID_1, blockIndex: 1 }
      ]
    ],
    [
      'a duplicate block index',
      [
        { txid: TXID_1, blockIndex: 0 },
        { txid: TXID_2, blockIndex: 0 }
      ]
    ],
    [
      'nonmonotonic block indices',
      [
        { txid: TXID_1, blockIndex: 2 },
        { txid: TXID_2, blockIndex: 1 }
      ]
    ]
  ])('rejects an admitted list with %s', async (_label, admitted) => {
    const remote = remoteFor({ topic: TOPIC, blockHeight: 7, admitted })
    await expect(remote.requestAdmittedList(7)).rejects.toMatchObject({
      code: 'BASM_INVALID_RESPONSE'
    })
  })

  it('accepts a proof response whose txids are reordered but exactly match the request', async () => {
    const remote = remoteFor({
      topic: TOPIC,
      blockHeight: 7,
      txids: [TXID_2, TXID_1],
      merklePath: 'aabb'
    })
    await expect(remote.requestCompoundMerklePath(7, [TXID_1, TXID_2])).resolves.toEqual({
      topic: TOPIC,
      blockHeight: 7,
      txids: [TXID_2, TXID_1],
      merklePath: 'aabb'
    })
  })

  it('rejects a proof response that does not contain exactly the requested txid set', async () => {
    const remote = remoteFor({
      topic: TOPIC,
      blockHeight: 7,
      txids: [TXID_1, TXID_3],
      merklePath: 'aabb'
    })
    await expect(remote.requestCompoundMerklePath(7, [TXID_1, TXID_2])).rejects.toMatchObject({
      code: 'BASM_INVALID_RESPONSE'
    })
  })

  it.each([
    [
      'an extra transaction',
      { transactions: [{ txid: TXID_3, rawTx: 'aabb' }], missing: [TXID_1, TXID_2] }
    ],
    ['an omitted transaction', { transactions: [{ txid: TXID_1, rawTx: 'aabb' }], missing: [] }],
    [
      'a duplicate transaction',
      {
        transactions: [
          { txid: TXID_1, rawTx: 'aabb' },
          { txid: TXID_1, rawTx: 'ccdd' }
        ],
        missing: []
      }
    ],
    [
      'a transaction also reported missing',
      { transactions: [{ txid: TXID_1, rawTx: 'aabb' }], missing: [TXID_1, TXID_2] }
    ]
  ])('rejects a raw transaction response containing %s', async (_label, value) => {
    const remote = remoteFor(value)
    await expect(remote.requestRawTransactions([TXID_1, TXID_2])).rejects.toMatchObject({
      code: 'BASM_INVALID_RESPONSE'
    })
  })

  it('rejects a chunked response once its streamed bytes cross the configured cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"topic"'))
        controller.enqueue(Buffer.from(':"tm_example"}'))
        controller.close()
      }
    })
    const remote = new BASMRemote(ENDPOINT, TOPIC, async () => new Response(stream), {
      maxResponseBytes: 10
    })

    await expect(remote.requestTopicAnchorTip()).rejects.toMatchObject({
      code: 'BASM_RESOURCE_LIMIT'
    })
  })

  it('rejects an advertised response length above the configured cap before reading it', async () => {
    const remote = new BASMRemote(
      ENDPOINT,
      TOPIC,
      async () => new Response('{"topic":"tm_example"}', { headers: { 'content-length': '11' } }),
      { maxResponseBytes: 10 }
    )

    await expect(remote.requestTopicAnchorTip()).rejects.toMatchObject({
      code: 'BASM_RESOURCE_LIMIT'
    })
  })

  it('reports malformed successful JSON as a protocol error', async () => {
    const remote = new BASMRemote(ENDPOINT, TOPIC, async () => new Response('{'), {})
    await expect(remote.requestTopicAnchorTip()).rejects.toBeInstanceOf(BASMProtocolError)
    await expect(remote.requestTopicAnchorTip()).rejects.toMatchObject({
      code: 'BASM_INVALID_RESPONSE'
    })
  })

  it('times out a fetch that observes the abort signal', async () => {
    let abortObserved = false
    const remote = new BASMRemote(
      ENDPOINT,
      TOPIC,
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortObserved = true
            reject(init.signal?.reason)
          })
        }),
      { timeoutMs: 20 }
    )

    await expect(remote.requestTopicAnchorTip()).rejects.toMatchObject({ code: 'BASM_TIMEOUT' })
    expect(abortObserved).toBe(true)
  })

  it('times out a fetch that ignores the abort signal', async () => {
    let signal: AbortSignal | undefined
    const remote = new BASMRemote(
      ENDPOINT,
      TOPIC,
      async (_input, init) =>
        await new Promise<Response>(() => {
          signal = init?.signal ?? undefined
        }),
      { timeoutMs: 20 }
    )

    await expect(remote.requestTopicAnchorTip()).rejects.toMatchObject({ code: 'BASM_TIMEOUT' })
    expect(signal?.aborted).toBe(true)
  })

  it('times out while a real response body stalls', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull: async () => await new Promise<void>(() => {})
    })
    const remote = new BASMRemote(ENDPOINT, TOPIC, async () => new Response(stalled), {
      timeoutMs: 20
    })

    await expect(remote.requestTopicAnchorTip()).rejects.toMatchObject({ code: 'BASM_TIMEOUT' })
  })

  it.each([
    ['a 501 response', response({}, 501), 'BASM_UNSUPPORTED'],
    [
      'an explicit unsupported response',
      response({ code: 'BASM_UNSUPPORTED' }, 400),
      'BASM_UNSUPPORTED'
    ],
    ['a generic 503 response', response({}, 503), 'BASM_HTTP_ERROR']
  ])('classifies %s', async (_label, peerResponse, code) => {
    const remote = new BASMRemote(ENDPOINT, TOPIC, async () => peerResponse)
    await expect(remote.requestTopicAnchorTip()).rejects.toMatchObject({ code })
  })

  it('accepts a contiguous range and a complete raw-transaction partition', async () => {
    const remote = new BASMRemote(ENDPOINT, TOPIC, async input => {
      if (String(input).endsWith('/requestTopicAnchorRange')) {
        return response({ topic: TOPIC, anchors: [anchor(4), anchor(5)] })
      }
      return response({
        transactions: [{ txid: TXID_2, rawTx: 'ccdd' }],
        missing: [TXID_1]
      })
    })

    await expect(remote.requestTopicAnchorRange(4, 5)).resolves.toEqual({
      topic: TOPIC,
      anchors: [anchor(4), anchor(5)]
    })
    await expect(remote.requestRawTransactions([TXID_1, TXID_2])).resolves.toEqual({
      transactions: [{ txid: TXID_2, rawTx: 'ccdd' }],
      missing: [TXID_1]
    })
  })

  it.each([
    [
      'an uppercase TAC',
      async (remote: BASMRemote) => await remote.requestTopicAnchorTip(),
      { topic: TOPIC, blockHeight: -1, tac: 'ab'.repeat(32).toUpperCase() }
    ],
    [
      'a numeric-string height',
      async (remote: BASMRemote) => await remote.requestTopicAnchorTip(),
      { topic: TOPIC, blockHeight: '7', tac: TAC }
    ],
    [
      'a mixed-case block hash',
      async (remote: BASMRemote) => await remote.requestTopicAnchorRange(4, 4),
      { topic: TOPIC, anchors: [{ ...anchor(4), blockHash: 'cd'.repeat(32).toUpperCase() }] }
    ]
  ])('rejects %s rather than coercing untrusted peer JSON', async (_label, invoke, value) => {
    await expect(invoke(remoteFor(value))).rejects.toMatchObject({
      code: 'BASM_INVALID_RESPONSE'
    })
  })

  it('rejects a duplicated height as an unordered or gapped range', async () => {
    const remote = remoteFor({ topic: TOPIC, anchors: [anchor(4), anchor(4)] })
    await expect(remote.requestTopicAnchorRange(4, 5)).rejects.toMatchObject({
      code: 'BASM_INVALID_RESPONSE'
    })
  })

  it('ignores unknown additive JSON fields on a legacy tip', async () => {
    const remote = remoteFor({
      topic: TOPIC,
      blockHeight: -1,
      tac: ZERO,
      extra: 'ignored'
    })
    await expect(remote.requestTopicAnchorTip()).resolves.toEqual({
      topic: TOPIC,
      blockHeight: -1,
      tac: ZERO
    })
  })
})
