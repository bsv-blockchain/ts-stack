import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Knex } from 'knex'
import { KnexStorage } from '../storage/knex/KnexStorage.js'
import {
  admissionSemanticDigest,
  getAdmissionStorage,
  isReplaySafeProjection,
  parseStorageOutputIndex,
  parseStorageUint64,
  type AdmissionIdentity
} from '../storage/AdmissionStorage.js'
import {
  canAdvanceGaspCursor,
  isRecoveryLeaseCurrent,
  type GaspCursorEvidence,
  type RecoveryLease
} from '../storage/RecoveryContract.js'

// This exact language-neutral fixture is also consumed by standalone Go tests.
const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../specs/overlay/fixtures/persistence-v1.json'),
    'utf8'
  )
) as {
  identities: Array<{ name: string; identity: AdmissionIdentity; digest: string }>
  uint64: Array<{ value: string; valid: boolean }>
  outputIndices: Array<{ value: string; valid: boolean }>
  cursors: Array<{ name: string; evidence: GaspCursorEvidence; advance: boolean }>
  leases: Array<{
    name: string
    expected: RecoveryLease
    current: RecoveryLease
    nowMs: string
    valid: boolean
  }>
}

describe('S01 portable persistence contract', () => {
  test.each(fixture.identities)('semantic digest: $name', ({ identity, digest }) => {
    expect(admissionSemanticDigest(identity)).toBe(digest)
    expect(admissionSemanticDigest({ ...identity, topics: [...identity.topics].reverse() })).toBe(
      digest
    )
  })

  test('semantic identity binds all immutable admission inputs', () => {
    const original = fixture.identities[0].identity
    const originalDigest = admissionSemanticDigest(original)
    const variants: AdmissionIdentity[] = [
      { ...original, txid: '2'.repeat(64) },
      { ...original, mode: 'historical' },
      { ...original, contextDigest: '3'.repeat(64) },
      { ...original, scope: { ...original.scope, network: 'main' } },
      { ...original, scope: { ...original.scope, genesisHash: '4'.repeat(64) } },
      { ...original, scope: { ...original.scope, nodeId: 'node-b' } },
      { ...original, topics: [{ topic: 'tm_a', policyId: 'different-policy' }] }
    ]
    for (const identity of variants)
      expect(admissionSemanticDigest(identity)).not.toBe(originalDigest)
  })

  test('rejects duplicate topics, empty identity and ambiguous Unicode before hashing', () => {
    const original = fixture.identities[0].identity
    for (const topics of [
      [],
      [original.topics[0], original.topics[0]],
      [{ topic: '\ud800', policyId: 'p' }],
      [{ topic: 't', policyId: '' }]
    ]) {
      expect(() => admissionSemanticDigest({ ...original, topics })).toThrow()
    }
    expect(() => admissionSemanticDigest({ ...original, txid: 'A'.repeat(64) })).toThrow(
      'Invalid admission hash'
    )
    expect(() =>
      admissionSemanticDigest({ ...original, scope: { ...original.scope, genesisHash: 'invalid' } })
    ).toThrow()
    expect(() => admissionSemanticDigest({ ...original, contextDigest: 'invalid' })).toThrow()
    expect(() =>
      admissionSemanticDigest({ ...original, mode: 'invalid' as AdmissionIdentity['mode'] })
    ).toThrow('Invalid admission mode')
  })

  test.each(fixture.uint64)('exact uint64: "$value"', ({ value, valid }) => {
    if (valid) expect(parseStorageUint64(value).toString()).toBe(value)
    else expect(() => parseStorageUint64(value)).toThrow('Invalid storage uint64')
  })

  test('does not coerce a JavaScript number at a runtime boundary', () => {
    expect(() => parseStorageUint64(1 as unknown as string)).toThrow()
  })

  test.each(fixture.outputIndices)('exact output index: "$value"', ({ value, valid }) => {
    if (valid) expect(String(parseStorageOutputIndex(value))).toBe(value)
    else expect(() => parseStorageOutputIndex(value)).toThrow()
  })

  test.each(fixture.cursors)('cursor publication: $name', ({ evidence, advance }) => {
    expect(canAdvanceGaspCursor(evidence)).toBe(advance)
  })

  test.each(fixture.leases)('recovery fence: $name', ({ expected, current, nowMs, valid }) => {
    expect(isRecoveryLeaseCurrent(expected, current, nowMs)).toBe(valid)
  })

  test('fences topic, job and genesis as well as node/peer and generations', () => {
    const original = fixture.leases[0].current
    for (const current of [
      { ...original, topic: 'tm_other' },
      { ...original, jobId: 'other-job' },
      { ...original, scope: { ...original.scope, genesisHash: 'a'.repeat(64) } },
      { ...original, scope: { ...original.scope, network: 'other-network' } }
    ])
      expect(isRecoveryLeaseCurrent(original, current, '999')).toBe(false)
    expect(() =>
      isRecoveryLeaseCurrent(original, { ...original, chainEpoch: '01' }, '999')
    ).toThrow()
  })

  test('legacy Knex CRUD cannot advertise atomic admission', () => {
    const knex = jest.fn() as unknown as Knex
    expect(getAdmissionStorage(new KnexStorage(knex))).toBeUndefined()
    expect(knex).not.toHaveBeenCalled()
  })

  test('requires explicit v1 plus both commit and reconciliation functions', () => {
    const admission = {
      protocol: 'overlay-admission-v1',
      commitAdmission: jest.fn(),
      reconcileAdmission: jest.fn()
    }
    for (const storage of [
      null,
      undefined,
      1,
      {},
      { admission: null },
      { admission: {} },
      { admission: { ...admission, protocol: 'overlay-admission-v2' } },
      { admission: { ...admission, commitAdmission: undefined } },
      { admission: { ...admission, reconcileAdmission: undefined } }
    ]) {
      expect(getAdmissionStorage(storage)).toBeUndefined()
    }
    expect(getAdmissionStorage({ admission })).toBe(admission)
    expect(admission.commitAdmission).not.toHaveBeenCalled()
  })

  test('legacy lookup callbacks never imply replay or reconciliation safety', () => {
    const projection = {
      protocol: 'overlay-projection-v1',
      applyEvent: jest.fn(),
      reconcile: jest.fn()
    }
    expect(isReplaySafeProjection(projection)).toBe(true)
    for (const value of [
      null,
      {},
      { outputAdmittedByTopic: jest.fn() },
      { ...projection, protocol: 'other' },
      { ...projection, applyEvent: null },
      { ...projection, reconcile: undefined }
    ])
      expect(isReplaySafeProjection(value)).toBe(false)
  })
})
