import { expect, it } from '@jest/globals'
import {
  protectedAddress,
  protectedConfiguration,
  protectedDigest,
  protectedHeader,
  protectedInteger,
  protectedInventory,
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
