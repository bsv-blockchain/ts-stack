import { Transaction } from '@bsv/sdk'
import {
  MAX_BASM_TXIDS,
  assertGASPInitialResponse,
  assertGASPNode,
  assertHexBytes,
  assertNonnegativeInteger,
  assertOutpoint,
  assertOutputIndex,
  assertTopic,
  assertTxidList,
  readPeerJSON,
  validateAdmittanceInstructions
} from '../RemoteSecurity.js'

const txRaw = '01000000000000000000'
const tx = Transaction.fromHex(txRaw)
const txid = tx.id('hex')
const hash = '11'.repeat(32)

function streamedResponse(
  chunks: number[][],
  init: ResponseInit = {}
): { response: Response; cancelled: jest.Mock } {
  const cancelled = jest.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk))
      controller.close()
    },
    cancel: cancelled
  })
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init
    }),
    cancelled
  }
}

describe('RemoteSecurity validation boundaries', () => {
  it.each([
    ['a non-object result', null],
    ['missing outputs', { coinsToRetain: [] }],
    ['missing retained coins', { outputsToAdmit: [] }]
  ])('rejects admittance instructions with %s', (_label, value) => {
    expect(() => validateAdmittanceInstructions(value, tx, [])).toThrow(
      'invalid admittance instructions'
    )
  })

  it.each([
    ['non-number output', ['0'], [], 'outputsToAdmit'],
    ['fractional output', [0.5], [], 'outputsToAdmit'],
    ['negative output', [-1], [], 'outputsToAdmit'],
    ['out-of-range output', [0], [], 'outputsToAdmit'],
    ['duplicate retained input', [], [0, 0], 'coinsToRetain']
  ])('rejects %s indexes', (_label, outputsToAdmit, coinsToRetain, message) => {
    const transaction = new Transaction(1, [{ sourceTXID: hash, sourceOutputIndex: 0 }], [], 0)
    expect(() =>
      validateAdmittanceInstructions({ outputsToAdmit, coinsToRetain }, transaction, [0])
    ).toThrow(message as string)
  })

  it('binds retained coins to the caller-provided topical inputs', () => {
    const transaction = new Transaction(
      1,
      [
        { sourceTXID: hash, sourceOutputIndex: 0 },
        { sourceTXID: '22'.repeat(32), sourceOutputIndex: 1 }
      ],
      [],
      0
    )
    expect(() =>
      validateAdmittanceInstructions({ outputsToAdmit: [], coinsToRetain: [1] }, transaction, [0])
    ).toThrow('not a previous topical coin')
  })

  it.each([
    ['non-string', 1],
    ['empty', ''],
    ['oversized UTF-8', 'é'.repeat(129)],
    ['NUL control', 'topic\u0000'],
    ['unit separator', 'topic\u001f'],
    ['delete control', 'topic\u007f']
  ])('rejects %s topics', (_label, value) => {
    expect(() => assertTopic(value, 'remote topic')).toThrow('remote topic is invalid')
  })

  it.each([-1, 0x1_0000_0000, 1.5, Number.NaN, '0'])('rejects invalid output index %s', value => {
    expect(() => assertOutputIndex(value, 'remote index')).toThrow('unsigned 32-bit integer')
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, '0'])(
    'rejects invalid nonnegative integer %s',
    value => {
      expect(() => assertNonnegativeInteger(value, 'remote score')).toThrow(
        'non-negative safe integer'
      )
    }
  )

  it.each([
    ['a non-string', 1],
    ['a missing separator', hash],
    ['a leading-zero index', `${hash}.01`],
    ['a signed index', `${hash}.-1`],
    ['an oversized index', `${hash}.4294967296`]
  ])('rejects an outpoint with %s', (_label, value) => {
    expect(() => assertOutpoint(value, 'remote outpoint')).toThrow()
  })

  it.each([
    ['a non-string', 1, 2, false],
    ['an empty value', '', 2, false],
    ['odd-length hex', '0', 2, false],
    ['non-hex bytes', 'zz', 2, false],
    ['too many bytes', '000000', 2, false]
  ])('rejects hexadecimal data with %s', (_label, value, maxBytes, allowEmpty) => {
    expect(() => assertHexBytes(value, 'remote bytes', maxBytes, allowEmpty)).toThrow(
      'bounded, even-length hexadecimal data'
    )
  })

  it('accepts the exact hexadecimal and transaction-list boundaries', () => {
    expect(() => assertHexBytes('', 'optional bytes', 0, true)).not.toThrow()
    expect(() => assertHexBytes('00ff', 'remote bytes', 2)).not.toThrow()
    expect(() => assertTxidList([], 'optional txids', { allowEmpty: true, max: 0 })).not.toThrow()
    expect(() => assertTxidList([hash], 'single txid', { max: 1 })).not.toThrow()
  })

  it.each([
    ['a non-array', null],
    ['an empty required list', []],
    ['too many entries', Array(MAX_BASM_TXIDS + 1).fill(hash)],
    ['duplicate canonical txids', [hash.toUpperCase(), hash]]
  ])('rejects a txid list with %s', (_label, value) => {
    expect(() => assertTxidList(value, 'remote txids')).toThrow()
  })

  it('bounds a declared response before consuming or parsing it', async () => {
    const { response, cancelled } = streamedResponse([[123, 125]], {
      headers: { 'content-type': 'application/json', 'content-length': '3' }
    })

    await expect(readPeerJSON(response, 2)).rejects.toThrow('exceeds 2 bytes')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it.each(['-1', '01', '1.5', 'not-a-number'])(
    'rejects non-canonical declared response length %s',
    async declared => {
      const { response, cancelled } = streamedResponse([[123, 125]], {
        headers: { 'content-type': 'application/json', 'content-length': declared }
      })

      await expect(readPeerJSON(response, 10)).rejects.toThrow('exceeds 10 bytes')
      expect(cancelled).toHaveBeenCalledTimes(1)
    }
  )

  it('bounds streamed response bytes across chunks', async () => {
    const { response } = streamedResponse([[123], [34, 120, 34, 58, 49, 125]])

    await expect(readPeerJSON(response, 4)).rejects.toThrow('exceeds 4 bytes')
  })

  it('uses the no-body fallback while enforcing its UTF-8 byte limit', async () => {
    const fallback = {
      body: null,
      headers: new Headers({ 'content-type': 'application/json' }),
      ok: true,
      status: 200,
      text: jest.fn(async () => '"\u00e9"')
    } as unknown as Response

    await expect(readPeerJSON(fallback, 3)).rejects.toThrow('exceeds 3 bytes')
    expect(fallback.text).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an empty body', ''],
    ['malformed JSON', '{']
  ])('rejects %s after bounded reading', async (_label, body) => {
    const response = new Response(body, {
      headers: { 'content-type': 'application/problem+json; charset=utf-8' }
    })
    await expect(readPeerJSON(response)).rejects.toThrow(
      body === '' ? 'empty JSON response' : 'malformed JSON'
    )
  })

  it('accepts chunked UTF-8 JSON without a content-type header', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ message: 'é' }))
    const { response } = streamedResponse(
      [Array.from(encoded.slice(0, 5)), Array.from(encoded.slice(5))],
      {
        headers: {}
      }
    )
    await expect(readPeerJSON(response)).resolves.toEqual({ message: 'é' })
  })

  it.each([
    ['a non-record item', [null]],
    [
      'a duplicate outpoint',
      [
        { txid: hash, outputIndex: 0, score: 0 },
        { txid: hash, outputIndex: 0, score: 1 }
      ]
    ]
  ])('rejects a GASP initial response with %s', (_label, UTXOList) => {
    expect(() => assertGASPInitialResponse({ UTXOList, since: 0 }, 10)).toThrow()
  })

  it.each([
    ['a non-record node', null],
    ['an invalid transaction', { graphID: `${txid}.0`, outputIndex: 0, rawTx: '00' }],
    [
      'invalid optional metadata',
      { graphID: `${txid}.0`, outputIndex: 0, rawTx: txRaw, txMetadata: '0' }
    ],
    ['a non-record inputs map', { graphID: `${txid}.0`, outputIndex: 0, rawTx: txRaw, inputs: [] }],
    [
      'non-record input metadata',
      { graphID: `${txid}.0`, outputIndex: 0, rawTx: txRaw, inputs: { [`${hash}.0`]: null } }
    ]
  ])('rejects a GASP node with %s', (_label, value) => {
    expect(() => assertGASPNode(value, { graphID: `${txid}.0`, txid, outputIndex: 0 })).toThrow()
  })
})
