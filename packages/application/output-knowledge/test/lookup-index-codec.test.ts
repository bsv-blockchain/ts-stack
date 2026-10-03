import { beforeEach, describe, expect, it } from '@jest/globals'
import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  LookupIndexCodec,
  type LookupIndexGroup,
  type LookupIndexMutation,
  type LookupIndexRow
} from '../src/lookup/LookupIndexCodec.js'

let codec: LookupIndexCodec
beforeEach(() => {
  codec = new LookupIndexCodec()
})
const row = (key = '01', revision = '1'): LookupIndexRow => ({
  key,
  revision,
  value: { data: { label: 'original' }, expiresAt: '200' }
})
const mutation = (): LookupIndexMutation => ({
  base: '1',
  evaluatedAt: '100',
  edits: [
    { key: '01', previous: '1', next: null },
    { key: '02', previous: null, next: { data: { label: 'replacement' }, expiresAt: '300' } }
  ],
  event: { reason: 'replacement', witness: 'domain-event' }
})
const group = (): LookupIndexGroup => codec.plan(mutation(), [row(), null])
const bytes = (value: unknown) => new TextEncoder().encode(canonicalOutputJSON(value)).length

describe('versioned lookup index domain records', () => {
  it('preserves one indivisible replacement and recovers its exact original retry key', () => {
    const change = group()
    expect(change).toEqual({
      sequence: '2',
      recordedAt: '100',
      changes: [
        { key: '01', before: row(), after: null },
        {
          key: '02',
          before: null,
          after: {
            key: '02',
            revision: '2',
            value: { data: { label: 'replacement' }, expiresAt: '300' }
          }
        }
      ],
      event: { reason: 'replacement', witness: 'domain-event' }
    })
    expect(codec.original(change)).toEqual(mutation())
    expect(codec.mutationKey(codec.original(change))).toBe(codec.mutationKey(mutation()))
    const changed = mutation()
    changed.event.witness = 'another-domain-event'
    expect(codec.mutationKey(changed)).not.toBe(codec.mutationKey(mutation()))
  })

  it('owns prepared rows, replacements and event data without changing caller values', () => {
    const input = mutation()
    const before = row()
    const planned = codec.plan(input, [before, null])
    before.value.data.label = 'late-before'
    input.edits[1].next!.data.label = 'late-after'
    input.event.reason = 'late-event'
    expect(planned).toEqual(group())
    planned.changes[1].after!.value.data.label = 'consumer mutation'
    expect(input.edits[1].next!.data.label).toBe('late-after')
  })

  it('treats absence and exact row versions as predicates, never blind writes', () => {
    expect(() => codec.plan(mutation(), [])).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
    for (const reads of [
      [null, null],
      [row('01', '2'), null],
      [row('03'), null],
      [row(), row('02')]
    ])
      expect(() => codec.plan(mutation(), reads)).toThrow(
        expect.objectContaining({ code: 'conflict' })
      )
  })

  it('permits an event-only domain change and preserves a non-expiring row', () => {
    const event: LookupIndexMutation = {
      base: '0',
      evaluatedAt: '0',
      edits: [],
      event: { reason: 'context-invalidated' }
    }
    expect(codec.original(codec.plan(event, []))).toEqual(event)
    const created: LookupIndexMutation = {
      ...event,
      edits: [{ key: '00', previous: null, next: { data: {}, expiresAt: null } }]
    }
    expect(codec.plan(created, [null]).changes[0].after!.value.expiresAt).toBeNull()
  })

  it('retains an already expired prior row as history, but never publishes one as current', () => {
    const before = row()
    before.value.expiresAt = '100'
    expect(codec.plan(mutation(), [before, null]).changes[0].before).toEqual(before)
    for (const expiresAt of ['0', '99', '100']) {
      const input = mutation()
      input.edits[1].next!.expiresAt = expiresAt
      expect(() => codec.mutation(input)).toThrow('already expired')
    }
    const input = mutation()
    input.edits[1].next!.expiresAt = '101'
    expect(codec.mutation(input)).toEqual(input)
  })

  it('charges complete group and row framing at exact byte boundaries', () => {
    const record = group()
    expect(new LookupIndexCodec({ groupBytes: bytes(record) }).group(record)).toEqual(record)
    expect(() => new LookupIndexCodec({ groupBytes: bytes(record) - 1 }).group(record)).toThrow(
      expect.objectContaining({ code: 'limited' })
    )
    expect(new LookupIndexCodec({ rowBytes: bytes(row()) }).row(row())).toEqual(row())
    expect(() => new LookupIndexCodec({ rowBytes: bytes(row()) - 1 }).row(row())).toThrow(
      expect.objectContaining({ code: 'limited' })
    )
    const small = new LookupIndexCodec({ rowBytes: 200, groupBytes: 200, changes: 1 })
    expect(() => small.mutation(mutation())).toThrow()
    expect(() => new LookupIndexCodec({ changes: 1 }).group(record)).toThrow(
      expect.objectContaining({ code: 'limited' })
    )
    const largeBefore = row()
    largeBefore.value.data.padding = 'x'.repeat(1000)
    expect(() =>
      small.plan({ ...mutation(), edits: [mutation().edits[0]] }, [largeBefore])
    ).toThrow(expect.objectContaining({ code: 'limited' }))
  })

  it.each([
    { rowBytes: 0 },
    { groupBytes: -1 },
    { changes: 1025 },
    { changes: 1.5 },
    { rowBytes: 1048577 },
    { groupBytes: 4194305 },
    { unexpected: 1 }
  ])('rejects invalid or unknown capacity settings (%j)', limits => {
    expect(() => new LookupIndexCodec(limits)).toThrow('Invalid lookup index capacity')
  })

  it.each([
    { base: '01' },
    { evaluatedAt: '-1' },
    { event: [] },
    { event: null },
    { edits: {} },
    { extra: true }
  ])('rejects malformed mutation fields (%j)', change => {
    expect(() => codec.mutation({ ...mutation(), ...change })).toThrow()
  })

  it('rejects duplicate writes, future/zero predicates and overflow instead of wrapping', () => {
    const input = mutation()
    expect(() => codec.mutation({ ...input, edits: [input.edits[0], input.edits[0]] })).toThrow(
      'repeats an index key'
    )
    for (const previous of ['0', '2'])
      expect(() => codec.mutation({ ...input, edits: [{ ...input.edits[0], previous }] })).toThrow(
        'outside the observed head'
      )
    expect(() => codec.plan({ ...input, base: '18446744073709551615' }, [row(), null])).toThrow()
  })

  it('checks stored group sequence, ordering, expiry, keys and closed framing', () => {
    const original = group()
    for (const invalid of [
      { ...original, sequence: '0' },
      { ...original, extra: true },
      { ...original, event: [] },
      { ...original, changes: [original.changes[0], original.changes[0]] },
      { ...original, changes: [{ ...original.changes[0], key: '03' }] },
      { ...original, changes: [{ ...original.changes[0], before: row('01', '2') }] },
      { ...original, changes: [{ ...original.changes[1], after: row('03', '2') }] },
      { ...original, changes: [{ ...original.changes[1], after: row('02', '1') }] },
      { ...original, recordedAt: '300' }
    ])
      expect(() => codec.group(invalid)).toThrow()
    expect(() => codec.row({ ...row(), revision: '0' })).toThrow('must be positive')
    expect(() => codec.value({ data: [], expiresAt: null })).toThrow('must be a JSON object')
    expect(() => codec.value({ data: {}, expiresAt: '01' })).toThrow()
  })
})

describe('lookup domain change properties', () => {
  it('preserves complete version predicates and exact retry identity over arbitrary U64 heads', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 18446744073709551614n }),
        fc.array(
          fc.record({
            exists: fc.boolean(),
            remove: fc.boolean(),
            label: fc.string({ maxLength: 40 })
          }),
          { minLength: 1, maxLength: 12 }
        ),
        (head, operations) => {
          const current: (LookupIndexRow | null)[] = operations.map((op, i) =>
            op.exists
              ? {
                  key: i.toString(16).padStart(2, '0'),
                  revision: head.toString(),
                  value: { data: { label: 'prior' }, expiresAt: null }
                }
              : null
          )
          const change: LookupIndexMutation = {
            base: head.toString(),
            evaluatedAt: '100',
            event: { source: 'property' },
            edits: operations.map((op, i) => ({
              key: i.toString(16).padStart(2, '0'),
              previous: op.exists ? head.toString() : null,
              next: op.remove ? null : { data: { label: op.label }, expiresAt: '101' }
            }))
          }
          const planned = codec.plan(change, current)
          expect(planned.sequence).toBe((head + 1n).toString())
          expect(planned.changes).toHaveLength(operations.length)
          expect(planned.changes.map(x => x.before)).toEqual(current)
          expect(planned.changes.map(x => x.after?.value ?? null)).toEqual(
            change.edits.map(x => x.next)
          )
          expect(
            planned.changes
              .filter(x => x.after !== null)
              .every(x => x.after!.revision === planned.sequence)
          ).toBe(true)
          expect(codec.original(planned)).toEqual(change)
          expect(codec.mutationKey(codec.original(planned))).toBe(codec.mutationKey(change))
          const stale = structuredClone(change)
          stale.edits[0].previous = operations[0].exists ? null : head.toString()
          expect(() => codec.plan(stale, current)).toThrow(
            expect.objectContaining({ code: 'conflict' })
          )
          const changed = structuredClone(change)
          changed.event.source = 'another-operation'
          expect(codec.mutationKey(changed)).not.toBe(codec.mutationKey(change))
        }
      ),
      {}
    )
  })
})

describe('lookup codec exact boundary contracts', () => {
  it('retains its independent persisted operation domain separator', () => {
    const change = mutation()
    const expected = createHash('sha256')
      .update('output-lookup-index/1\0' + canonicalOutputJSON(change), 'utf8')
      .digest('hex')
    expect(codec.mutationKey(change)).toBe(expected)
  })

  it('accepts exactly the selected change count and rejects zero-sequence event-only groups', () => {
    const input = { ...mutation(), edits: [mutation().edits[0]] }
    const selected = new LookupIndexCodec({ changes: 1 })
    expect(selected.mutation(input)).toEqual(input)
    expect(selected.group(selected.plan(input, [row()])).changes).toHaveLength(1)
    expect(() => codec.group({ sequence: '0', recordedAt: '0', changes: [], event: {} })).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'Lookup group sequence is zero' })
    )
  })

  it.each([true, 7, 'text', [], null])('requires object-valued domain data (%j)', data => {
    expect(() => codec.value({ data, expiresAt: null })).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Lookup index data must be a JSON object'
      })
    )
  })

  it('returns exact public error codes for invalid capacity, expiry and conflicting predicates', () => {
    expect(() => new LookupIndexCodec({ changes: 0 })).toThrow(
      expect.objectContaining({ code: 'invalid' })
    )
    expect(() => codec.row({ ...row(), revision: '0' })).toThrow(
      expect.objectContaining({ code: 'invalid' })
    )
    const input = mutation()
    input.edits[1].next!.expiresAt = '100'
    expect(() => codec.mutation(input)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() =>
      codec.mutation({ ...mutation(), edits: [mutation().edits[0], mutation().edits[0]] })
    ).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => new LookupIndexCodec({ changes: 1 }).mutation(mutation())).toThrow(
      expect.objectContaining({ code: 'limited', message: 'Lookup domain group change limit' })
    )
  })
})

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
