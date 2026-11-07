import { describe, it, expect } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON, outputLookupCheckpoint, type OutputLookupBatch } from '@bsv/sdk'
import {
  LookupSourceFraming,
  lookupSourceCheckpoint,
  type LookupSourceFrame
} from '../src/sources/LookupSourceFraming.js'
import { runtimeLimits } from '../src/validation.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const scope = {
  chain: { network: 'test', genesisHash: '01'.repeat(32) },
  provider: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  service: 'records',
  queryDigest: '02'.repeat(32),
  rulesDigest: '03'.repeat(32),
  access: 'public',
  epoch: 'epoch-1'
}
function binding(): LookupSourceFrame {
  const { access: _access, epoch: _epoch, ...query } = structuredClone(scope)
  return {
    id: 'catalogue',
    partition: { application: 'demo', account: 'alice', access: 'private' },
    generation: '7',
    limits: runtimeLimits(),
    scope: query,
    authentication: 'brc103'
  }
}
function packet(): OutputLookupBatch {
  return {
    version: 1,
    session: 'session',
    scope: structuredClone(scope),
    phase: 'snapshot',
    groups: [
      {
        id: 'snapshot:group',
        sequence: '5',
        observations: [
          {
            id: 'snapshot:observation',
            scope: structuredClone(scope),
            kind: 'withdraw',
            payload: {
              outpoint: {
                chain: structuredClone(scope.chain),
                txid: '04'.repeat(32),
                outputIndex: 0
              },
              reason: 'removed'
            }
          }
        ]
      }
    ],
    cursor: 'cursor',
    snapshotComplete: false,
    through: '5',
    highWater: '6',
    expiresAt: '200',
    replayUntil: '300',
    limits: { maxBytes: 65536, maxObservations: 1024, waitMs: 0 }
  }
}
const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(canonicalOutputJSON(value)).length

describe('lookup receipt framing', () => {
  it('rejects unknown authentication and missing checkpoint metadata', () => {
    expect(
      () =>
        new LookupSourceFraming({
          ...binding(),
          authentication: 'unknown'
        } as unknown as LookupSourceFrame)
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: expect.stringContaining('authentication mode')
      })
    )
    expect(
      () =>
        new LookupSourceFraming({
          ...binding(),
          scope: { ...binding().scope, provider: 'https://example.test' }
        })
    ).toThrow()
    const framing = new LookupSourceFraming(binding())
    const batch = framing.fromLookup(packet(), 65536, '100')
    delete batch.checkpoint
    expect(() => lookupSourceCheckpoint(batch)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: expect.stringContaining('checkpoint metadata')
      })
    )
    const reset = framing.reset(outputLookupCheckpoint(packet()), '200')
    expect(reset.coverage.status).toBe('reset-required')
    expect(reset.checkpoint).toBeUndefined()
    delete reset.coverage.highWater
    expect(() => framing.parse(reset)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: expect.stringContaining('local continuity reset')
      })
    )
  })
  it.each([
    ['snapshot', false, '5', '6', 'partial'],
    ['snapshot', true, '5', '6', 'complete'],
    ['live', true, '5', '6', 'partial'],
    ['live', true, '6', '6', 'complete']
  ] as const)(
    'preserves %s boundary and completion %s',
    (phase, complete, through, highWater, status) => {
      const framing = new LookupSourceFraming(binding())
      const wire = { ...packet(), phase, snapshotComplete: complete, through, highWater }
      const batch = framing.fromLookup(wire, 65536, '100')
      expect(batch.coverage).toEqual({ scope, phase, status, through, highWater })
      expect(batch.provenance).toEqual({
        partition: binding().partition,
        adapter: 'catalogue',
        generation: '7',
        scope,
        authentication: 'brc103',
        peer: scope.provider,
        receivedAt: '100'
      })
      expect(batch.groups).toEqual(wire.groups)
      expect(lookupSourceCheckpoint(batch)).toEqual(outputLookupCheckpoint(wire))
      expect(framing.parse(batch)).toEqual(batch)
    }
  )

  it('owns caller configuration, returned receipt and sizing templates independently', () => {
    const configured = binding()
    const framing = new LookupSourceFraming(configured)
    configured.partition.account = 'other'
    configured.scope.chain.network = 'other'
    const wire = packet()
    const received = framing.fromLookup(wire, 65536, '100')
    received.provenance.partition.account = 'changed'
    received.groups[0].observations.length = 0
    const envelope = framing.maximumEnvelope()
    envelope.provenance.partition.account = 'other'
    envelope.provenance.scope.chain.network = 'other'
    expect(framing.fromLookup(wire, 65536, '100').groups[0].observations).toHaveLength(1)
    expect(framing.maximumEnvelope().provenance.partition.account).toBe('alice')
    expect(framing.maximumEnvelope().provenance.scope.chain.network).toBe('test')
  })

  it.each(['provider', 'service', 'queryDigest', 'rulesDigest'] as const)(
    'rejects a changed %s before making a receipt',
    field => {
      const wire = packet()
      wire.groups = []
      wire.scope[field] = field.endsWith('Digest') ? '09'.repeat(32) : 'changed'
      expect(() => new LookupSourceFraming(binding()).fromLookup(wire, 65536, '100')).toThrow(
        'query identity changed'
      )
    }
  )

  it('rejects changed chain identity and unsupported critical semantics', () => {
    const wire = packet()
    wire.groups = []
    wire.scope.chain.network = 'another'
    const framing = new LookupSourceFraming(binding())
    expect(() => framing.fromLookup(wire, 65536, '100')).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: expect.stringContaining('query identity changed')
      })
    )
    expect(() =>
      framing.fromLookup(
        {
          ...packet(),
          extensions: { 'https://example.invalid/unknown': {} },
          critical: ['https://example.invalid/unknown']
        },
        65536,
        '100'
      )
    ).toThrow()
  })

  it('rejects missing, mismatched and non-lookup persisted boundaries', () => {
    const framing = new LookupSourceFraming(binding())
    const source = framing.fromLookup(packet(), 65536, '100')
    expect(() => framing.parse({})).toThrow()
    expect(() => framing.parse({ ...source, checkpoint: undefined })).toThrow()
    expect(() =>
      framing.parse({
        ...source,
        provenance: { ...source.provenance, authentication: 'configured-transport' }
      })
    ).toThrow()
    expect(() =>
      framing.parse({ ...source, provenance: { ...source.provenance, peer: 'different' } })
    ).toThrow()
    expect(() =>
      framing.parse({ ...source, coverage: { ...source.coverage, phase: 'finite' } })
    ).toThrow()
    expect(() =>
      framing.parse({ ...source, coverage: { ...source.coverage, status: 'reset-required' } })
    ).toThrow()
    expect(() =>
      framing.parse({ ...source, coverage: { ...source.coverage, through: undefined } })
    ).toThrow()
    expect(() =>
      framing.parse({
        ...source,
        coverage: { ...source.coverage, phase: 'live', status: 'complete' }
      })
    ).toThrow(
      expect.objectContaining({ code: 'invalid', message: expect.stringContaining('watermark') })
    )
    expect(() =>
      framing.parse({
        ...source,
        provenance: { ...source.provenance, peer: '03' + scope.provider.slice(2) }
      })
    ).toThrow('provider identity mismatch')
    expect(() =>
      framing.parse({
        ...source,
        groups: [],
        coverage: { ...source.coverage, phase: 'finite' }
      })
    ).toThrow()
    const reset = framing.reset(outputLookupCheckpoint(packet()), '200')
    expect(() => framing.parse({ ...reset, groups: source.groups })).toThrow(
      'local continuity reset'
    )
    delete reset.coverage.through
    expect(() => framing.parse(reset)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: expect.stringContaining('local continuity reset')
      })
    )
  })

  it('charges source overhead separately from a valid wire allowance', () => {
    const config = binding()
    const generous = new LookupSourceFraming(config)
    const wire = packet()
    const original = generous.fromLookup(wire, 65536, '100')
    config.limits.batchBytes = encodedBytes(original) - 1
    const constrained = new LookupSourceFraming(config)
    expect(() => constrained.fromLookup(wire, 65536, '100')).toThrow()
    config.limits.batchBytes = 1
    expect(() => new LookupSourceFraming(config).maximumWireBytes()).toThrow(
      expect.objectContaining({
        code: 'limited',
        message: expect.stringContaining('Source capacity')
      })
    )
  })

  it('bounds valid maximally escaped provider metadata before scheduling a request', () => {
    const framing = new LookupSourceFraming(binding())
    const maximum = framing.maximumEnvelope()
    expect(framing.parse(maximum)).toEqual(maximum)
    const wire = packet()
    wire.groups = []
    wire.scope = maximum.provenance.scope
    wire.session = maximum.checkpoint!.session
    wire.cursor = maximum.checkpoint!.cursor
    wire.through = wire.highWater = wire.expiresAt = wire.replayUntil = '18446744073709551615'
    wire.snapshotComplete = true
    const allowance = framing.maximumWireBytes()
    expect(allowance).toBe(binding().limits.batchBytes - encodedBytes(maximum))
    expect(allowance).toBeGreaterThan(0)
    const source = framing.fromLookup(wire, 65536, '18446744073709551615')
    expect(encodedBytes(source)).toBeLessThanOrEqual(encodedBytes(maximum))
    expect(encodedBytes(lookupSourceCheckpoint(source))).toBeGreaterThan(16384)
    const exact = binding()
    exact.limits.batchBytes = encodedBytes(maximum) + 1
    expect(new LookupSourceFraming(exact).maximumWireBytes()).toBe(1)
  })

  it('preserves the framing inequality across escaped metadata and both phases', () => {
    const text = fc
      .array(fc.constantFrom('\u0000', '\n', '"', '\\', 'é', '😀', 'x'), {
        minLength: 1,
        maxLength: 128
      })
      .map(parts => parts.join(''))
    const framing = new LookupSourceFraming(binding())
    fc.assert(
      fc.property(text, text, text, text, fc.boolean(), (access, epoch, session, cursor, live) => {
        const wire = packet()
        wire.groups = []
        wire.scope = { ...wire.scope, access, epoch }
        wire.session = session
        wire.cursor = cursor
        wire.phase = live ? 'live' : 'snapshot'
        wire.snapshotComplete = true
        const source = framing.fromLookup(wire, 65536, '100')
        expect(encodedBytes(source)).toBeLessThanOrEqual(
          encodedBytes(wire) + encodedBytes(framing.maximumEnvelope())
        )
        expect(lookupSourceCheckpoint(source)).toEqual(outputLookupCheckpoint(wire))
      })
    )
  })
})
