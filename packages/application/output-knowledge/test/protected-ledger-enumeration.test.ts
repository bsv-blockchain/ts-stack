import { expect, it } from '@jest/globals'
import { fixture, change, clock, authorize, address } from './protected-ledger-fixture.js'
import type { ProtectedLedgerKind } from '../src/private/ProtectedLedgerCodec.js'

it('enumerates owned bounded metadata in key order and isolates record kinds', () => {
  const f = fixture()
  f.ledger.commit(
    '0',
    [change(3), change(1), change(2), { ...change(1), kind: 'quote' }],
    clock,
    authorize
  )
  const page = f.ledger.enumerate('publication', null, 2, clock, authorize)
  expect(page).toEqual({
    revision: '1',
    observedAt: '100',
    entries: [
      { ...address(1), revision: '1' },
      { ...address(2), revision: '1' }
    ],
    next: address(2).key
  })
  expect(f.ledger.enumerate('publication', page.next, 2, clock, authorize)).toEqual({
    revision: '1',
    observedAt: '100',
    entries: [{ ...address(3), revision: '1' }],
    next: null
  })
  page.entries[0].key = 'ff'.repeat(32)
  expect(f.ledger.enumerate('publication', null, 1, clock, authorize).entries[0].key).toBe(
    address(1).key
  )
  expect(f.ledger.enumerate('quote', null, 64, clock, authorize).entries).toEqual([
    { kind: 'quote', key: address(1).key, revision: '1' }
  ])
})
it('includes the zero key on a fresh pass, handles exact boundaries and returns truthful empty pages', () => {
  const f = fixture()
  expect(f.ledger.enumerate('publication', null, 1, clock, authorize)).toEqual({
    revision: '0',
    observedAt: '100',
    entries: [],
    next: null
  })
  f.ledger.commit('0', [change(0)], clock, authorize)
  expect(f.ledger.enumerate('publication', null, 1, clock, authorize).entries[0].key).toBe(
    address(0).key
  )
  expect(f.ledger.enumerate('publication', address(0).key, 1, clock, authorize).entries).toEqual([])
})
it('wraps to discover intervening inserts without claiming a retained snapshot', () => {
  const f = fixture()
  f.ledger.commit('0', [change(2), change(4)], clock, authorize)
  const first = f.ledger.enumerate('publication', null, 1, clock, authorize)
  const second = f.reopen()
  second.commit('1', [change(1), change(3)], clock, authorize)
  expect(f.ledger.enumerate('publication', first.next, 1, clock, authorize)).toMatchObject({
    revision: '2',
    entries: [{ key: address(3).key }],
    next: address(3).key
  })
  expect(f.ledger.enumerate('publication', null, 1, clock, authorize).entries[0].key).toBe(
    address(1).key
  )
})
it('reauthorizes under the physical gate and persists monotonic clock even after denial', () => {
  const f = fixture()
  expect(() =>
    f.ledger.enumerate(
      'publication',
      null,
      1,
      () => '200',
      () => {
        throw new Error('denied')
      }
    )
  ).toThrow('denied')
  expect(f.ledger.enumerate('publication', null, 1, () => '100', authorize).observedAt).toBe('200')
  f.ledger.close()
  expect(f.reopen().enumerate('publication', null, 1, () => '0', authorize).observedAt).toBe('200')
})
it.each([0, 65, -1, 1.5, Number.NaN, Infinity])('rejects invalid page capacity %p', maximum => {
  const f = fixture()
  expect(() => f.ledger.enumerate('publication', null, maximum, clock, authorize)).toThrow(
    'capacity'
  )
})
it('rejects unknown kinds, invalid cursors and reentrant enumeration', () => {
  const f = fixture()
  expect(() =>
    f.ledger.enumerate('unknown' as ProtectedLedgerKind, null, 1, clock, authorize)
  ).toThrow()
  expect(() => f.ledger.enumerate('publication', 'invalid', 1, clock, authorize)).toThrow()
  expect(() =>
    f.ledger.enumerate('publication', null, 1, clock, () => {
      f.ledger.enumerate('publication', null, 1, clock, authorize)
    })
  ).toThrow('reentered')
})
