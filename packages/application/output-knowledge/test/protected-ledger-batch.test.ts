import { expect, it } from '@jest/globals'
import { canonicalOutputJSON } from '@bsv/sdk'
import type { ProtectedLedgerChange } from '../src/private/ProtectedLedgerCodec.js'
import {
  address,
  authorize,
  change,
  clock,
  configuration,
  fixture
} from './protected-ledger-fixture.js'

const large = {
  ...configuration,
  maximumRecordBytes: 2 * 1024 * 1024,
  maximumReservedBytes: 8 * 1024 * 1024
}
function exactBytes(changes: ProtectedLedgerChange[]) {
  return (
    2 +
    changes.length -
    1 +
    changes.reduce((n, c) => n + Buffer.byteLength(canonicalOutputJSON(c)), 0)
  )
}
it('preserves default four-MiB ownership and explicitly commits a larger local plan atomically', () => {
  const f = fixture(large)
  const changes = Array.from({ length: 3 }, (_, i) =>
    change(i, { secret: 'a'.repeat(1500000) }, 1600000)
  )
  expect(() => f.ledger.commit('0', changes, clock, authorize)).toThrow('Output JSON byte limit')
  expect(f.reopen().read([address(0)], clock, authorize).revision).toBe('0')
  const maximumBatchBytes = exactBytes(changes)
  expect(() =>
    f.ledger.commit('0', changes, clock, authorize, { maximumBatchBytes: maximumBatchBytes - 1 })
  ).toThrow('local batch exceeds')
  expect(f.ledger.commit('0', changes, clock, authorize, { maximumBatchBytes })).toBe('1')
  expect(
    f
      .reopen()
      .read(
        changes.map(({ kind, key }) => ({ kind, key })),
        clock,
        authorize
      )
      .records.map(r => r?.value)
  ).toEqual(changes.map(c => c.value))
})
it.each([0, -1, 1.1, NaN, Infinity, '100', null, 8 * 1024 * 1024 + 65537])(
  'rejects invalid or uninstalled explicit batch bound %p before callbacks',
  maximumBatchBytes => {
    const f = fixture(large)
    let calls = 0
    expect(() =>
      f.ledger.commit(
        '0',
        [change()],
        () => {
          calls++
          return '101'
        },
        authorize,
        { maximumBatchBytes: maximumBatchBytes as number }
      )
    ).toThrow()
    expect(calls).toBe(0)
    expect(f.reopen().read([address()], clock, authorize).revision).toBe('0')
  }
)
it('accepts the inclusive installed bound without raising the SDK protocol ceiling', () => {
  const f = fixture(large)
  expect(
    f.ledger.commit('0', [change()], clock, authorize, {
      maximumBatchBytes: large.maximumReservedBytes + 65536
    })
  ).toBe('1')
  expect(() => canonicalOutputJSON({}, { bytes: 4194305 })).toThrow(
    'Invalid output JSON resource limit'
  )
})
it.each(['extra', 'missing', 'accessor'] as const)(
  'owns and closes local batch options: %s',
  kind => {
    const f = fixture(large)
    let calls = 0
    const input: unknown =
      kind === 'extra'
        ? { maximumBatchBytes: 1000, other: true }
        : kind === 'missing'
          ? {}
          : Object.defineProperty({}, 'maximumBatchBytes', {
              enumerable: true,
              get: () => {
                calls++
                return 1000
              }
            })
    expect(() =>
      f.ledger.commit('0', [change()], clock, authorize, input as { maximumBatchBytes: number })
    ).toThrow()
    expect(calls).toBe(0)
  }
)
it.each([
  'empty',
  'nonarray',
  '65',
  'sparse',
  'accessor',
  'symbol',
  'hidden',
  'extra',
  'prototype',
  'subclass',
  'null-prototype'
] as const)('refuses unsafe local batch %s before touching state', kind => {
  const f = fixture(large)
  let calls = 0
  let changes: unknown = [change()]
  if (kind === 'empty') changes = []
  if (kind === 'nonarray') changes = { 0: change(), length: 1 }
  if (kind === '65') changes = Array.from({ length: 65 }, (_, i) => change(i))
  if (kind === 'sparse') {
    const sparse: unknown[] = []
    sparse.length = 1
    changes = sparse
  }
  if (kind === 'accessor')
    Object.defineProperty(changes, '0', {
      enumerable: true,
      get: () => {
        calls++
        return change()
      }
    })
  if (kind === 'symbol') Object.defineProperty(changes, Symbol('extra'), { value: 1 })
  if (kind === 'hidden') Object.defineProperty(changes, '0', { enumerable: false })
  if (kind === 'extra') Object.defineProperty(changes, 'extra', { value: 1 })
  if (kind === 'prototype') Object.setPrototypeOf(changes, Object.create(Array.prototype))
  if (kind === 'subclass') {
    class CustomArray extends Array<ProtectedLedgerChange> {}
    changes = new CustomArray(change())
  }
  if (kind === 'null-prototype') Object.setPrototypeOf(changes, null)
  expect(() =>
    f.ledger.commit(
      '0',
      changes as ProtectedLedgerChange[],
      () => {
        calls++
        return '101'
      },
      authorize,
      { maximumBatchBytes: 10000 }
    )
  ).toThrow()
  expect(calls).toBe(0)
  expect(f.reopen().read([address()], clock, authorize).revision).toBe('0')
})
it('retains duplicate/CAS/capacity/guard refusal and full rollback for the explicit path', () => {
  const f = fixture({ ...large, maximumReservedBytes: 1000 })
  const options = { maximumBatchBytes: 66536 }
  expect(() => f.ledger.commit('0', [change(1), change(1)], clock, authorize, options)).toThrow(
    'repeats an address'
  )
  expect(() => f.ledger.commit('1', [change(1)], clock, authorize, options)).toThrow(
    'changed before commit'
  )
  expect(() =>
    f.ledger.commit('0', [change(1), change(2, undefined, 1000)], clock, authorize, options)
  ).toThrow('capacity is full')
  expect(() =>
    f.ledger.commit(
      '0',
      [change(1)],
      clock,
      () => {
        throw new Error('access revoked')
      },
      options
    )
  ).toThrow('access revoked')
  expect(f.reopen().read([address(1), address(2)], clock, authorize)).toEqual({
    revision: '0',
    observedAt: '100',
    records: [undefined, undefined]
  })
})
it('owns record values before synchronous trusted callbacks can change caller objects', () => {
  const f = fixture(large),
    c = change()
  expect(
    f.ledger.commit(
      '0',
      [c],
      () => {
        c.value.secret = 'changed'
        return '100'
      },
      authorize,
      { maximumBatchBytes: 4096 }
    )
  ).toBe('1')
  expect(f.reopen().read([address()], clock, authorize).records[0]?.value.secret).toBe(
    'synthetic-material'
  )
})
it('counts UTF-8 and array framing exactly and keeps the enclosing depth limit', () => {
  const f = fixture(large),
    changes = [change(1, { secret: 'é' }), change(2, { secret: 'x' })]
  const bytes = exactBytes(changes)
  expect(() =>
    f.ledger.commit('0', changes, clock, authorize, { maximumBatchBytes: bytes - 1 })
  ).toThrow('local batch exceeds')
  expect(f.ledger.commit('0', changes, clock, authorize, { maximumBatchBytes: bytes })).toBe('1')
  const c = change(3)
  let v: any = { end: true }
  for (let i = 0; i < 31; i++) v = { nested: v }
  c.value = v
  expect(() => f.ledger.commit('1', [c], clock, authorize, { maximumBatchBytes: 65536 })).toThrow(
    'JSON depth limit'
  )
})

it.each(['default', 'explicit'] as const)(
  '%s writes retain literal special-key/Unicode bytes and own values before callbacks',
  mode => {
    const f = fixture(),
      value = {
        '2': 'two',
        '10': 'ten',
        ['__proto__']: { marker: 'data' },
        nested: [-0, { constructor: 'own', text: '𝄞\n"' }]
      },
      input: ProtectedLedgerChange = { ...change(), reservedBytes: 512, value }
    expect(
      f.ledger.commit(
        '0',
        [input],
        () => {
          value['2'] = 'changed'
          value['__proto__'].marker = 'changed'
          return '100'
        },
        authorize,
        mode === 'explicit' ? { maximumBatchBytes: 1024 } : undefined
      )
    ).toBe('1')
    const stored = f.reopen().read([address()], clock, authorize).records[0]!.value
    expect(canonicalOutputJSON(stored)).toBe(
      '{"10":"ten","2":"two","__proto__":{"marker":"data"},"nested":[0,{"constructor":"own","text":"𝄞\\n\\\""}]}'
    )
    expect(Object.getPrototypeOf(stored)).toBeNull()
    expect(Object.getPrototypeOf(stored['__proto__'])).toBeNull()
  }
)
