import fc from 'fast-check'
import { describe, expect, it } from '@jest/globals'
import { PrivateKey, type OutputCapabilityRecoveryRequest } from '@bsv/sdk'
import {
  LookupSessionCodec,
  normalizeLookupDisclosureGuards,
  type LookupSessionOpening
} from '../src/lookup/LookupSessionCodec.js'
import { lookupSessionFixture as fixture } from './lookup-session-fixture.js'

describe('private retained lookup opening framing', () => {
  it('rejects an old signed selector when storage is recreated under a fresh epoch', () => {
    const { value, codec } = fixture()
    const replaced = { ...value, epoch: '04'.repeat(32) }
    expect(() => codec.encode(replaced)).toThrow(
      'Original lookup selector belongs to another storage epoch'
    )
  })
  it.each(['none', 'brc103'] as const)(
    'round trips the exact canonical first response under %s',
    authentication => {
      const { value, codec } = fixture(authentication)
      const columns = codec.encode(value)
      const restored = codec.decode(columns)
      expect(restored).toEqual(value)
      expect(codec.encode(restored)).toEqual(columns)
      restored.open.query = { changed: true }
      restored.guards[0].id = 'changed'
      expect(codec.decode(columns)).toEqual(value)
    }
  )

  it('retains a partial snapshot scan cursor instead of crossing the final snapshot boundary', () => {
    const { value, codec, cursor } = fixture()
    value.first.snapshotComplete = false
    value.first.cursor = cursor.seal({ phase: 'snapshot', watermark: '5', after: 'a0' })
    expect(codec.decode(codec.encode(value))).toEqual(value)
    value.first.cursor = cursor.seal({ phase: 'snapshot', watermark: '5', after: null })
    expect(() => codec.encode(value)).toThrow('Incomplete snapshot lost its scan position')
  })

  it('restores the original selection after manifest expiry and owns the installed trust binding', () => {
    const { value, source } = fixture()
    const trust = {
      ...source.selection,
      now: '2000',
      chain: { ...source.selection.chain },
      rules: new Map(source.selection.rules)
    }
    const codec = new LookupSessionCodec(trust)
    trust.chain.network = 'changed'
    trust.rules.clear()
    expect(codec.decode(codec.encode(value))).toEqual(value)
  })

  it('checks the effective first-response limits after clamping an oversized request', () => {
    const { value, codec } = fixture()
    value.open.limits.maxBytes = 4294967295
    value.first.limits.maxBytes = 4194304
    expect(codec.normalize(value).first.limits.maxBytes).toBe(4194304)
    value.first.limits.maxBytes = 1048576
    expect(() => codec.encode(value)).toThrow('First lookup response changed its opening boundary')
  })

  it.each<[(value: LookupSessionOpening) => void, string]>([
    [
      value => {
        value.time = '1001'
      },
      'original contract'
    ],
    [
      value => {
        value.open.service = 'other'
      },
      'original contract'
    ],
    [
      value => {
        value.open.requiredRulesDigest = 'ff'.repeat(32)
      },
      'original contract'
    ],
    [
      value => {
        value.first.scope.access = 'wider'
      },
      'opening boundary'
    ],
    [
      value => {
        value.open.query = { collection: 'other' }
      },
      'opening boundary'
    ],
    [
      value => {
        value.first.phase = 'live'
      },
      'opening boundary'
    ],
    [
      value => {
        value.first.through = '4'
      },
      'opening boundary'
    ],
    [
      value => {
        value.first.expiresAt = '1301'
      },
      'opening boundary'
    ],
    [
      value => {
        value.first.replayUntil = '1901'
      },
      'opening boundary'
    ],
    [
      value => {
        value.first.session = '03'.repeat(32)
      },
      'opening boundary'
    ]
  ])('rejects mismatched retained opening fields (%#)', (change, message) => {
    const { value, codec } = fixture()
    change(value)
    expect(() => codec.encode(value)).toThrow(message)
  })

  it('requires authentication consistent with the original selected profile', () => {
    const privateCase = fixture('brc103')
    privateCase.value.principal = null
    expect(() => privateCase.codec.encode(privateCase.value)).toThrow(
      'Lookup principal does not match'
    )
    const publicCase = fixture()
    publicCase.value.principal = new PrivateKey(2).toPublicKey().toString()
    expect(() => publicCase.codec.encode(publicCase.value)).toThrow(
      'Lookup principal does not match'
    )
  })

  it('binds the first cursor to its session, epoch, key and exact phase position', () => {
    const { value, codec, cursor } = fixture()
    value.first.cursor = cursor.seal({ phase: 'live', through: '4' })
    expect(() => codec.encode(value)).toThrow('Completed snapshot lost its live cursor boundary')
    value.first.cursor = cursor.seal({ phase: 'snapshot', watermark: '5', after: '01' })
    expect(() => codec.encode(value)).toThrow('Completed snapshot lost its live cursor boundary')
    value.first.snapshotComplete = false
    value.first.cursor = cursor.seal({ phase: 'live', through: '5' })
    expect(() => codec.encode(value)).toThrow('Incomplete snapshot lost its scan position')
    value.first.snapshotComplete = true
    value.secret = '03'.repeat(32)
    expect(() => codec.encode(value)).toThrow('Invalid or unavailable lookup cursor')
  })

  it.each(
    [
      [],
      Array.from({ length: 33 }, (_, index) => ({
        id: String(index),
        revision: '0',
        failure: 'reset-required'
      })),
      [{ id: 'a', revision: '0', failure: 'invalid' }],
      [
        { id: 'a', revision: '0', failure: 'reset-required' },
        { id: 'a', revision: '0', failure: 'unauthorized' }
      ]
    ].map(invalid => ({ invalid }))
  )('requires bounded unique current-disclosure guard premises (%#)', ({ invalid }) => {
    const { value, codec } = fixture()
    expect(() => codec.encode({ ...value, guards: invalid })).toThrow()
  })

  it('rejects unknown saved framing, altered manifest signatures and oversized columns', () => {
    const { value, codec } = fixture()
    const columns = codec.encode(value)
    expect(() =>
      codec.decode({ ...columns, metadata: columns.metadata.replace('opening/1', 'opening/2') })
    ).toThrow('Unsupported retained lookup opening format')
    expect(() => codec.decode({ ...columns, open: ' '.repeat(1048577) })).toThrow()
    const changed = JSON.parse(columns.contract) as typeof value.contract
    changed.manifest.body.expiresAt = '9999'
    expect(() => codec.decode({ ...columns, contract: JSON.stringify(changed) })).toThrow()
    expect(() => codec.encode({ ...value, unexpected: true })).toThrow()
  })

  it.each([
    { profile: 'https://example.test/other' },
    { kind: 'topic' },
    { supportedExtensions: ['https://example.test/critical'] }
  ])('does not claim unimplemented profiles or extensions (%j)', change => {
    const { source } = fixture()
    expect(
      () =>
        new LookupSessionCodec({
          ...source.selection,
          ...change
        } as OutputCapabilityRecoveryRequest)
    ).toThrow()
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

it('round trips arbitrary original identifiers and guard revisions without changing first response bytes', () => {
  const { value, codec } = fixture()
  fc.assert(
    fc.property(
      fc
        .uint8Array({ minLength: 8, maxLength: 64 })
        .map(bytes => Buffer.from(bytes).toString('hex')),
      fc.bigInt({ min: 0n, max: 18446744073709551615n }),
      (requestId, revision) => {
        const opening = structuredClone(value)
        opening.open.requestId = requestId
        opening.guards[0].revision = revision.toString()
        const encoded = codec.encode(opening)
        expect(codec.decode(encoded)).toEqual(opening)
        expect(codec.encode(codec.decode(encoded))).toEqual(encoded)
        opening.guards[0].revision = (revision === 0n ? 1n : 0n).toString()
        expect(codec.decode(encoded).guards[0].revision).toBe(revision.toString())
      }
    )
  )
}, 120000)

it('accepts exactly 32 owned disclosure premises and rejects malformed sets with specific diagnostics', () => {
  const guards = Array.from({ length: 32 }, (_, i) => ({
    id: 'guard-' + i,
    revision: '0',
    failure: 'reset-required' as const
  }))
  expect(normalizeLookupDisclosureGuards(guards)).toEqual(guards)
  const owned = normalizeLookupDisclosureGuards(guards)
  guards[0].id = 'changed'
  expect(owned[0].id).toBe('guard-0')
  for (const input of [[], {}, [...owned, { ...owned[0], id: 'extra' }]])
    expect(() => normalizeLookupDisclosureGuards(input)).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Lookup opening requires bounded disclosure guards'
      })
    )
  expect(() => normalizeLookupDisclosureGuards([{ ...owned[0], failure: 'invalid' }])).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'Invalid lookup disclosure guard' })
  )
  expect(() => normalizeLookupDisclosureGuards([owned[0], owned[0]])).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Lookup opening repeats a disclosure guard'
    })
  )
  const { value, codec } = fixture()
  value.guards = owned
  expect(codec.decode(codec.encode(value))).toEqual(value)
})

it('rejects every independently changed partial cursor and permits omission of optional rule selection', () => {
  const { value, codec, cursor } = fixture()
  delete value.open.requiredRulesDigest
  expect(codec.normalize(value)).toEqual(value)
  value.first.snapshotComplete = false
  for (const position of [
    { phase: 'snapshot' as const, watermark: '4', after: '01' },
    { phase: 'live' as const, through: '5' }
  ]) {
    value.first.cursor = cursor.seal(position)
    expect(() => codec.normalize(value)).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Incomplete snapshot lost its scan position'
      })
    )
  }
})

it('keeps each persisted column independently bounded and identifies unsupported trust', () => {
  const { value, codec, source } = fixture()
  const columns = codec.encode(value)
  for (const [name, maximum] of [
    ['metadata', 65536],
    ['open', 1048576],
    ['contract', 524288],
    ['first', 4194304]
  ] as const) {
    const padded = {
      ...columns,
      [name]: columns[name] + ' '.repeat(maximum + 1 - Buffer.byteLength(columns[name]))
    }
    expect(() => codec.decode(padded)).toThrow(expect.objectContaining({ code: 'limited' }))
  }
  for (const change of [{ kind: 'topic' }, { profile: 'urn:example:other' }])
    expect(
      () =>
        new LookupSessionCodec({
          ...source.selection,
          ...change
        } as OutputCapabilityRecoveryRequest)
    ).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: 'Lookup session requires the live profile'
      })
    )
  expect(
    () =>
      new LookupSessionCodec({ ...source.selection, supportedExtensions: ['urn:example:critical'] })
  ).toThrow(
    expect.objectContaining({
      code: 'unsupported',
      message: 'Base lookup sessions implement no critical extensions'
    })
  )
})
