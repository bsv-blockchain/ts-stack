import { copySnapshotArchivePosition, copySnapshotCursor, sameSnapshotArchivePosition } from './SnapshotCursor'
import type { WalletSnapshotArchivePosition, WalletSnapshotCursor } from './WalletReadSnapshot'

const position: WalletSnapshotArchivePosition = { version: 1, archiveId: 'a'.repeat(64), sequence: 0, rowOffset: 1 }
const legacy: WalletSnapshotCursor = { version: 1, snapshotId: 'b'.repeat(64), table: 'txLabels', after: [1] }

test('legacy cursor JSON stays byte-identical while archive metadata and keys are detached', () => {
  expect(copySnapshotCursor(undefined)).toBeUndefined()
  const copiedLegacy = copySnapshotCursor(legacy)
  expect(JSON.stringify(copiedLegacy)).toBe(JSON.stringify(legacy))
  expect(copiedLegacy).not.toHaveProperty('archivePosition')
  expect(copiedLegacy.after).not.toBe(legacy.after)
  const current = { ...legacy, archivePosition: position }
  const copy = copySnapshotCursor(current)
  expect(copy).toEqual(current)
  expect(copy.archivePosition).not.toBe(position)
  expect(copy.after).not.toBe(current.after)
  expect(Object.keys(copy.archivePosition!)).toEqual(['version', 'archiveId', 'sequence', 'rowOffset'])
  expect(copySnapshotArchivePosition({ ...position, sequence: 4095, rowOffset: 1000 })).toEqual({
    ...position,
    sequence: 4095,
    rowOffset: 1000
  })
})

test.each([
  { version: 2 },
  { archiveId: '' },
  { archiveId: 'A'.repeat(64) },
  { archiveId: 'g'.repeat(64) },
  { archiveId: 'a'.repeat(63) },
  { archiveId: 'a'.repeat(65) },
  { archiveId: 1 },
  { sequence: -1 },
  { sequence: 4096 },
  { sequence: 1.5 },
  { sequence: NaN },
  { sequence: '1' },
  { rowOffset: 0 },
  { rowOffset: 1001 },
  { rowOffset: 1.5 },
  { rowOffset: NaN },
  { rowOffset: '1' },
  { extra: true },
  { [Symbol('extra')]: true }
])('position accepts only bounded exact metadata %p', change => {
  expect(() => copySnapshotArchivePosition({ ...position, ...change })).toThrow('bounded version-one archive position')
})

test.each([undefined, null, [], 'position', 1, true])('rejects non-record positions %p', value => {
  expect(() => copySnapshotArchivePosition(value)).toThrow('bounded version-one archive position')
})

test('positions require own enumerable data without invoking getters', () => {
  for (const name of Object.keys(position)) {
    const value = { ...position } as Record<string, unknown>
    delete value[name]
    expect(() => copySnapshotArchivePosition(value)).toThrow()
    Object.defineProperty(value, name, { value: Reflect.get(position, name), configurable: true })
    expect(() => copySnapshotArchivePosition(value)).toThrow()
    Object.defineProperty(value, name, {
      enumerable: true,
      get: () => {
        throw new Error('Getter must not run')
      }
    })
    expect(() => copySnapshotArchivePosition(value)).toThrow('bounded version-one archive position')
  }
  expect(() => copySnapshotArchivePosition(Object.create(position))).toThrow()
})

test('acknowledgements compare every archive-position binding and distinguish missing metadata', () => {
  expect(sameSnapshotArchivePosition(undefined, undefined)).toBe(true)
  expect(sameSnapshotArchivePosition(position, undefined)).toBe(false)
  expect(sameSnapshotArchivePosition(undefined, position)).toBe(false)
  expect(sameSnapshotArchivePosition(position, { ...position })).toBe(true)
  expect(
    sameSnapshotArchivePosition(position, { rowOffset: 1, sequence: 0, archiveId: 'a'.repeat(64), version: 1 })
  ).toBe(true)
  for (const change of [{ version: 2 }, { archiveId: 'b'.repeat(64) }, { sequence: 1 }, { rowOffset: 2 }])
    expect(sameSnapshotArchivePosition(position, { ...position, ...change } as WalletSnapshotArchivePosition)).toBe(
      false
    )
})
