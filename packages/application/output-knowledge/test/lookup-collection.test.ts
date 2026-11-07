import { describe, expect, it } from '@jest/globals'
import {
  outputPacketDigest,
  PrivateKey,
  type OutputJSONObject,
  type OutputLookupOpen
} from '@bsv/sdk'
import {
  CollectionOutputQueryPolicy,
  collectionOutputIndexKey
} from '../src/lookup/CollectionOutputQueryPolicy.js'
import { LookupQueryRegistry } from '../src/lookup/LookupQueryRegistry.js'
import type { LookupIndexRow } from '../src/lookup/LookupIndexCodec.js'
import { chain, corpus } from './evidence-fixture.js'

const identity = new PrivateKey(2).toPublicKey().toString()
const stranger = new PrivateKey(3).toPublicKey().toString()
const evidence = {
  txid: corpus.transactions[corpus.anchors[0].name].txid,
  outputIndex: 0,
  beef: corpus.anchors[0].beef
}
const row: LookupIndexRow = {
  key: collectionOutputIndexKey(evidence),
  revision: '1',
  value: {
    expiresAt: null,
    data: { collection: 'documents', audience: 'public', output: { evidence } }
  }
}
function view(principal: string | null = null, collection = 'documents') {
  const registry = new LookupQueryRegistry([
    { policy: new CollectionOutputQueryPolicy(), parameters: {} }
  ])
  const open: OutputLookupOpen = {
    version: 1,
    requestId: '01'.repeat(32),
    service: 'records',
    query: { collection },
    limits: { maxBytes: 4194304, maxObservations: 1024, waitMs: 0 }
  }
  return registry.prepare(
    open,
    {
      chain,
      provider: 'https://lookup.example.test',
      service: open.service,
      rulesDigest: registry.describe()[0].rulesDigest,
      queryDigest: outputPacketDigest('lookup-query', { service: open.service, query: open.query }),
      epoch: 'test',
      access: principal ?? 'public'
    },
    principal
  )
}
function changed(data: OutputJSONObject): LookupIndexRow {
  return { ...row, revision: '2', value: { ...row.value, data: { ...row.value.data, ...data } } }
}
const snapshot = (input = row, principal: string | null = null) =>
  view(principal).snapshot(input, '01'.repeat(32), '2', '1000')

describe('reference collection output selection', () => {
  it('selects a real BEEF by exact collection while preserving its outpoint and opaque context', () => {
    const input = changed({
      output: { evidence, context: { schema: 'urn:example:display:1', bytes: 'YQ==' } }
    })
    const selected = snapshot(input)!
    expect(selected.observations).toHaveLength(1)
    expect(selected.observations[0]).toMatchObject({
      kind: 'output',
      payload: input.value.data.output
    })
    expect(view(null, 'another').snapshot(input, '01'.repeat(32), '2', '1000')).toBeNull()
    expect(input.value.data.output).toEqual({
      evidence,
      context: { schema: 'urn:example:display:1', bytes: 'YQ==' }
    })
  })

  it('keeps private context out of anonymous and unrelated reader snapshots', () => {
    const input = changed({
      audience: [identity],
      output: { evidence, context: { schema: 'urn:example:private:1', bytes: 'cHJpdmF0ZQ==' } }
    })
    expect(snapshot(input)).toBeNull()
    expect(snapshot(input, stranger)).toBeNull()
    expect(snapshot(input, identity)!.observations[0]).toMatchObject({
      kind: 'output',
      payload: input.value.data.output
    })
    expect(snapshot(changed({ audience: [] }), identity)).toBeNull()
  })

  it('keeps replacement withdrawal and new output in one coherent group without asserting a spend', () => {
    const secondEvidence = { ...evidence, outputIndex: 1 }
    const replacement: LookupIndexRow = {
      ...changed({ output: { evidence: secondEvidence } }),
      key: collectionOutputIndexKey(secondEvidence)
    }
    const result = view().live({
      sequence: '2',
      recordedAt: '1000',
      event: {},
      changes: [
        { key: row.key, before: row, after: null },
        { key: replacement.key, before: null, after: replacement }
      ]
    })!
    expect(result.observations.map(value => value.kind)).toEqual(['withdraw', 'output'])
    expect(result.observations[0].payload).toEqual({
      outpoint: { chain, txid: evidence.txid, outputIndex: 0 },
      reason: 'membership-changed'
    })
  })

  it('represents collection and audience membership changes without treating absence as Bitcoin spend', () => {
    for (const after of [
      changed({ collection: 'another' }),
      changed({ audience: [identity] }),
      null
    ]) {
      const result = view().live({
        sequence: '2',
        recordedAt: '1000',
        event: {},
        changes: [{ key: row.key, before: row, after }]
      })!
      expect(result.observations.map(value => value.kind)).toEqual(['withdraw'])
    }
    const entering = view(identity).live({
      sequence: '2',
      recordedAt: '1000',
      event: {},
      changes: [
        {
          key: row.key,
          before: { ...row, value: { ...row.value, data: { ...row.value.data, audience: [] } } },
          after: changed({ audience: [identity] })
        }
      ]
    })!
    expect(entering.observations.map(value => value.kind)).toEqual(['output'])
  })

  it('emits updated context for the same output and an ordered ordinary-expiry withdrawal', () => {
    const after = changed({
      output: { evidence, context: { schema: 'urn:example:display:1', bytes: 'Yg==' } }
    })
    const next = view().live({
      sequence: '2',
      recordedAt: '1000',
      event: {},
      changes: [{ key: row.key, before: row, after }]
    })!
    expect(next.observations).toHaveLength(1)
    expect(next.observations[0]).toMatchObject({ kind: 'output', payload: after.value.data.output })
    const expired = view().live({
      sequence: '3',
      recordedAt: '1001',
      event: { type: 'output-lookup-row-expired/1' },
      changes: [{ key: row.key, before: after, after: null }]
    })!
    expect(expired.observations[0]).toMatchObject({
      kind: 'withdraw',
      payload: { reason: 'expired' }
    })
    expect(view().live({ sequence: '3', recordedAt: '1001', event: {}, changes: [] })).toBeNull()
  })

  it.each<OutputJSONObject>([
    { audience: 'everyone' },
    { audience: [identity, identity] },
    { audience: [identity, stranger].sort().reverse() },
    { audience: Array<string>(257).fill(identity) },
    { output: { evidence: { ...evidence, outputIndex: 1 } } },
    { output: { evidence, context: { schema: 'urn:example:context:1', bytes: 'not base64' } } },
    { unexpected: true }
  ])('rejects ambiguous or malformed reference rows (%#)', data => {
    expect(() => snapshot(changed(data))).toThrow()
  })

  it('requires fixed empty rule parameters and an exact collection query', () => {
    const policy = new CollectionOutputQueryPolicy()
    expect(() => policy.parameters({ ignored: true })).toThrow()
    expect(() => policy.query({ collection: 'documents', ignored: true })).toThrow()
    expect(() => policy.query({ collection: '' })).toThrow()
    expect(collectionOutputIndexKey({ txid: '01'.repeat(32), outputIndex: 0xffffffff })).toBe(
      '01'.repeat(32) + 'ffffffff'
    )
    expect(collectionOutputIndexKey({ txid: '01'.repeat(32), outputIndex: 10 })).toBe(
      '01'.repeat(32) + '0000000a'
    )
    expect(() =>
      collectionOutputIndexKey({ txid: '01'.repeat(32), outputIndex: 0x100000000 })
    ).toThrow()
  })
})

it('accepts a canonical multi-recipient audience and exactly 256 recipients', () => {
  const recipients = Array.from({ length: 257 }, (_, i) =>
    new PrivateKey(i + 1).toPublicKey().toString()
  ).sort()
  const permitted = recipients.slice(0, 256)
  const input = changed({ audience: permitted })
  expect(snapshot(input, permitted[0])!.observations).toHaveLength(1)
  expect(snapshot(input, permitted[255])!.observations).toHaveLength(1)
  expect(snapshot(input, recipients[256])).toBeNull()
  expect(snapshot(input, null)).toBeNull()
  expect(() => snapshot(changed({ audience: recipients }))).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Collection audience must be public or at most 256 identities'
    })
  )
  expect(() => snapshot(changed({ audience: [identity, identity] }))).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Collection audience must be sorted and unique'
    })
  )
  expect(() => snapshot(changed({ audience: 'everyone' }))).toThrow(
    expect.objectContaining({ code: 'invalid' })
  )
})

it('rejects a selected row whose key names another outpoint with a classified error', () => {
  expect(() =>
    snapshot(changed({ output: { evidence: { ...evidence, outputIndex: 2 } } }))
  ).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Collection row key differs from its outpoint'
    })
  )
})
