import { describe, it, expect } from '@jest/globals'
import fc from 'fast-check'
import {
  PrivateKey,
  OUTPUT_LOOKUP_PROFILE,
  signOutputPacket,
  retainOutputCapability,
  outputPacketDigest,
  canonicalOutputJSON,
  type OutputLookupBatch
} from '@bsv/sdk'
import { LookupSourceFraming, lookupSourceCheckpoint } from '../src/sources/LookupSourceFraming.js'
import {
  LookupSourceStateCodec,
  type LookupSourceOriginal
} from '../src/sources/LookupSourceState.js'
import { runtimeLimits } from '../src/validation.js'
import { MemoryJournal } from '../src/storage/MemoryJournal.js'
import { knowledgeMutation, type MutationLookup } from '../src/storage/Journal.js'

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

function fixture(query: unknown = { collection: 'records' }, stateBytes = 4194304) {
  const key = new PrivateKey(1),
    identity = key.toPublicKey().toString()
  const chain = { network: 'test', genesisHash: '01'.repeat(32) }
  const rules = { id: 'https://example.test/lookup/1', parameters: {} }
  const rulesDigest = outputPacketDigest('service-rules', rules)
  const manifest = signOutputPacket(
    'capabilities',
    {
      version: 1,
      identity,
      baseURL: 'https://example.test/api',
      chain,
      issuedAt: '900',
      expiresAt: '1200',
      services: [
        {
          name: 'records',
          kind: 'lookup',
          rules,
          rulesDigest,
          profiles: [
            {
              id: OUTPUT_LOOKUP_PROFILE,
              authentication: 'brc103',
              payment: 'none',
              maxRequestBytes: 1048576,
              maxResponseBytes: 4194304,
              parameters: {
                sessionSeconds: '300',
                replaySeconds: '600',
                maxObservations: 1024,
                maxWaitMs: 25000
              }
            }
          ]
        }
      ]
    },
    key
  )
  const { record } = retainOutputCapability(manifest, {
    baseURL: 'https://example.test/api',
    identity,
    chain,
    service: 'records',
    kind: 'lookup',
    profile: OUTPUT_LOOKUP_PROFILE,
    now: '1000',
    maximumAgeSeconds: '200',
    clockSkewSeconds: '2',
    rules: new Map([[rules.id, () => {}]])
  })
  const open = {
    version: 1 as const,
    requestId: 'original-opening-id',
    service: 'records',
    query,
    requiredRulesDigest: rulesDigest,
    limits: { maxBytes: 4194304, maxObservations: 1024, waitMs: 0 }
  }
  const scope = {
    chain,
    provider: identity,
    service: 'records',
    rulesDigest,
    queryDigest: outputPacketDigest('lookup-query', { service: 'records', query }),
    access: 'private',
    epoch: 'epoch-1'
  }
  const frame = new LookupSourceFraming({
    id: 'catalogue',
    partition: { application: 'demo', account: 'alice', access: 'private' },
    generation: '3',
    limits: runtimeLimits(),
    scope,
    authentication: 'brc103'
  })
  const original: LookupSourceOriginal = {
    contract: record,
    open: open as LookupSourceOriginal['open']
  }
  const codec = new LookupSourceStateCodec(original, frame, stateBytes)
  const packet: OutputLookupBatch = {
    version: 1,
    session: 'session',
    scope,
    phase: 'snapshot',
    groups: [],
    cursor: 'cursor',
    snapshotComplete: true,
    through: '5',
    highWater: '5',
    expiresAt: '1300',
    replayUntil: '1900',
    limits: { maxBytes: 65536, maxObservations: 1024, waitMs: 0 }
  }
  return { codec, frame, original, packet }
}

async function receipt(
  batch: NonNullable<ReturnType<LookupSourceStateCodec['initial']>['pending']>
): Promise<MutationLookup> {
  const journal = new MemoryJournal('fixture')
  const mutation = knowledgeMutation({ kind: 'receive', batch })
  await journal.append('0', mutation)
  return journal.getMutation(mutation.key)
}

describe('saved lookup source transitions', () => {
  it('preserves the original operation and exact receipt under arbitrary captured cursors and journal minima', async () => {
    const { codec, packet, original } = fixture()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000000 }),
        fc
          .array(fc.constantFrom('a', 'z', '\\', '\n', 'é'), { minLength: 1, maxLength: 16 })
          .map(parts => parts.join('')),
        async (minimum, cursor) => {
          const initial = codec.initial(String(minimum))
          const captured = codec.capture(initial, { ...packet, cursor }, '1000')
          expect(() => codec.advance(captured, { status: 'absent' })).toThrow(
            expect.objectContaining({ code: 'conflict' })
          )
          const committed = await receipt(captured.pending!)
          const advanced = codec.advance(captured, committed)
          expect(advanced.original).toEqual(original)
          expect(advanced.previous?.cursor).toBe(cursor)
          expect(advanced.previousReceipt?.received).toBe('1')
          expect(advanced.minimumReceived).toBe(String(Math.max(minimum, 1)))
          expect(advanced.job).toBe('1')
          expect(advanced.pending).toBeNull()
          expect(codec.advance(captured, committed)).toEqual(advanced)
          expect(captured.previous).toBeNull()
          expect(initial.pending).toBeNull()
        }
      )
    )
  })

  it('rejects invalid control capacities and an unknown local state format', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN, 4194305])
      expect(() => fixture({}, capacity)).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: expect.stringContaining('control-state capacity')
        })
      )
    const { codec } = fixture()
    expect(codec.initial('0').format).toBe('output-live-lookup-source/1')
    expect(() => codec.parse({ ...codec.initial('0'), format: 'future' })).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: expect.stringContaining('state version')
      })
    )
  })
  it('retains a reset without observations or a new successful cursor and requires a new generation', async () => {
    const { codec, packet } = fixture()
    const initial = codec.initial('0')
    expect(() => codec.reset(initial, '1300')).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: expect.stringContaining('committed predecessor')
      })
    )
    const captured = codec.capture(initial, packet, '1000')
    expect(() => codec.reset(captured, '1300')).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: expect.stringContaining('committed predecessor')
      })
    )
    const previous = codec.advance(captured, await receipt(captured.pending!))
    const reset = codec.reset(previous, '1300')
    expect(reset.previous).toEqual(previous.previous)
    expect(reset.pending?.checkpoint).toBeUndefined()
    expect(reset.pending?.groups).toEqual([])
    expect(reset.pending?.coverage.status).toBe('reset-required')
    expect(() => codec.advance(reset, { status: 'absent' })).toThrow(
      expect.objectContaining({
        code: 'reset-required',
        message: expect.stringContaining('new generation')
      })
    )
    expect(() => codec.parse({ ...initial, pending: reset.pending })).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: expect.stringContaining('exact predecessor')
      })
    )
    const changed = structuredClone(reset)
    changed.pending!.coverage.through = '4'
    expect(() => codec.parse(changed)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: expect.stringContaining('exact predecessor')
      })
    )
    changed.pending!.coverage.through = '5'
    changed.pending!.checkpoint = captured.pending!.checkpoint
    expect(() => codec.parse(changed)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: expect.stringContaining('local continuity reset')
      })
    )
    expect(() => codec.parse({ ...previous, previousReceipt: null })).toThrow(
      expect.objectContaining({ code: 'invalid' })
    )
    for (const received of ['0', '2'])
      expect(() =>
        codec.parse({ ...previous, previousReceipt: { ...previous.previousReceipt, received } })
      ).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: expect.stringContaining('receipt position')
        })
      )
  })
  it('binds the original opening query, service and optional rules before any request', () => {
    const { original, frame } = fixture()
    for (const change of [
      { service: 'another' },
      { query: { collection: 'another' } },
      { requiredRulesDigest: '99'.repeat(32) }
    ]) {
      expect(
        () =>
          new LookupSourceStateCodec(
            { ...original, open: { ...original.open, ...change } },
            frame,
            4194304
          )
      ).toThrow(
        expect.objectContaining({
          code: 'context-changed',
          message: expect.stringContaining('query or rules')
        })
      )
    }
    const { requiredRulesDigest: _rules, ...open } = original.open
    expect(new LookupSourceStateCodec({ ...original, open }, frame, 4194304).initial('0').job).toBe(
      '0'
    )
  })

  it('rejects a claimed committed receipt without a positive journal position', async () => {
    const { codec, packet } = fixture()
    const state = codec.capture(codec.initial('0'), packet, '1000')
    const saved = await receipt(state.pending!)
    if (saved.status !== 'committed') throw new Error('Expected fixture receipt')
    saved.entry.revision.received = '0'
    expect(() => codec.advance(state, saved)).toThrow(
      expect.objectContaining({
        code: 'reset-required',
        message: expect.stringContaining('no revision')
      })
    )
  })

  it('captures without advancing and advances only for the exact committed receipt', async () => {
    const { codec, packet } = fixture()
    const initial = codec.initial('0')
    const pending = codec.capture(initial, packet, '1000')
    expect(pending.job).toBe('0')
    expect(pending.previous).toBeNull()
    expect(pending.pending?.provenance.receivedAt).toBe('1000')
    expect(() => codec.advance(pending, { status: 'absent' })).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: expect.stringContaining('not been durably received')
      })
    )
    expect(() => codec.advance(pending, { status: 'unavailable', reason: 'offline' })).toThrow(
      'cannot be established'
    )
    expect(() => codec.capture(pending, packet, '1001')).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: expect.stringContaining('already has a captured response')
      })
    )
    const lookup = await receipt(pending.pending!)
    const next = codec.advance(pending, lookup)
    expect(next).toEqual({
      ...initial,
      job: '1',
      minimumReceived: '1',
      previous: lookupSourceCheckpoint(pending.pending!),
      previousReceipt: {
        key: knowledgeMutation({ kind: 'receive', batch: pending.pending! }).key,
        received: '1'
      }
    })
    expect(() => codec.advance(next, lookup)).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: expect.stringContaining('no captured response')
      })
    )
    expect(pending.pending).not.toBeNull()
  })

  it('reopens captured state with the same original bytes and timestamp after uncertain delivery', async () => {
    const { codec, frame, original, packet } = fixture()
    const captured = codec.capture(codec.initial('0'), packet, '1000')
    const serialized = canonicalOutputJSON(codec.value(captured))
    const reopened = new LookupSourceStateCodec(original, frame, 4194304)
    const recovered = reopened.parse(JSON.parse(serialized))
    expect(recovered).toEqual(captured)
    expect(reopened.advance(recovered, await receipt(captured.pending!))).toEqual(
      codec.advance(captured, await receipt(captured.pending!))
    )
    expect(canonicalOutputJSON(recovered)).toBe(serialized)
  })

  it('rejects mismatched committed bytes or mutation key', async () => {
    const { codec, packet } = fixture()
    const pending = codec.capture(codec.initial('0'), packet, '1000')
    const found = await receipt(pending.pending!)
    if (found.status !== 'committed') throw new Error('Missing test receipt')
    expect(() =>
      codec.advance(pending, { ...found, entry: { ...found.entry, key: '00'.repeat(32) } })
    ).toThrow(
      expect.objectContaining({ code: 'equivocation', message: expect.stringContaining('differs') })
    )
    expect(() =>
      codec.advance(pending, {
        ...found,
        entry: {
          ...found.entry,
          body: {
            kind: 'receive',
            batch: {
              ...pending.pending!,
              groups: [{ id: 'extra', sequence: '5', observations: [] }]
            }
          }
        }
      })
    ).toThrow(
      expect.objectContaining({ code: 'equivocation', message: expect.stringContaining('differs') })
    )
  })

  it('permits an identical empty poll to reuse an earlier receipt without reversing the core minimum', async () => {
    const { codec, packet } = fixture()
    const first = codec.capture(codec.initial('0'), packet, '1000')
    const ready = codec.advance(first, await receipt(first.pending!))
    const live = { ...packet, phase: 'live' as const }
    const pending = codec.capture(ready, live, '1000')
    const saved = await receipt(pending.pending!)
    const acknowledged = codec.advance(pending, saved)
    const guarded = codec.reserveMinimum(acknowledged, '9')
    const repeated = codec.capture(guarded, live, '1000')
    expect(repeated.pending).toEqual(pending.pending)
    expect(codec.advance(repeated, saved).minimumReceived).toBe('9')
    expect(codec.advance(repeated, saved).job).toBe('3')
  })

  it('rejects rollback, changed originals and invalid job/predecessor pairs', async () => {
    const { codec, packet } = fixture()
    const initial = codec.initial('7')
    expect(() => codec.reserveMinimum(initial, '6')).toThrow(
      expect.objectContaining({
        code: 'reset-required',
        message: expect.stringContaining('precedes')
      })
    )
    expect(codec.reserveMinimum(initial, '7')).toEqual(initial)
    expect(() =>
      codec.parse({
        ...initial,
        original: {
          ...initial.original,
          open: { ...initial.original.open, requestId: 'another-opening-id' }
        }
      })
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: expect.stringContaining('opening changed')
      })
    )
    expect(() => codec.parse({ ...initial, job: '1' })).toThrow(
      expect.objectContaining({ code: 'invalid', message: expect.stringContaining('predecessor') })
    )
    const pending = codec.capture(initial, packet, '1000')
    const next = codec.advance(pending, await receipt(pending.pending!))
    expect(() => codec.parse({ ...next, job: '0' })).toThrow(
      expect.objectContaining({ code: 'invalid', message: expect.stringContaining('predecessor') })
    )
    expect(() =>
      codec.parse({
        ...next,
        previous: { ...next.previous!, scope: { ...packet.scope, queryDigest: '09'.repeat(32) } }
      })
    ).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: expect.stringContaining('query identity')
      })
    )
  })

  it('keeps snapshot/live boundaries, scope and fixed deadlines across captured responses', async () => {
    const { codec, packet } = fixture()
    const initial = codec.initial('0')
    expect(() => codec.capture(initial, { ...packet, phase: 'live' }, '1000')).toThrow(
      expect.objectContaining({ code: 'invalid', message: expect.stringContaining('Opening') })
    )
    const pending = codec.capture(initial, packet, '1000')
    const ready = codec.advance(pending, await receipt(pending.pending!))
    expect(() => codec.capture(ready, packet, '1000')).toThrow('snapshot boundary')
    expect(() =>
      codec.capture(ready, { ...packet, phase: 'live', replayUntil: '1901' }, '1000')
    ).toThrow('deadlines')
    expect(() =>
      codec.capture(ready, { ...packet, phase: 'live', session: 'another' }, '1000')
    ).toThrow('session')
    expect(() => codec.capture(ready, { ...packet, phase: 'live', through: '4' }, '1000')).toThrow(
      'watermark'
    )
  })

  it('checks U64 overflow before changing saved state', async () => {
    const { codec, packet } = fixture()
    const pending = codec.capture(
      codec.initial('0'),
      { ...packet, snapshotComplete: false },
      '1000'
    )
    const ready = codec.advance(pending, await receipt(pending.pending!))
    const maximum = { ...ready, job: '18446744073709551615' }
    const last = codec.capture(maximum, packet, '1000')
    const before = canonicalOutputJSON(last)
    expect(() =>
      codec.advance(last, {
        status: 'committed',
        entry: {
          ...knowledgeMutation({ kind: 'receive', batch: last.pending! }),
          revision: { received: '2', accepted: '0' }
        }
      })
    ).toThrow()
    expect(canonicalOutputJSON(last)).toBe(before)
  })

  it('reserves metadata capacity separately from response bytes', () => {
    const { codec, frame } = fixture()
    expect(codec.maximumWireBytes()).toBeLessThanOrEqual(frame.maximumWireBytes())
    expect(codec.maximumWireBytes()).toBeGreaterThan(65536)
    const small = fixture({ text: 'x'.repeat(140000) }, 150000)
    expect(small.codec.initial('0').pending).toBeNull()
    expect(() => small.codec.maximumWireBytes()).toThrow(
      expect.objectContaining({
        code: 'limited',
        message: expect.stringContaining('Control capacity')
      })
    )
  })

  it('reserves every retained field at its worst-case encoded width', () => {
    const { original, frame } = fixture()
    const pending = frame.maximumEnvelope()
    const maximum = '18446744073709551615'
    const envelope = {
      format: 'output-live-lookup-source/1',
      job: maximum,
      minimumReceived: maximum,
      original,
      previous: { ...lookupSourceCheckpoint(pending), snapshotComplete: false },
      previousReceipt: { key: 'f'.repeat(64), received: maximum },
      pending
    }
    const bytes = new TextEncoder().encode(canonicalOutputJSON(envelope)).length
    expect(new LookupSourceStateCodec(original, frame, bytes + 1).maximumWireBytes()).toBe(1)
    expect(() => new LookupSourceStateCodec(original, frame, bytes).maximumWireBytes()).toThrow(
      'Control capacity'
    )
  })
})
