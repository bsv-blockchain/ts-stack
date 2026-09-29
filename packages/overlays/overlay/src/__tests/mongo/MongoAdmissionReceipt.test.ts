import { Binary } from 'mongodb'
import {
  admissionSemanticDigest,
  getAdmissionHistory,
  type AdmissionIdentity,
  type AdmissionReceipt
} from '../../storage/AdmissionStorage.js'
import {
  copyReceipt,
  decodeMongoAdmissionReceipt,
  encodeMongoAdmissionReceipt,
  retainedMongoAdmission
} from '../../storage/mongo/MongoAdmissionReceipt.js'

const identity: AdmissionIdentity = {
  scope: { network: 'testnet', genesisHash: '11'.repeat(32), nodeId: 'node-a' },
  txid: '22'.repeat(32),
  mode: 'historical',
  contextDigest: '33'.repeat(32),
  topics: [
    { topic: 'tm_one', policyId: 'policy-1' },
    { topic: 'tm_two', policyId: 'policy-2' }
  ]
}
const receipt: AdmissionReceipt = {
  operationId: 'operation-1',
  semanticDigest: admissionSemanticDigest(identity),
  durability: 'atomic-local',
  steak: '{ "tm_one": {"outputsToAdmit":[0]}, "tm_two": {"outputsToAdmit":[1]} }\n',
  indexes: [{ target: 'ls_external', state: 'pending' }],
  propagation: 'not-requested'
}
const binary = (value: unknown): Binary => new Binary(Buffer.from(JSON.stringify(value)))
const stored = () => ({
  ...structuredClone(receipt),
  admissionHistory: { version: 1, identity: structuredClone(identity) }
})

describe('bounded optional Mongo admission provenance', () => {
  test('default writes preserve exact legacy JSON bytes and public receipt shape', () => {
    const bytes = encodeMongoAdmissionReceipt(receipt, identity)
    expect(Buffer.from(bytes.value()).toString()).toBe(JSON.stringify(receipt))
    expect(decodeMongoAdmissionReceipt(bytes)).toEqual({ receipt })
    expect(
      retainedMongoAdmission(bytes, receipt.operationId, receipt.semanticDigest, identity.txid)
    ).toBeUndefined()
    const enriched = encodeMongoAdmissionReceipt(receipt, identity, true)
    const parsed = decodeMongoAdmissionReceipt(enriched)
    expect(parsed).toEqual({ receipt, identity })
    expect(parsed.receipt).not.toHaveProperty('admissionHistory')
    expect(
      retainedMongoAdmission(enriched, receipt.operationId, receipt.semanticDigest, identity.txid)
    ).toEqual({ receipt, identity })
    parsed.identity!.topics[0].topic = 'changed'
    parsed.receipt.indexes[0].target = 'changed'
    expect(decodeMongoAdmissionReceipt(enriched)).toEqual({ receipt, identity })
  })

  test('bounds the combined receipt and provenance without changing the legacy ceiling', () => {
    const big = { ...receipt, steak: JSON.stringify('x'.repeat(1047000)) }
    expect(() => encodeMongoAdmissionReceipt(big, identity)).not.toThrow()
    const largeIdentity = { ...identity, scope: { ...identity.scope, nodeId: 'n'.repeat(2000) } }
    expect(() => encodeMongoAdmissionReceipt(big, largeIdentity, true)).toThrow('too large')
    expect(() => copyReceipt({ ...receipt, steak: JSON.stringify('x'.repeat(1048576)) })).toThrow(
      'too large'
    )
    expect(() => decodeMongoAdmissionReceipt(new Binary(Buffer.alloc(1048577)))).toThrow(
      'too large'
    )
    expect(() => encodeMongoAdmissionReceipt(receipt, identity, 'yes' as never)).toThrow(
      'retention option'
    )
  })

  test('accepts live provenance and empty index lists without changing their meaning', () => {
    const live = { ...identity, mode: 'live' as const }
    const saved = { ...receipt, indexes: [], semanticDigest: admissionSemanticDigest(live) }
    expect(decodeMongoAdmissionReceipt(encodeMongoAdmissionReceipt(saved, live, true))).toEqual({
      receipt: saved,
      identity: live
    })
  })

  test('accepts exactly one MiB and rejects the next byte for both receipt representations', () => {
    for (const retain of [false, true]) {
      const empty = { ...receipt, steak: JSON.stringify('') }
      const reference = retain ? { ...empty, admissionHistory: { version: 1, identity } } : empty
      const available = 1048576 - Buffer.byteLength(JSON.stringify(reference), 'utf8')
      const exact = { ...receipt, steak: JSON.stringify('x'.repeat(available)) }
      const bytes = encodeMongoAdmissionReceipt(exact, identity, retain)
      expect(bytes.length()).toBe(1048576)
      expect(decodeMongoAdmissionReceipt(bytes).receipt).toEqual(exact)
      expect(() =>
        encodeMongoAdmissionReceipt(
          { ...exact, steak: JSON.stringify('x'.repeat(available + 1)) },
          identity,
          retain
        )
      ).toThrow('too large')
    }
  })

  test('rejects malformed UTF-8 even where replacement decoding would produce valid JSON', () => {
    const raw = Buffer.from(JSON.stringify(receipt), 'utf8')
    const index = raw.indexOf('operation-1')
    expect(index).toBeGreaterThan(0)
    raw[index] = 255
    expect(() => JSON.parse(raw.toString('utf8'))).not.toThrow()
    expect(() => decodeMongoAdmissionReceipt(new Binary(raw))).toThrow()
  })

  test.each([
    null,
    [],
    {},
    { version: 2, identity },
    { version: 1, identity, extra: true },
    { version: 1, identity: null },
    { version: 1, identity: { ...identity, extra: true } },
    { version: 1, identity: { ...identity, scope: null } },
    { version: 1, identity: { ...identity, scope: { ...identity.scope, extra: true } } },
    { version: 1, identity: { ...identity, mode: 'unknown' } },
    { version: 1, identity: { ...identity, topics: null } },
    { version: 1, identity: { ...identity, topics: [{}] } },
    { version: 1, identity: { ...identity, topics: [{ topic: 'tm_one', policyId: 42 }] } },
    { version: 1, identity: { ...identity, topics: [identity.topics[0], identity.topics[0]] } },
    { version: 1, identity: { ...identity, txid: 42 } },
    { version: 1, identity: { ...identity, txid: '44'.repeat(32) } }
  ])('rejects malformed or unbound retained metadata %#', admissionHistory => {
    expect(() => decodeMongoAdmissionReceipt(binary({ ...receipt, admissionHistory }))).toThrow()
  })

  test('rejects missing, malformed and operation-mismatched committed receipts', () => {
    expect(() => decodeMongoAdmissionReceipt(undefined)).toThrow('no receipt')
    expect(() => decodeMongoAdmissionReceipt(new Binary(Buffer.from([255])))).toThrow()
    expect(() => decodeMongoAdmissionReceipt(new Binary(Buffer.from('{')))).toThrow()
    const value = binary(stored())
    expect(() =>
      retainedMongoAdmission(value, 'other', receipt.semanticDigest, identity.txid)
    ).toThrow('receipt identity')
    expect(() =>
      retainedMongoAdmission(value, receipt.operationId, '44'.repeat(32), identity.txid)
    ).toThrow('receipt identity')
    expect(() =>
      retainedMongoAdmission(value, receipt.operationId, receipt.semanticDigest, '44'.repeat(32))
    ).toThrow('transaction')
    for (const override of [
      { durability: 'unknown' },
      { steak: 1 },
      { steak: '\ud800' },
      { steak: '{' },
      { indexes: null },
      { indexes: [{ target: '', state: 'pending' }] },
      { indexes: [{ target: 42, state: 'pending' }] },
      { indexes: [{ target: '\ud800', state: 'pending' }] },
      { indexes: [{ target: 'index', state: 'unknown' }] },
      { propagation: 'unknown' }
    ])
      expect(() => copyReceipt({ ...receipt, ...override } as AdmissionReceipt)).toThrow()
    expect(
      copyReceipt({
        ...receipt,
        indexes: [{ target: 'index', state: 'visible' }],
        propagation: 'pending'
      })
    ).toMatchObject({ propagation: 'pending' })
  })

  test('detects history only on an explicit complete admission provider', () => {
    const history = {
      protocol: 'overlay-admission-history-v1',
      read: async () => ({ state: 'unresolved' })
    }
    const admission = {
      protocol: 'overlay-admission-v1',
      commitAdmission() {},
      reconcileAdmission() {},
      history
    }
    expect(getAdmissionHistory({ admission })).toBe(history)
    for (const value of [
      null,
      {},
      { admission: { ...admission, history: undefined } },
      { admission: { ...admission, history: { ...history, protocol: 'other' } } },
      { admission: { ...admission, history: { ...history, read: true } } },
      { admission: { history } }
    ])
      expect(getAdmissionHistory(value)).toBeUndefined()
  })
})
