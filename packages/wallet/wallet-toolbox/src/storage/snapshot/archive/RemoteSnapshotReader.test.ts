import { openRemoteSnapshot } from './openRemoteSnapshot'
import { label, remoteReaderFixture } from '../../../../test/utils/remoteSnapshotReaderFixtures'
import { snapshotArchiveTables } from './SnapshotArchive'
import type { WalletSnapshotCursor } from '../WalletReadSnapshot'

afterEach(() => jest.restoreAllMocks())

test('verified table positioning slices rows and bytes without downloading earlier tables', async () => {
  const rows = Array.from({ length: 35 }, (_, index) => label(index + 1))
  const fixture = remoteReaderFixture(rows, 'txLabels', 17)
  const view = (await openRemoteSnapshot(fixture.transport))!
  try {
    const first = await view.readPage('txLabels', undefined, { maxRows: 5 })
    expect(first.rows).toEqual(rows.slice(0, 5))
    expect(first.done).toBe(false)
    expect(first.cursor).toEqual({
      version: 1,
      snapshotId: view.snapshotId,
      table: 'txLabels',
      after: [5],
      archivePosition: { version: 1, archiveId: fixture.directory.archiveId, sequence: 8, rowOffset: 5 }
    })
    expect(first.payloadBytes).toBe(5 * (6 * 64 + 'label-1'.length * 2))
    expect(await view.readPage('txLabels', undefined, { maxRows: 5 })).toEqual(first)
    const collected = [...first.rows]
    let page = first
    while (!page.done) {
      page = await view.readPage('txLabels', page.cursor, { maxRows: 5 })
      collected.push(...page.rows)
    }
    expect(collected).toEqual(rows)
    const requested = fixture.rpc.mock.calls
      .filter(([method]) => method === 'readSnapshotArchivePage')
      .map(([, params]) => (params[0] as { sequence: number }).sequence)
    expect(requested).toEqual([8, 9, 10])
    expect((await view.readPage('txLabels', page.cursor)).rows).toEqual([])
    expect((await view.readPage('txLabels', page.cursor)).done).toBe(true)
    expect(view.sourceStorage.storageIdentityKey).toBe('original-storage')
    expect(view.user.activeStorage).toBe('historical-primary')
    expect(view.isOpen).toBe(true)
  } finally {
    await view.close()
  }
  expect(view.isOpen).toBe(false)
  await expect(view.closed).resolves.toBeUndefined()
  expect(fixture.rpc.mock.calls.filter(([method]) => method === 'cancelSnapshotArchiveRequest')).toHaveLength(1)
})

test('every empty table still authenticates and decodes its terminal frame', async () => {
  const fixture = remoteReaderFixture([])
  const view = (await openRemoteSnapshot(fixture.transport))!
  try {
    for (const table of snapshotArchiveTables)
      expect(await view.readPage(table)).toEqual({ rows: [], payloadBytes: 0, cursor: undefined, done: true })
    expect(fixture.rpc.mock.calls.filter(([method]) => method === 'readSnapshotArchivePage')).toHaveLength(13)
  } finally {
    await view.close()
  }
})

test('returned metadata, dates, rows and cursor objects cannot mutate the private archive cache', async () => {
  const fixture = remoteReaderFixture([label(1), label(2)])
  const view = (await openRemoteSnapshot(fixture.transport))!
  try {
    const expected = await view.readPage('txLabels', undefined, { maxRows: 1 })
    const page = await view.readPage('txLabels', undefined, { maxRows: 1 })
    view.sourceStorage.created_at.setTime(0)
    view.user.updated_at.setTime(0)
    page.rows[0].created_at.setTime(0)
    page.rows[0].label = 'changed by caller'
    ;(page.cursor!.after as number[])[0] = 999
    ;(page.cursor!.archivePosition as { rowOffset: number }).rowOffset = 2
    expect(await view.readPage('txLabels', undefined, { maxRows: 1 })).toEqual(expected)
    expect(view.sourceStorage.created_at.getTime()).not.toBe(0)
    expect(view.user.updated_at.getTime()).not.toBe(0)
    expect((await view.readPage('txLabels', expected.cursor, { maxRows: 1 })).rows).toEqual([label(2)])
  } finally {
    await view.close()
  }
})

test('cursor positions must match the actual last key in the authenticated frame', async () => {
  const fixture = remoteReaderFixture([label(1), label(2), label(3)], 'txLabels', 2)
  const view = (await openRemoteSnapshot(fixture.transport))!
  try {
    const { cursor } = await view.readPage('txLabels', undefined, { maxRows: 1 })
    const changes = [
      { version: 2 },
      { snapshotId: 'c'.repeat(64) },
      { table: 'outputs' },
      { after: [2] },
      { archivePosition: { ...cursor!.archivePosition, archiveId: 'c'.repeat(64) } },
      { archivePosition: { ...cursor!.archivePosition, sequence: 7 } },
      { archivePosition: { ...cursor!.archivePosition, sequence: 10 } },
      { archivePosition: { ...cursor!.archivePosition, rowOffset: 0 } },
      { archivePosition: { ...cursor!.archivePosition, rowOffset: 3 } },
      { archivePosition: undefined }
    ]
    for (const change of changes)
      await expect(view.readPage('txLabels', { ...cursor!, ...change } as WalletSnapshotCursor)).rejects.toThrow()
    expect((await view.readPage('txLabels', cursor)).rows).toEqual([label(2), label(3)])
  } finally {
    await view.close()
  }
})

test('row budgets are inclusive, preserve continuation and never omit an oversized row', async () => {
  const fixture = remoteReaderFixture([label(1), label(2)])
  const view = (await openRemoteSnapshot(fixture.transport))!
  const charge = 6 * 64 + 'label-1'.length * 2
  try {
    await expect(view.readPage('txLabels', undefined, { maxBytes: charge - 1 })).rejects.toThrow('exceeds maxBytes')
    const first = await view.readPage('txLabels', undefined, { maxBytes: charge })
    expect(first.rows).toEqual([label(1)])
    expect(first.done).toBe(false)
    const last = await view.readPage('txLabels', first.cursor, { maxBytes: charge })
    expect(last.rows).toEqual([label(2)])
    expect(last.done).toBe(true)
    expect(last.payloadBytes).toBe(charge)
  } finally {
    await view.close()
  }
})

test('certificate-field continuation preserves source SQL collation instead of applying JavaScript order', async () => {
  const rows = ['a', 'Z', 'é', '😀'].map(fieldName => ({
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    userId: 7,
    certificateId: 1,
    fieldName,
    fieldValue: fieldName,
    masterKey: 'key'
  }))
  const fixture = remoteReaderFixture(rows, 'certificateFields', 2)
  const view = (await openRemoteSnapshot(fixture.transport))!
  try {
    let cursor: WalletSnapshotCursor | undefined
    for (const row of rows) {
      const page = await view.readPage('certificateFields', cursor, { maxRows: 1 })
      expect(page.rows).toEqual([row])
      expect(page.cursor!.after).toEqual([row.fieldName, 1])
      cursor = page.cursor
    }
  } finally {
    await view.close()
  }
})

test('cursor descriptors and numeric positions reject before invoking user accessors', async () => {
  const { transport } = remoteReaderFixture([label(1), label(2)])
  const view = (await openRemoteSnapshot(transport))!
  try {
    const { cursor } = await view.readPage('txLabels', undefined, { maxRows: 1 })
    const getter = jest.fn(() => {
      throw new Error('must not execute')
    })
    const afterGetter = Object.defineProperty({ ...cursor! }, 'after', { get: getter })
    const hiddenAfter = Object.defineProperty({ ...cursor! }, 'after', { value: [1], enumerable: false })
    const missingAfter = { ...cursor!, renamedAfter: [1] } as Record<string, unknown>
    delete missingAfter.after
    const arrayGetter = Object.defineProperty([1], '0', { get: getter })
    const sparse: unknown[] = []
    sparse.length = 1
    const invalid: unknown[] = [
      afterGetter,
      hiddenAfter,
      missingAfter,
      { ...cursor, after: arrayGetter },
      { ...cursor, after: sparse },
      { ...cursor, after: null },
      { ...cursor, after: [] },
      { ...cursor, after: [1, 2] },
      { ...cursor, archivePosition: null },
      { ...cursor, archivePosition: [] },
      { ...cursor, archivePosition: { ...cursor!.archivePosition, version: 2 } }
    ]
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      invalid.push({ ...cursor, after: [value] })
      invalid.push({ ...cursor, archivePosition: { ...cursor!.archivePosition, rowOffset: value } })
    }
    for (const value of [-1, 1.5, NaN, Infinity])
      invalid.push({ ...cursor, archivePosition: { ...cursor!.archivePosition, sequence: value } })
    for (const value of invalid)
      await expect(view.readPage('txLabels', value as WalletSnapshotCursor)).rejects.toThrow('verified position')
    expect(getter).not.toHaveBeenCalled()
    expect((await view.readPage('txLabels', cursor)).rows).toEqual([label(2)])
  } finally {
    await view.close()
  }
})

test('page limits reject invalid numbers without consuming remote work', async () => {
  const { transport, rpc } = remoteReaderFixture([label(1)])
  const view = (await openRemoteSnapshot(transport))!
  try {
    for (const field of ['maxRows', 'maxBytes'] as const) {
      const ceiling = field === 'maxRows' ? 1000 : 16777216
      for (const value of [0, -1, 1.5, NaN, Infinity, ceiling + 1])
        await expect(view.readPage('txLabels', undefined, { [field]: value })).rejects.toThrow(field)
    }
    expect(rpc.mock.calls.filter(([method]) => method === 'readSnapshotArchivePage')).toHaveLength(0)
    expect((await view.readPage('txLabels', undefined, { maxRows: 1000, maxBytes: 16777216 })).rows).toEqual([label(1)])
  } finally {
    await view.close()
  }
})

test('a delayed frame owns the only read slot through completion', async () => {
  const { transport } = remoteReaderFixture([label(1)])
  const view = (await openRemoteSnapshot(transport))!
  const original = transport.page.bind(transport)
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  jest.spyOn(transport, 'page').mockImplementation(async (...args) => {
    enter()
    await gate
    return original(...args)
  })
  const first = view.readPage('txLabels')
  void first.catch(() => undefined)
  try {
    await entered
    await expect(view.readPage('txLabels')).rejects.toThrow('already has a read in flight')
    release()
    expect((await first).rows).toEqual([label(1)])
    expect((await view.readPage('txLabels')).rows).toEqual([label(1)])
  } finally {
    release()
    await first.catch(() => undefined)
    await view.close()
  }
})

test('a read stops at conservative server expiry before the local rounded timer fires', async () => {
  jest.useFakeTimers()
  const monotonic = jest.spyOn(performance, 'now').mockReturnValue(0)
  const { transport, rpc } = remoteReaderFixture([label(1)])
  const view = (await openRemoteSnapshot(transport, { lifetimeMs: 1000 }))!
  try {
    monotonic.mockReturnValue(999.1)
    await expect(view.readPage('txLabels')).rejects.toThrow('Remote snapshot expired')
    await view.closed
    expect(rpc.mock.calls.filter(([method]) => method === 'readSnapshotArchivePage')).toHaveLength(0)
    expect(rpc.mock.calls.filter(([method]) => method === 'cancelSnapshotArchiveRequest')).toHaveLength(1)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    await view.close()
    jest.useRealTimers()
  }
})

test.each(['expiry', 'read'] as const)(
  '%s failure preserves a separate failed cleanup acknowledgement',
  async cause => {
    jest.useFakeTimers()
    const monotonic = jest.spyOn(performance, 'now').mockReturnValue(0)
    const { transport } = remoteReaderFixture([label(1)])
    const view = (await openRemoteSnapshot(transport, { lifetimeMs: 1000 }))!
    const cleanup = new Error('synthetic cancellation acknowledgement failure')
    const original = new Error('synthetic authenticated frame failure')
    const cancel = jest.spyOn(transport, 'cancelRequest').mockRejectedValue(cleanup)
    try {
      if (cause === 'expiry') monotonic.mockReturnValue(999.1)
      else jest.spyOn(transport, 'page').mockRejectedValue(original)
      const read = view.readPage('txLabels')
      if (cause === 'expiry') await expect(read).rejects.toThrow('Remote snapshot expired')
      else await expect(read).rejects.toBe(original)
      await expect(view.closed).rejects.toBe(cleanup)
      await expect(view.close()).rejects.toBe(cleanup)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      await view.close().catch(() => undefined)
      jest.useRealTimers()
    }
  }
)

test('composite certificate cursors bind each key and accept the inclusive Unicode field-name limit', async () => {
  const fieldName = '😀'.repeat(100)
  const rows = [1, 2, 3].map(certificateId => ({
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    userId: 7,
    certificateId,
    fieldName,
    fieldValue: 'value',
    masterKey: 'synthetic key'
  }))
  const { transport, rpc } = remoteReaderFixture(rows, 'certificateFields', 2)
  const view = (await openRemoteSnapshot(transport))!
  try {
    const first = await view.readPage('certificateFields', undefined, { maxRows: 1 })
    expect(first.rows).toEqual([rows[0]])
    expect(first.cursor!.after).toEqual([fieldName, 1])
    const reads = () => rpc.mock.calls.filter(([method]) => method === 'readSnapshotArchivePage').length
    const initialReads = reads()
    for (const after of [
      [fieldName + 'x', 1],
      ['a'.repeat(101), 1],
      [1, 1],
      [fieldName, 0],
      [fieldName, 1.5],
      [fieldName, '1']
    ]) {
      await expect(view.readPage('certificateFields', { ...first.cursor!, after })).rejects.toThrow('verified position')
      expect(reads()).toBe(initialReads)
    }
    for (const after of [
      ['other', 1],
      [fieldName, 2]
    ])
      await expect(view.readPage('certificateFields', { ...first.cursor!, after })).rejects.toThrow('verified position')
    const final = await view.readPage('certificateFields', first.cursor)
    expect(final.rows).toEqual(rows.slice(1))
    expect(final.cursor!.after).toEqual([fieldName, 3])
    expect(final.cursor!.archivePosition).toEqual({
      version: 1,
      archiveId: first.cursor!.archivePosition!.archiveId,
      sequence: first.cursor!.archivePosition!.sequence + 1,
      rowOffset: 1
    })
    expect(final.done).toBe(true)
  } finally {
    await view.close()
  }
})
