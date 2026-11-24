import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { describe, expect, it } from '@jest/globals'
import {
  canonicalOutputJSON,
  closedOutputObject,
  outputPacketDigest,
  type OutputJSON,
  type OutputLookupOpen,
  type OutputScope
} from '@bsv/sdk'
import { LookupQueryRegistry } from '../src/lookup/LookupQueryRegistry.js'
import type {
  LookupObservationTemplate,
  LookupQueryPolicy
} from '../src/lookup/LookupQueryPolicy.js'
import type { LookupIndexGroup, LookupIndexRow } from '../src/lookup/LookupIndexCodec.js'
import { LookupLimitError } from '../src/lookup/LookupLimitError.js'
import { chain } from './evidence-fixture.js'

const template = (reason: string): LookupObservationTemplate => ({
  kind: 'assessment-invalidated',
  payload: { contextId: 'assessment', reason }
})
const row: LookupIndexRow = {
  key: '01',
  revision: '1',
  value: { data: { label: 'original' }, expiresAt: null }
}
const group: LookupIndexGroup = {
  sequence: '2',
  recordedAt: '1010',
  changes: [
    {
      key: '01',
      before: row,
      after: { ...row, revision: '2', value: { ...row.value, data: { label: 'next' } } }
    }
  ],
  event: { type: 'changed' }
}
function fixture(overrides: Partial<LookupQueryPolicy> = {}) {
  const policy: LookupQueryPolicy = {
    id: 'https://example.test/query-rules/1',
    parameters(input) {
      closedOutputObject(input, [])
      return {}
    },
    query(input) {
      closedOutputObject(input, ['selected'])
      return input as OutputJSON
    },
    snapshot(value, context) {
      return (context.query as { selected: boolean }).selected
        ? [template(value.value.data.label as string)]
        : []
    },
    transition(value) {
      return value.changes.flatMap(change => [
        template(change.before?.value.data.label as string),
        template(change.after?.value.data.label as string)
      ])
    },
    ...overrides
  }
  const registry = new LookupQueryRegistry([{ policy, parameters: {} }])
  const description = registry.describe()[0]
  const open: OutputLookupOpen = {
    version: 1,
    service: 'records',
    requestId: '01'.repeat(32),
    query: { selected: true },
    limits: { maxBytes: 65536, maxObservations: 1, waitMs: 0 }
  }
  const scope: OutputScope = {
    chain,
    provider: 'https://lookup.example.test',
    service: open.service,
    rulesDigest: description.rulesDigest,
    queryDigest: outputPacketDigest('lookup-query', { service: open.service, query: open.query }),
    epoch: 'epoch',
    access: 'public'
  }
  return { registry, policy, open, scope, view: registry.prepare(open, scope, null) }
}

describe('installed lookup selection and immutable groups', () => {
  it('namespaces snapshot identities by captured session and live identities by scope and sequence', () => {
    const { view, registry, open, scope } = fixture()
    const first = view.snapshot(row, '01'.repeat(32), '1', '1000')!
    const second = view.snapshot(row, '02'.repeat(32), '1', '1000')!
    expect(first.id).not.toBe(second.id)
    expect(first.observations[0].id).not.toBe(second.observations[0].id)
    expect(first.observations[0].scope).toEqual(scope)
    expect(view.snapshot(row, '01'.repeat(32), '1', '1000')).toEqual(first)
    const live = view.live(group)!
    expect(live.id).not.toBe(first.id)
    expect(live.observations.map(value => value.id)).toEqual([live.id + ':0', live.id + ':1'])
    expect(live.observations.map(value => value.payload)).toEqual([
      { contextId: 'assessment', reason: 'original' },
      { contextId: 'assessment', reason: 'next' }
    ])
    const differentLimits = {
      ...open,
      requestId: '03'.repeat(32),
      limits: { maxBytes: 4194304, maxObservations: 1024, waitMs: 25000 }
    }
    expect(registry.prepare(differentLimits, scope, null).live(group)).toEqual(live)
    expect(registry.prepare(open, { ...scope, epoch: 'another' }, null).live(group)!.id).not.toBe(
      live.id
    )
    expect(registry.prepare(open, { ...scope, access: 'another' }, null).live(group)!.id).not.toBe(
      live.id
    )
  })

  it('keeps original query digest while preparing bounded deterministic query data', () => {
    const { registry, open, scope } = fixture({ query: () => ({ selected: false }) })
    expect(
      registry.prepare(open, scope, null).snapshot(row, '01'.repeat(32), '1', '1000')
    ).toBeNull()
  })

  it('keeps rows, groups, installed parameters and prepared query inputs owned across callbacks', () => {
    const { registry, open, scope, view } = fixture({
      snapshot(value, context) {
        const result = template(value.value.data.label as string)
        value.value.data.label = 'mutated'
        context.scope.access = 'mutated'
        context.parameters.changed = true
        return [result]
      },
      transition(value, context) {
        const result = template(String(value.event.type))
        value.event.type = 'mutated'
        context.scope.access = 'mutated'
        return [result]
      }
    })
    const expected = view.snapshot(row, '01'.repeat(32), '1', '1000')
    open.query = null
    scope.access = 'external-mutation'
    registry.describe()[0].rules.parameters.changed = true
    expect(view.snapshot(row, '01'.repeat(32), '1', '1000')).toEqual(expected)
    expect(view.live(group)).toEqual(view.live(group))
    expect(row.value.data.label).toBe('original')
    expect(group.event.type).toBe('changed')
    expect(registry.describe()[0].rules.parameters).toEqual({})
  })

  it('allows empty mappings without fabricating a group or splitting a domain transition', () => {
    const { view } = fixture({ snapshot: () => [], transition: () => [] })
    expect(view.snapshot(row, '01'.repeat(32), '1', '1000')).toBeNull()
    expect(view.live(group)).toBeNull()
  })

  it('distinguishes ordinary expiry after capture from a row already expired at the capture time', () => {
    const { view } = fixture()
    const expires = { ...row, value: { ...row.value, expiresAt: '1001' } }
    expect(view.snapshot(expires, '01'.repeat(32), '1', '1000')).not.toBeNull()
    expect(() => view.snapshot(expires, '01'.repeat(32), '1', '1001')).toThrow(
      'outside its captured boundary'
    )
    expect(() => view.snapshot(row, '01'.repeat(32), '0', '1000')).toThrow(
      'outside its captured boundary'
    )
  })

  it.each([
    { service: 'other' },
    { requiredRulesDigest: 'ff'.repeat(32) },
    { query: { selected: false } }
  ])('rejects changed original query selection (%j)', change => {
    const { registry, open, scope } = fixture()
    expect(() => registry.prepare({ ...open, ...change }, scope, null)).toThrow(
      'changed its retained scope'
    )
  })

  it('rejects unavailable policies and does not dynamically load an advertised rule identifier', () => {
    const { registry, open, scope } = fixture()
    expect(() => registry.prepare(open, { ...scope, rulesDigest: 'ff'.repeat(32) }, null)).toThrow(
      'not installed'
    )
  })

  it.each([{ id: 'not-an-iri' }, { parameters: () => null }, { parameters: () => [] }])(
    'rejects invalid installed rule descriptions (%j)',
    change => {
      const { policy } = fixture()
      expect(
        () =>
          new LookupQueryRegistry([
            { policy: { ...policy, ...change } as LookupQueryPolicy, parameters: {} }
          ])
      ).toThrow()
    }
  )

  it('rejects empty, repeated or unbounded installations', () => {
    const { policy } = fixture()
    expect(() => new LookupQueryRegistry([])).toThrow('1–32')
    expect(
      () => new LookupQueryRegistry(Array.from({ length: 33 }, () => ({ policy, parameters: {} })))
    ).toThrow('1–32')
    expect(
      () =>
        new LookupQueryRegistry([
          { policy, parameters: {} },
          { policy, parameters: {} }
        ])
    ).toThrow('duplicate')
  })

  it.each([
    [{ ...template('test'), id: 'override' }],
    [{ ...template('test'), scope: {} }],
    [{ kind: 'unknown', payload: {} }],
    [{ ...template('test'), critical: ['urn:unsupported'], extensions: { 'urn:unsupported': {} } }],
    null
  ])(
    'validates complete policy output without accepting caller-supplied identity/scope (%#)',
    input => {
      const { view } = fixture({ snapshot: () => input as LookupObservationTemplate[] })
      expect(() => view.snapshot(row, '01'.repeat(32), '1', '1000')).toThrow()
    }
  )

  it('returns a permanent-group failure rather than truncating an oversized coherent mapping', () => {
    const { view } = fixture({
      transition: () => Array.from({ length: 1025 }, () => template('large'))
    })
    expect(() => view.live(group)).toThrow(LookupLimitError)
    try {
      view.live(group)
    } catch (error) {
      expect(error).toMatchObject({ code: 'limited', limit: { kind: 'permanent-group' } })
    }
    const bytes = fixture({
      transition: () => [
        {
          kind: 'assessment-invalidated',
          payload: { contextId: 'assessment', reason: 'x'.repeat(4194305) }
        }
      ]
    })
    expect(() => bytes.view.live(group)).toThrow(LookupLimitError)
  })

  it('charges repeated scope and escaped UTF-8 bytes before allowing a complete group', () => {
    const { registry, open, scope } = fixture({
      transition: () => Array.from({ length: 1024 }, () => template('test'))
    })
    const expanded = { ...scope, access: '\u0001'.repeat(1024) }
    expect(() => registry.prepare(open, expanded, null).live(group)).toThrow(LookupLimitError)
    expect(canonicalOutputJSON(expanded).length).toBeGreaterThan(6144)
  })

  it('keeps limit diagnostics within the base profile and excludes private payloads', () => {
    const error = new LookupLimitError({
      kind: 'group',
      minimumBytes: 65536,
      minimumObservations: 2
    })
    expect(error.limit).toEqual({ kind: 'group', minimumBytes: 65536, minimumObservations: 2 })
    expect(Object.isFrozen(error.limit)).toBe(true)
    expect(() => new LookupLimitError({ kind: 'group', minimumBytes: 4194305 })).toThrow()
    expect(() => new LookupLimitError({ kind: 'group', minimumObservations: 1025 })).toThrow()
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

it('keeps arbitrary complete observation groups stable across equivalent query views', () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 16 }),
      reasons => {
        const { view, registry, open, scope } = fixture({ transition: () => reasons.map(template) })
        const result = view.live(group)!
        expect(result.observations.map(x => x.payload)).toEqual(
          reasons.map(reason => ({ contextId: 'assessment', reason }))
        )
        expect(
          result.observations.every(
            x => canonicalOutputJSON(x.scope) === canonicalOutputJSON(scope)
          )
        ).toBe(true)
        expect(new Set(result.observations.map(x => x.id)).size).toBe(reasons.length)
        const alternate = registry.prepare(
          { ...open, limits: { ...open.limits, maxObservations: 1024 } },
          scope,
          null
        )
        expect(alternate.live(group)).toEqual(result)
        result.observations.length = 0
        expect(view.live(group)!.observations).toHaveLength(reasons.length)
      }
    )
  )
})

describe('query compatibility and exact group boundaries', () => {
  it('matches independent persisted group identity vectors for both phases', () => {
    const { registry, open, scope } = fixture()
    const scoped = { ...scope, access: 'partition-é' }
    const view = registry.prepare(open, scoped, null)
    const digest = (phase: string, position: unknown) =>
      createHash('sha256')
        .update(
          'OUTPUT-LOOKUP-GROUP/1\0' + canonicalOutputJSON({ scope: scoped, phase, position }),
          'utf8'
        )
        .digest('hex')
    expect(view.live(group)!.id).toBe(digest('live', group.sequence))
    expect(view.snapshot(row, '01'.repeat(32), '1', '1000')!.id).toBe(
      digest('snapshot', {
        session: '01'.repeat(32),
        watermark: '1',
        key: row.key
      })
    )
  })

  it('accepts 32 distinct installed policies and rejects an invalid IRI prefix', () => {
    const { policy } = fixture()
    expect(
      new LookupQueryRegistry(
        Array.from({ length: 32 }, (_, i) => ({
          policy: { ...policy, id: 'urn:policy:' + i },
          parameters: {}
        }))
      ).describe()
    ).toHaveLength(32)
    expect(
      () => new LookupQueryRegistry([{ policy: { ...policy, id: '1urn:policy' }, parameters: {} }])
    ).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => new LookupQueryRegistry([])).toThrow(expect.objectContaining({ code: 'invalid' }))
  })

  it.each([null, [], true, 7, 'text'])(
    'rejects non-object installed parameters with a stable error class (%j)',
    input => {
      const { policy } = fixture()
      expect(() => new LookupQueryRegistry([{ policy, parameters: input as never }])).toThrow(
        expect.objectContaining({
          code: 'invalid',
          message: 'Lookup rule parameters must be a JSON object'
        })
      )
    }
  )

  it('rejects a mismatching service even when its query digest is independently valid', () => {
    const { registry, open, scope } = fixture()
    const selected = { ...scope, service: 'another' }
    expect(() => registry.prepare(open, selected, null)).toThrow(
      expect.objectContaining({ code: 'context-changed' })
    )
    expect(() => registry.prepare(open, { ...scope, rulesDigest: 'ff'.repeat(32) }, null)).toThrow(
      expect.objectContaining({ code: 'unsupported' })
    )
    expect(() => registry.prepare({ ...open, query: null }, scope, null)).toThrow(
      expect.objectContaining({ code: 'context-changed' })
    )
    expect(() =>
      registry.prepare(open, scope, null).snapshot(row, '01'.repeat(32), '0', '1000')
    ).toThrow(expect.objectContaining({ code: 'context-changed' }))
  })

  it('preserves invalid-policy errors instead of reclassifying every failure as a size limit', () => {
    const invalid = fixture({ transition: () => ({ length: 0 }) as never })
    expect(() => invalid.view.live(group)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Lookup policy must return an observation array'
      })
    )
    const malformed = fixture({ transition: () => [{ kind: 'unknown', payload: {} } as never] })
    expect(() => malformed.view.live(group)).toThrow(expect.objectContaining({ code: 'invalid' }))
    const missing = fixture({ transition: () => [{ payload: {} } as never] })
    expect(() => missing.view.live(group)).toThrow(expect.objectContaining({ code: 'invalid' }))
  })

  it('allows optional noncritical observation extensions without widening their scope', () => {
    const selected = fixture({
      transition: () => [
        {
          ...template('extended'),
          extensions: { 'urn:example:display': { label: 'record' } },
          critical: []
        }
      ]
    })
    expect(selected.view.live(group)!.observations[0]).toMatchObject({
      extensions: { 'urn:example:display': { label: 'record' } },
      critical: []
    })
  })

  it('charges every separator and the final UTF-8 group envelope at exactly 4 MiB', () => {
    let padding = ''
    const selected = fixture({
      transition: () =>
        Array.from({ length: 1024 }, (_, i) => ({
          ...template('record'),
          ...(i === 1023 ? { extensions: { 'urn:example:padding': padding } } : {})
        }))
    })
    const view = selected.registry.prepare(
      selected.open,
      { ...selected.scope, access: '\u0001'.repeat(520) },
      null
    )
    const initial = view.live(group)!
    expect(initial.observations).toHaveLength(1024)
    const remaining =
      4194304 - new TextEncoder().encode(canonicalOutputJSON(initial, { bytes: 4194304 })).length
    expect(remaining).toBeGreaterThan(0)
    padding = 'x'.repeat(remaining)
    const exact = view.live(group)!
    expect(new TextEncoder().encode(canonicalOutputJSON(exact, { bytes: 4194304 }))).toHaveLength(
      4194304
    )
    padding += 'x'
    expect(() => view.live(group)).toThrow(
      expect.objectContaining({ code: 'limited', limit: { kind: 'permanent-group' } })
    )
  })
})
