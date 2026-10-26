import { Transaction, Utils, type LookupAnswer } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { sampleBeef } from '../../test/support/transactions.js'
import {
  canonicalizeLookupAnswer,
  compareCodePoints,
  contentHash,
  decodeMessageList,
  decodeOutpointList,
  encodeMessageList,
  encodeOutpointList,
  rebuildLookupAnswer
} from './payloads.js'

describe('contentHash', () => {
  it('is the SHA-256 of the payload bytes in hex', () => {
    expect(contentHash(Utils.toArray('[]', 'utf8'))).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
    )
  })
})

describe('message-list', () => {
  it('hashes the empty list as []', () => {
    expect(Utils.toUTF8(encodeMessageList([]))).toBe('[]')
  })

  it('sorts by messageId code point and fixes the key order', () => {
    const payload = encodeMessageList([
      { body: 'second', sender: 'b', messageId: 'b' },
      { sender: 'a', messageId: 'a', body: 'first "quoted"' }
    ])
    expect(Utils.toUTF8(payload)).toBe(
      '[{"messageId":"a","sender":"a","body":"first \\"quoted\\""},' +
        '{"messageId":"b","sender":"b","body":"second"}]'
    )
    expect(decodeMessageList(payload)).toEqual([
      { messageId: 'a', sender: 'a', body: 'first "quoted"' },
      { messageId: 'b', sender: 'b', body: 'second' }
    ])
  })

  it('orders astral characters after the BMP, unlike UTF-16 comparison', () => {
    const astral = '\u{1F600}'
    const bmp = '�'
    expect(compareCodePoints(astral, bmp)).toBeGreaterThan(0)
    expect(astral < bmp).toBe(true)
  })

  it('rejects malformed payloads', () => {
    expect(() => decodeMessageList(Utils.toArray('{"a":1}', 'utf8'))).toThrow(TypeError)
    expect(() => decodeMessageList(Utils.toArray('[{"messageId":1}]', 'utf8'))).toThrow(TypeError)
  })
})

describe('overlay-lookup', () => {
  const a = 'aa'.repeat(32)
  const b = 'bb'.repeat(32)

  it('sorts by txid, output index, then context and drops exact duplicates', () => {
    const payload = encodeOutpointList([
      { txid: b, outputIndex: 0 },
      { txid: a, outputIndex: 2, context: [9] },
      { txid: a, outputIndex: 2, context: [1] },
      { txid: a, outputIndex: 1 },
      { txid: b, outputIndex: 0 }
    ])
    expect(decodeOutpointList(payload)).toEqual([
      { txid: a, outputIndex: 1 },
      { txid: a, outputIndex: 2, context: [1] },
      { txid: a, outputIndex: 2, context: [9] },
      { txid: b, outputIndex: 0 }
    ])
  })

  it('treats an empty context as absent', () => {
    expect(encodeOutpointList([{ txid: a, outputIndex: 0, context: [] }])).toEqual(
      encodeOutpointList([{ txid: a, outputIndex: 0 }])
    )
  })

  it('rejects truncated input and trailing bytes', () => {
    const payload = encodeOutpointList([{ txid: a, outputIndex: 0 }])
    expect(() => decodeOutpointList(payload.slice(0, -1))).toThrow(TypeError)
    expect(() => decodeOutpointList([...payload, 0])).toThrow(TypeError)
  })

  it('rejects an oversized 64-bit varint as TypeError, not the readers plain Error', () => {
    // 0xff prefix + 8 LE bytes = 0x7fffffffffffffff, which exceeds 2^53 and makes
    // Utils.Reader.readVarIntNum() throw a plain Error rather than a TypeError.
    const oversizedVarint = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]
    const txidBytes = Array.from({ length: 32 }, () => 0xaa)

    // Position 1: the outpoint count itself.
    expect(() => decodeOutpointList(oversizedVarint)).toThrow(TypeError)

    // Position 2: outputIndex, after a valid count and txid.
    expect(() => decodeOutpointList([0x01, ...txidBytes, ...oversizedVarint])).toThrow(TypeError)

    // Position 3: contextLength, after a valid count, txid, and outputIndex.
    expect(() => decodeOutpointList([0x01, ...txidBytes, 0x00, ...oversizedVarint])).toThrow(
      TypeError
    )
  })

  it('hashes the same for any output order and rebuilds a usable answer', () => {
    const first = sampleBeef(1)
    const second = sampleBeef(2)
    const forward: LookupAnswer = {
      type: 'output-list',
      outputs: [
        { beef: first.beef, outputIndex: 0 },
        { beef: second.beef, outputIndex: 0, context: [7] }
      ]
    }
    const backward: LookupAnswer = { type: 'output-list', outputs: [...forward.outputs].reverse() }
    const canonical = canonicalizeLookupAnswer(forward)
    expect(canonicalizeLookupAnswer(backward).payload).toEqual(canonical.payload)

    const rebuilt = rebuildLookupAnswer(canonical.payload, canonical.supplement)
    expect(rebuilt.type).toBe('output-list')
    const txids = rebuilt.outputs.map(output => Transaction.fromBEEF(output.beef).id('hex'))
    expect(txids).toEqual([first.txid, second.txid].sort())
    expect(rebuilt.outputs.find(output => output.context !== undefined)?.context).toEqual([7])
  })

  it('refuses to rebuild when the BEEF lacks a listed transaction', () => {
    const first = sampleBeef(1)
    const payload = encodeOutpointList([{ txid: 'cc'.repeat(32), outputIndex: 0 }])
    expect(() => rebuildLookupAnswer(payload, first.beef)).toThrow(TypeError)
  })

  it('refuses to rebuild when the output index does not exist', () => {
    const first = sampleBeef(1)
    const payload = encodeOutpointList([{ txid: first.txid, outputIndex: 5 }])
    expect(() => rebuildLookupAnswer(payload, first.beef)).toThrow(TypeError)
  })

  it('re-canonicalizes a rebuilt answer (Atomic BEEF per output) to the identical payload', () => {
    const first = sampleBeef(1)
    const second = sampleBeef(2)
    const answer: LookupAnswer = {
      type: 'output-list',
      outputs: [
        { beef: first.beef, outputIndex: 0 },
        { beef: second.beef, outputIndex: 0, context: [7] }
      ]
    }
    const canonical = canonicalizeLookupAnswer(answer)
    const rebuilt = rebuildLookupAnswer(canonical.payload, canonical.supplement)
    const recanonicalized = canonicalizeLookupAnswer(rebuilt)
    expect(recanonicalized.payload).toEqual(canonical.payload)
    expect(contentHash(recanonicalized.payload)).toBe(contentHash(canonical.payload))
  })
})
