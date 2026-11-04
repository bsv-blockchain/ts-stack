import { describe, expect, it } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import {
  parseProjection,
  parseSourceBatch,
  parseSourceRequest,
  parseVerificationContext,
  runtimeLimits
} from '../src/validation.js'
import type { Projection, SourceBatch, SourceRequest } from '../src/ports.js'
import { chain, context, partition } from './evidence-fixture.js'

const provider = new PrivateKey(1).toPublicKey().toString()
const scope = {
  chain,
  provider,
  service: 'records',
  queryDigest: '01'.repeat(32),
  rulesDigest: '02'.repeat(32),
  access: 'public',
  epoch: 'epoch-0'
}
const limits = runtimeLimits()
const checkpoint = { session: 'session-1', cursor: 'opaque-1', expiresAt: '10', replayUntil: '20' }
function batch(): SourceBatch {
  return {
    provenance: {
      partition,
      generation: '0',
      adapter: 'authenticated',
      scope,
      authentication: 'brc103',
      peer: provider,
      receivedAt: '1'
    },
    groups: [
      {
        id: 'one',
        sequence: '3',
        observations: [
          {
            id: 'withdraw-one',
            scope,
            kind: 'withdraw',
            payload: {
              outpoint: { chain, txid: 'aa'.repeat(32), outputIndex: 0 },
              reason: 'Removed from this catalogue'
            }
          }
        ]
      }
    ],
    coverage: { scope, phase: 'live', status: 'complete', through: '3', highWater: '5' },
    checkpoint
  }
}
function parse(value: unknown): SourceBatch {
  return parseSourceBatch(value, batch().provenance, limits)
}
function projection(): Projection {
  return {
    acceptedRevision: '9',
    generation: '0',
    contextId: 'context-1',
    records: [{ id: 'record', schema: 'urn:records:v1', value: 'AA==' }],
    conflicts: [
      { id: 'record', reason: 'Competing application revisions', observationIds: ['left', 'right'] }
    ],
    unresolved: [
      {
        id: 'record',
        reason: 'Missing predecessor',
        dependencies: [{ chain, txid: 'bb'.repeat(32), outputIndex: 0 }]
      }
    ]
  }
}

describe('application boundary representations', () => {
  it('retains separately scoped conflict and unresolved identities without giving metadata authority', () => {
    const value = projection(),
      parsed = parseProjection(value)
    expect(parsed).toEqual(value)
    value.conflicts[0].observationIds.push('caller mutation')
    expect(parsed.conflicts[0].observationIds).toEqual(['left', 'right'])
  })

  it.each(['records', 'conflicts', 'unresolved'] as const)(
    'rejects duplicated %s identities',
    collection => {
      const value = projection()
      value[collection].push(value[collection][0] as never)
      expect(() => parseProjection(value)).toThrow('Duplicate projection identity')
    }
  )

  it('rejects malformed conflict references, dependencies, schemas and unknown authority fields', () => {
    const value = projection()
    expect(() =>
      parseProjection({ ...value, conflicts: [{ ...value.conflicts[0], observationIds: 'left' }] })
    ).toThrow('conflict observations')
    expect(() =>
      parseProjection({ ...value, unresolved: [{ ...value.unresolved[0], dependencies: null }] })
    ).toThrow('dependencies')
    expect(() =>
      parseProjection({
        ...value,
        unresolved: [
          { ...value.unresolved[0], dependencies: [{ chain, txid: 'bad', outputIndex: 0 }] }
        ]
      })
    ).toThrow()
    expect(() =>
      parseProjection({ ...value, records: [{ ...value.records[0], schema: 'relative/path' }] })
    ).toThrow('absolute IRI')
    expect(() =>
      parseProjection({ ...value, records: [{ ...value.records[0], verified: true }] })
    ).toThrow()
  })

  it('binds authenticated provenance and retains an owned resumable checkpoint', () => {
    const value = structuredClone(batch()),
      parsed = parse(value)
    expect(parsed).toEqual(value)
    value.checkpoint!.cursor = 'changed'
    value.groups[0].observations[0].id = 'changed'
    expect(parsed.checkpoint).toEqual(checkpoint)
    expect(parsed.groups[0].observations[0].id).toBe('withdraw-one')
    const request: SourceRequest = { partition, generation: '0', scope, limits, checkpoint }
    expect(parseSourceRequest(request)).toEqual(request)
  })

  it('rejects authenticated identity mismatches and self-declared authentication modes', () => {
    const value = batch()
    expect(() =>
      parse({
        ...value,
        provenance: { ...value.provenance, peer: new PrivateKey(2).toPublicKey().toString() }
      })
    ).toThrow('identity mismatch')
    expect(() =>
      parse({ ...value, provenance: { ...value.provenance, authentication: 'trusted' } })
    ).toThrow('authentication')
    expect(() =>
      parse({ ...value, provenance: { ...value.provenance, adapter: 'another-adapter' } })
    ).toThrow('configured session')
    expect(() =>
      parse({
        ...value,
        coverage: { ...value.coverage, scope: { ...scope, access: 'another-account' } }
      })
    ).toThrow('scope mismatch')
  })

  it('requires ordered live groups within the acknowledged watermark', () => {
    const value = batch()
    const second = { id: 'two', sequence: '2', observations: [] }
    expect(() => parse({ ...value, groups: [...value.groups, second] })).toThrow(
      'sequence reversed'
    )
    expect(() => parse({ ...value, groups: [{ ...value.groups[0], sequence: '4' }] })).toThrow(
      'beyond watermark'
    )
    expect(() => parse({ ...value, coverage: { ...value.coverage, through: '6' } })).toThrow(
      'watermark'
    )
    expect(() =>
      parse({ ...value, coverage: { ...value.coverage, phase: 'snapshot', through: '2' } })
    ).toThrow('Snapshot group watermark')
    expect(() => parse({ ...value, coverage: { ...value.coverage, phase: 'finite' } })).toThrow(
      'Finite sequence'
    )
    expect(
      parse({
        ...value,
        groups: [...value.groups, { ...second, sequence: '4' }],
        coverage: { ...value.coverage, through: '4' }
      }).groups
    ).toHaveLength(2)
  })

  it('rejects duplicate observation identities across groups and enforces an explicit observation budget', () => {
    const value = batch()
    expect(() =>
      parse({
        ...value,
        groups: [...value.groups, { ...value.groups[0], id: 'two', sequence: '4' }],
        coverage: { ...value.coverage, through: '4' }
      })
    ).toThrow('identity mismatch')
    const two = {
      ...value,
      groups: [
        {
          ...value.groups[0],
          observations: [
            value.groups[0].observations[0],
            { ...value.groups[0].observations[0], id: 'different' }
          ]
        }
      ]
    }
    expect(() =>
      parseSourceBatch(two, value.provenance, runtimeLimits({ observations: 1 }))
    ).toThrow('observation limit')
  })

  it('enforces replay expiry order on both requests and returned checkpoints', () => {
    const malformed = { ...checkpoint, expiresAt: '21' }
    expect(() => parse({ ...batch(), checkpoint: malformed })).toThrow('replay deadline')
    expect(() =>
      parseSourceRequest({ partition, generation: '0', scope, limits, checkpoint: malformed })
    ).toThrow('replay deadline')
    expect(() =>
      parse({ ...batch(), checkpoint: { ...checkpoint, unrelatedCursor: 'second' } })
    ).toThrow()
    expect(
      parse({ ...batch(), checkpoint: { ...checkpoint, expiresAt: '20' } }).checkpoint?.expiresAt
    ).toBe('20')
  })

  it('requires positive bounded resources and a future verification deadline', () => {
    expect(() => runtimeLimits({ batchBytes: 1024, pendingBytes: 512 })).toThrow(
      'Inconsistent runtime'
    )
    expect(() => runtimeLimits({ verificationConcurrency: 0 })).toThrow('runtime resource')
    const value = context()
    expect(() =>
      parseVerificationContext({ ...value, limits: { ...value.limits, deadline: value.now } })
    ).toThrow('deadline')
    expect(() =>
      parseVerificationContext({ ...value, limits: { ...value.limits, transactions: 0 } })
    ).toThrow('resource bounds')
  })
})
