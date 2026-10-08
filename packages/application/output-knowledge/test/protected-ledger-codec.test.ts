import { expect, it } from '@jest/globals'
import {
  protectedAddress,
  protectedConfiguration,
  protectedDigest,
  protectedHeader,
  protectedInteger,
  protectedInventory,
  protectedNativeInventory,
  protectedLedgerKinds,
  protectedRevisionCapacity,
  protectedUpdates,
  protectedValue,
  type ProtectedLedgerHeader
} from '../src/private/ProtectedLedgerCodec.js'
import { configuration } from './protected-ledger-fixture.js'

it('retains UTF-8 SHA-256 framing independently of ledger encryption', () => {
  expect(protectedDigest('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
})
it('accepts every exact completion reservation boundary', () => {
  expect(protectedUpdates(0)).toBe(0)
  expect(protectedUpdates(64)).toBe(64)
  expect(protectedRevisionCapacity('0', 262144)).toBeUndefined()
  expect(protectedRevisionCapacity('18446744073709551615', 0)).toBeUndefined()
  expect(protectedRevisionCapacity('18446744073709551613', 2)).toBeUndefined()
})
it.each([-1, 65, 1.5, Number.NaN, Infinity, '1', null, undefined, true])(
  'rejects invalid per-record completion promises %p',
  value => {
    expect(() => protectedUpdates(value)).toThrow('Invalid protected record completion reservation')
  }
)
it.each([-1, 262145, 1.5, Number.NaN, Infinity, '1', null, undefined])(
  'rejects invalid ledger completion promises %p',
  value => {
    expect(() => protectedRevisionCapacity('0', value as number)).toThrow(
      'Invalid protected ledger completion capacity'
    )
  }
)
it('rejects promised completion beyond the last global revision without rounding', () => {
  expect(() => protectedRevisionCapacity('18446744073709551614', 2)).toThrow(
    expect.objectContaining({
      code: 'limited',
      message: 'Protected ledger must retain promised completion revisions'
    })
  )
})
it('accepts inclusive positive integer capacities and rejects nonintegers/types', () => {
  expect(protectedInteger(1, 8)).toBe(1)
  expect(protectedInteger(8, 8)).toBe(8)
  for (const value of [0, -1, 9, 1.5, Number.NaN, Infinity, '1', null, undefined, true])
    expect(() => protectedInteger(value, 8)).toThrow('Invalid protected ledger capacity')
})
it('rejects invalid address kinds and bounded extensions without evaluating accessors', () => {
  expect(() => protectedAddress({ kind: 'invalid', key: '11'.repeat(32) })).toThrow(
    'Invalid protected ledger record kind'
  )
  expect(() =>
    protectedAddress({ kind: 'publication', key: '11'.repeat(32), extra: 'x'.repeat(1024) })
  ).toThrow(expect.objectContaining({ code: 'limited' }))
})
it.each([null, [], 'one', 1, true])('rejects nonobject namespace bindings %p', binding => {
  expect(() => protectedConfiguration({ ...configuration, binding: binding as never })).toThrow(
    'Invalid protected ledger binding'
  )
})
it('enforces the complete configuration and plaintext byte bounds and returns owned objects', () => {
  expect(() =>
    protectedConfiguration({ ...configuration, binding: { name: 'x'.repeat(32768) } })
  ).toThrow(expect.objectContaining({ code: 'limited' }))
  expect(() => protectedValue({ name: 'x'.repeat(20) }, 16)).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
  expect(protectedValue({ name: 'é' }, 13)).toEqual({ text: '{"name":"é"}', value: { name: 'é' } })
  const original = { nested: { value: 1 } },
    owned = protectedValue(original, 64)
  original.nested.value = 2
  expect(owned.value).toEqual({ nested: { value: 1 } })
})
it.each([null, [], 'one', 1, true])('rejects nonobject protected values %p', value => {
  expect(() => protectedValue(value, 64)).toThrow('Protected ledger record must be an object')
})
const header = (): ProtectedLedgerHeader => ({
  kind: 'publication',
  key: '11'.repeat(32),
  revision: '1',
  reservedBytes: 16,
  reservedUpdates: 2,
  bytes: 16,
  sealedDigest: '22'.repeat(32)
})
it('rejects zero record revision with the retained unavailable classification', () => {
  expect(() => protectedHeader({ ...header(), revision: '0' }, 16)).toThrow(
    expect.objectContaining({ code: 'unavailable', message: 'Invalid protected record revision' })
  )
  expect(protectedHeader({ ...header() }, 16)).toEqual(header())
})
it('authenticates every ordered inventory header and reports exact reservation totals', () => {
  const second = { ...header(), key: '33'.repeat(32), reservedBytes: 32, reservedUpdates: 3 }
  const first = protectedInventory([header(), second], 2, 48)
  expect(first).toMatchObject({ records: 2, reservedBytes: 48, reservedUpdates: 5 })
  expect(first.inventory).toBe('e4235ef5d426d63ce4e9c39d519f54fe11b36edb99ff022cb2b59a916eccd236')
  expect(protectedInventory([second, header()], 2, 48).inventory).not.toBe(first.inventory)
  expect(
    protectedInventory([header(), { ...second, sealedDigest: '44'.repeat(32) }], 2, 48).inventory
  ).not.toBe(first.inventory)
})
it('rejects each independent inventory capacity violation without silently losing promises', () => {
  expect(() => protectedInventory([header(), header()], 1, 32)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Protected ledger record capacity exceeded'
    })
  )
  expect(() => protectedInventory([{ ...header(), bytes: 17 }], 1, 16)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Protected record exceeds its reserved capacity'
    })
  )
  expect(() => protectedInventory([header(), header()], 2, 31)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Protected ledger allocation capacity exceeded'
    })
  )
  expect(protectedInventory([header()], 1, 16)).toMatchObject({
    reservedBytes: 16,
    reservedUpdates: 2,
    records: 1
  })
})

it('owns every supported scalar header independently and retains all revision and capacity guards', () => {
  for (const kind of protectedLedgerKinds) {
    const input = { ...header(), kind }
    const owned = protectedHeader(input, 16)
    expect(owned).toEqual(input)
    owned.key = '33'.repeat(32)
    expect(input.key).toBe('11'.repeat(32))
    expect(protectedHeader(input, 16).key).toBe('11'.repeat(32))
    for (const patch of [
      { revision: '0' },
      { reservedBytes: 0 },
      { reservedBytes: 17 },
      { reservedUpdates: 65 },
      { bytes: 0 },
      { bytes: 17 },
      { sealedDigest: 'invalid' }
    ])
      expect(() => protectedHeader({ ...input, ...patch }, 16)).toThrow()
  }
})

it('preserves ownership and error classifications for every malformed native address representation', () => {
  const capture = (work: () => unknown) => {
    try {
      return { ok: true, value: work() }
    } catch (error) {
      return {
        ok: false,
        code: (error as { code?: string }).code,
        name: (error as Error).name,
        message: (error as Error).message
      }
    }
  }
  const coercions: string[] = []
  const guarded = Object.defineProperty({}, 'toString', {
    enumerable: true,
    get() {
      coercions.push('toString')
      throw new Error('Unexpected native field coercion')
    }
  })
  const kinds: unknown[] = [
    guarded,
    'publication',
    undefined,
    null,
    true,
    1,
    {},
    [],
    () => {},
    '',
    'unknown',
    'PUBLICATION',
    'a'.repeat(1024),
    '\ud800',
    'a\n',
    'a"'
  ]
  const keys: unknown[] = [
    guarded,
    'a'.repeat(1024),
    undefined,
    null,
    true,
    1,
    {},
    [],
    () => {},
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    'a'.repeat(63) + '\ud800',
    'a'.repeat(63) + '\n'
  ]
  for (const kind of kinds)
    for (const key of keys) {
      const address = { kind, key }
      const expected = capture(() => protectedAddress(address))
      const actual = capture(() => protectedHeader({ ...header(), ...address }, 16))
      expect(actual).toEqual(expected)
    }
  expect(coercions).toEqual([])
})

it('captures native fields once in order and retains original getter exceptions', () => {
  const calls: string[] = []
  const input = { ...header() }
  Object.defineProperty(input, 'kind', {
    get() {
      calls.push('kind')
      return 'publication'
    }
  })
  Object.defineProperty(input, 'key', {
    configurable: true,
    get() {
      calls.push('key')
      return '11'.repeat(32)
    }
  })
  expect(protectedHeader(input, 16)).toEqual(header())
  expect(calls).toEqual(['kind', 'key'])
  const failure = new Error('native key read failed')
  Object.defineProperty(input, 'key', {
    get() {
      calls.push('key')
      throw failure
    }
  })
  calls.length = 0
  expect(() => protectedHeader(input, 16)).toThrow(failure)
  expect(calls).toEqual(['kind', 'key'])
})

it('retains live kind membership and the original Unicode and byte-bound fallback', () => {
  const kinds = protectedLedgerKinds as unknown as string[]
  const original = [...kinds]
  try {
    for (const kind of ['future-kind', 'a'.repeat(100), 'é', '\ud800', 'a'.repeat(1024)]) {
      kinds.push(kind)
      const address = { kind, key: '11'.repeat(32) }
      if (kind === '\ud800' || kind.length === 1024) {
        expect(() => protectedHeader({ ...header(), ...address }, 16)).toThrow()
        expect(() => protectedAddress(address)).toThrow()
      } else {
        expect(protectedHeader({ ...header(), ...address }, 16)).toEqual({
          ...header(),
          ...protectedAddress(address)
        })
      }
      kinds.pop()
    }
    kinds.splice(kinds.indexOf('publication'), 1)
    expect(() => protectedHeader({ ...header() }, 16)).toThrow(
      'Invalid protected ledger record kind'
    )
  } finally {
    kinds.splice(0, kinds.length, ...original)
  }
})

it('native inventory retains the independent ordered digest and exact fresh ownership', () => {
  const rows = [
    { ...header() },
    { ...header(), key: '33'.repeat(32), reservedBytes: 32, reservedUpdates: 3 }
  ]
  const result = protectedNativeInventory(rows, 32, 2, 48)
  expect(result.actual).toEqual({
    inventory: 'e4235ef5d426d63ce4e9c39d519f54fe11b36edb99ff022cb2b59a916eccd236',
    records: 2,
    reservedBytes: 48,
    reservedUpdates: 5
  })
  rows[0].key = '55'.repeat(32)
  expect(result.headers[0]).toEqual(header())
  expect(protectedInventory(result.headers, 2, 48)).toEqual(result.actual)
})
it('native inventory agrees with general framing for every kind and scalar boundary', () => {
  for (const kind of protectedLedgerKinds) {
    for (const revision of ['1', '18446744073709551615']) {
      for (const reservedBytes of [1, Number.MAX_SAFE_INTEGER]) {
        for (const reservedUpdates of [0, 64]) {
          const rows = [
            { ...header(), kind, revision, reservedBytes, bytes: reservedBytes, reservedUpdates }
          ]
          const result = protectedNativeInventory(
            rows,
            Number.MAX_SAFE_INTEGER,
            1,
            Number.MAX_SAFE_INTEGER
          )
          expect(result.actual).toEqual(
            protectedInventory(result.headers, 1, Number.MAX_SAFE_INTEGER)
          )
        }
      }
    }
  }
  expect(protectedNativeInventory([], 16, 0, 0).actual).toEqual(protectedInventory([], 0, 0))
})
it('native inventory retains fresh row refusals before the original aggregate fences', () => {
  expect(() =>
    protectedNativeInventory([{ ...header() }, { ...header(), revision: '0' }], 16, 1, 32)
  ).toThrow(
    expect.objectContaining({ code: 'unavailable', message: 'Invalid protected record revision' })
  )
  expect(() => protectedNativeInventory([{ ...header() }, { ...header() }], 16, 1, 32)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Protected ledger record capacity exceeded'
    })
  )
  expect(() => protectedNativeInventory([{ ...header(), bytes: 17 }], 17, 1, 16)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Protected record exceeds its reserved capacity'
    })
  )
  expect(() => protectedNativeInventory([{ ...header() }, { ...header() }], 16, 2, 31)).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Protected ledger allocation capacity exceeded'
    })
  )
  expect(() =>
    protectedNativeInventory([{ ...header(), sealedDigest: 'not-hex' }], 16, 1, 16)
  ).toThrow()
})

it('native inventory retains canonical framing for live kind extensions', () => {
  const kinds = protectedLedgerKinds as unknown as string[]
  const original = [...kinds]
  try {
    for (const kind of ['future-kind', 'a'.repeat(100), 'é', 'quoted"kind', 'line\nkind']) {
      kinds.push(kind)
      const result = protectedNativeInventory([{ ...header(), kind }], 16, 1, 16)
      expect(result.actual).toEqual(protectedInventory(result.headers, 1, 16))
      kinds.pop()
    }
  } finally {
    kinds.splice(0, kinds.length, ...original)
  }
})
