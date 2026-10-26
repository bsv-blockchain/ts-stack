import { Transaction } from '@bsv/sdk'
import { BASM_ZERO_HASH } from '../BASM.js'
import { BASMRemote } from '../BASMRemote.js'

const topic = 'tm_test'
const blockHash = '11'.repeat(32)
const txRaw = '01000000000000000000'
const txid = Transaction.fromHex(txRaw).id('hex')

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

describe('BASMRemote security boundary', () => {
  let fetchImpl: jest.MockedFunction<typeof fetch>
  let remote: BASMRemote

  beforeEach(() => {
    fetchImpl = jest.fn()
    remote = new BASMRemote('https://peer.example', topic, fetchImpl)
  })

  it('requires HTTPS endpoints without credentials, query data, or fragments', () => {
    expect(() => new BASMRemote('http://localhost:8080', topic, fetchImpl)).toThrow(
      'credential-free HTTPS'
    )
    expect(() => new BASMRemote('https://peer.example/#internal', topic, fetchImpl)).toThrow(
      'credential-free HTTPS'
    )
  })

  it('validates topic anchor tips and binds them to the requested topic', async () => {
    const tip = {
      topic,
      blockHeight: 12,
      blockHash,
      basmRoot: BASM_ZERO_HASH,
      admittedCount: 0,
      tac: BASM_ZERO_HASH
    }
    fetchImpl.mockResolvedValue(jsonResponse(tip))
    await expect(remote.requestTopicAnchorTip()).resolves.toEqual(tip)

    fetchImpl.mockResolvedValue(jsonResponse({ ...tip, topic: 'tm_other' }))
    await expect(remote.requestTopicAnchorTip()).rejects.toThrow('topic mismatch')
  })

  it('bounds and correlates anchor ranges', async () => {
    const anchor = {
      topic,
      blockHeight: 10,
      blockHash,
      basmRoot: BASM_ZERO_HASH,
      admittedCount: 0,
      tac: BASM_ZERO_HASH
    }
    fetchImpl.mockResolvedValue(jsonResponse({ topic, anchors: [anchor] }))
    await expect(remote.requestTopicAnchorRange(10, 11)).resolves.toEqual({
      topic,
      anchors: [anchor]
    })

    fetchImpl.mockResolvedValue(jsonResponse({ topic, anchors: [{ ...anchor, blockHeight: 9 }] }))
    await expect(remote.requestTopicAnchorRange(10, 11)).rejects.toThrow('outside')

    fetchImpl.mockResolvedValue(
      jsonResponse({
        topic,
        anchors: [
          { ...anchor, blockHeight: 11 },
          { ...anchor, blockHeight: 10 }
        ]
      })
    )
    await expect(remote.requestTopicAnchorRange(10, 11)).rejects.toThrow('gap or is unordered')
    await expect(remote.requestTopicAnchorRange(0, 1024)).rejects.toThrow('range exceeds limit')
  })

  it('rejects duplicate or uncorrelated admitted transactions', async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        topic,
        blockHeight: 10,
        blockHash,
        admitted: [
          { txid, blockIndex: 0 },
          { txid, blockIndex: 1 }
        ]
      })
    )
    await expect(remote.requestAdmittedList(10, blockHash)).rejects.toThrow('unique txids')

    fetchImpl.mockResolvedValue(
      jsonResponse({
        topic,
        blockHeight: 10,
        blockHash,
        admitted: [
          { txid, blockIndex: 0 },
          { txid: '22'.repeat(32), blockIndex: 0 }
        ]
      })
    )
    await expect(remote.requestAdmittedList(10, blockHash)).rejects.toThrow('increasing block order')

    fetchImpl.mockResolvedValue(
      jsonResponse({
        topic,
        blockHeight: 11,
        blockHash,
        admitted: []
      })
    )
    await expect(remote.requestAdmittedList(10, blockHash)).rejects.toThrow('topic or height mismatch')
  })

  it('requires compound proofs to account for the exact requested txids', async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        topic,
        blockHeight: 10,
        txids: ['22'.repeat(32)],
        merklePath: '00'
      })
    )
    await expect(remote.requestCompoundMerklePath(10, [txid])).rejects.toThrow('do not match')

    await expect(remote.requestCompoundMerklePath(10, [txid, txid])).rejects.toThrow('Duplicate')
  })

  it('cryptographically binds raw transactions to requested txids and complete accounting', async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({ transactions: [{ txid, rawTx: txRaw }], missing: [] })
    )
    await expect(remote.requestRawTransactions([txid])).resolves.toEqual({
      transactions: [{ txid, rawTx: txRaw }],
      missing: []
    })

    fetchImpl.mockResolvedValue(
      jsonResponse({
        transactions: [{ txid, rawTx: '02000000000000000000' }],
        missing: []
      })
    )
    await expect(remote.requestRawTransactions([txid])).rejects.toThrow('does not match')

    fetchImpl.mockResolvedValue(jsonResponse({ transactions: [], missing: [] }))
    await expect(remote.requestRawTransactions([txid])).rejects.toThrow('omits requested')

    fetchImpl.mockResolvedValue(
      jsonResponse({
        transactions: [
          { txid, rawTx: txRaw },
          { txid: '22'.repeat(32), rawTx: txRaw }
        ],
        missing: []
      })
    )
    await expect(remote.requestRawTransactions([txid])).rejects.toThrow('count exceeds request')
  })

  it('rejects non-JSON content types and truncates peer errors', async () => {
    fetchImpl.mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    )
    await expect(remote.requestTopicAnchorTip()).rejects.toThrow('not JSON')

    fetchImpl.mockResolvedValue(jsonResponse({ message: 'x'.repeat(5000) }, { status: 502 }))
    await expect(remote.requestTopicAnchorTip()).rejects.toThrow('BASM peer returned HTTP 502')
  })
})
