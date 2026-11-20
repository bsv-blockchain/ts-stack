import { RemoteSnapshotSyncDestination, RemoteSnapshotSyncTransferCleanupError } from './RemoteSnapshotSyncDestination'
import {
  parseRemoteSnapshotSyncPage,
  parseRemoteSnapshotSyncStagedPage,
  remoteSnapshotSyncPartBytes
} from './RemoteSnapshotSyncProtocol'
import type { SnapshotSyncCheckpoint, SnapshotSyncSource } from './SnapshotSync'
import type { WalletSnapshotPage } from './WalletReadSnapshot'

const identity = '02' + '11'.repeat(32),
  when = new Date('2026-10-06T00:00:00.000Z')
function fixture() {
  const checkpoint: SnapshotSyncCheckpoint = {
    version: 1,
    sessionId: 'b'.repeat(64),
    snapshotId: 'a'.repeat(64),
    identityKey: identity,
    sourceStorageIdentityKey: 'source',
    destinationStorageIdentityKey: 'destination',
    tableIndex: 3,
    sequence: 3,
    done: false
  }
  const source: SnapshotSyncSource = {
    version: 1,
    snapshotId: checkpoint.snapshotId,
    expiresAt: Date.now() + 60000,
    sourceStorage: {
      storageIdentityKey: 'source',
      storageName: 'source',
      chain: 'test',
      dbtype: 'SQLite',
      maxOutputScript: 1024,
      created_at: when,
      updated_at: when
    },
    user: { userId: 7, identityKey: identity, created_at: when, updated_at: when, activeStorage: 'source' }
  }
  const page: WalletSnapshotPage<'txLabels'> = {
    rows: [{ created_at: when, updated_at: when, txLabelId: 9, userId: 7, label: 'kept', isDeleted: true }],
    payloadBytes: 512,
    done: true,
    cursor: { version: 1, snapshotId: checkpoint.snapshotId, table: 'txLabels', after: [9] }
  }
  const rpc = jest.fn(async (_method: string, _params: unknown[], _signal: AbortSignal): Promise<unknown> => checkpoint)
  const peer = jest.fn(async () => ({ storageIdentityKey: 'destination', supportsDestination: true }))
  const destination = new RemoteSnapshotSyncDestination(rpc, peer, async () => undefined)
  return { source, checkpoint, page, rpc, peer, destination }
}

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

test('prepared transport bytes are detached and one-use without pretending an RPC log is a checkpoint', async () => {
  const f = fixture()
  await f.destination.begin(f.source, 'source')
  const apply = await f.destination.prepare(f.checkpoint, f.page)
  f.page.rows[0].label = 'changed-after-prepare'
  f.page.cursor = { ...f.page.cursor!, after: [99] }
  f.rpc.mockImplementationOnce(async (method, params) => {
    expect(method).toBe('commitSnapshotSyncPage')
    const accepted = parseRemoteSnapshotSyncPage(params[1], f.checkpoint, 7)
    expect(accepted.rows[0]).toMatchObject({ label: 'kept', isDeleted: true })
    expect(accepted.cursor?.after).toEqual([9])
    return { checkpoint: { ...f.checkpoint, sequence: 4, tableIndex: 4 }, inserts: 1, updates: 0 }
  })
  expect(await apply()).toMatchObject({ inserts: 1, checkpoint: { sequence: 4 } })
  await expect(apply()).rejects.toThrow('consumed')
  expect(f.rpc).toHaveBeenCalledTimes(2)
})

test('changed original view cannot dispatch a prepared page', async () => {
  const f = fixture()
  await f.destination.begin(f.source, 'source')
  await expect(f.destination.prepare({ ...f.checkpoint, snapshotId: 'c'.repeat(64) }, f.page)).rejects.toThrow(
    'source view'
  )
  expect(f.rpc).toHaveBeenCalledTimes(1)
})

test('lost reply never permits reapplying the same preparation and observation is independent', async () => {
  const f = fixture()
  await f.destination.begin(f.source, 'source')
  const apply = await f.destination.prepare(f.checkpoint, f.page),
    lost = new Error('Lost transport reply')
  f.rpc.mockRejectedValueOnce(lost)
  await expect(apply()).rejects.toBe(lost)
  await expect(apply()).rejects.toThrow('consumed')
  const observed = { ...f.checkpoint, sequence: 4, tableIndex: 4 }
  f.rpc.mockResolvedValueOnce(observed)
  expect(await f.destination.checkpoint(identity, 'source')).toEqual(observed)
  expect(f.rpc).toHaveBeenCalledTimes(3)
})

test('I/O timeout requests cancellation but waits for the actual transport promise to drain', async () => {
  jest.useFakeTimers()
  const f = fixture()
  await f.destination.begin(f.source, 'source')
  const apply = await f.destination.prepare(f.checkpoint, f.page)
  let release!: (value: unknown) => void,
    signal: AbortSignal | undefined,
    settled = false
  f.rpc.mockImplementationOnce(async (_method, _params, currentSignal) => {
    signal = currentSignal
    return await new Promise(resolve => {
      release = resolve
    })
  })
  const pending = apply()
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  try {
    await jest.advanceTimersByTimeAsync(30000)
    expect(signal?.aborted).toBe(true)
    expect(settled).toBe(false)
    release({ checkpoint: { ...f.checkpoint, sequence: 4, tableIndex: 4 }, inserts: 1, updates: 0 })
    await expect(pending).rejects.toThrow('deadline')
    expect(settled).toBe(true)
  } finally {
    release(undefined)
    await pending.catch(() => undefined)
  }
})

test('expired original session refuses before a new request and cannot gain time from a checkpoint observation', async () => {
  jest.useFakeTimers()
  const f = fixture()
  f.source.expiresAt = Date.now() + 1000
  await f.destination.begin(f.source, 'source')
  const apply = await f.destination.prepare(f.checkpoint, f.page)
  await jest.advanceTimersByTimeAsync(1001)
  f.rpc.mockResolvedValueOnce(f.checkpoint)
  expect(await f.destination.checkpoint(identity, 'source')).toEqual(f.checkpoint)
  await expect(apply()).rejects.toThrow('source deadline')
  expect(f.rpc).toHaveBeenCalledTimes(2)
})

function largeFixture() {
  const f = fixture()
  // Synthetic complete raw record for transport boundaries, not a valid BRC
  // document or proof-closure oracle. Large TEXT stays one bounded row/frame.
  f.page.rows[0].label = 'large-field'.repeat(70000)
  f.page.payloadBytes = 2000000
  let staged = new Uint8Array(),
    received = 0
  const transferId = 'd'.repeat(64),
    calls: string[] = []
  f.rpc.mockImplementation(async (method, params) => {
    calls.push(method)
    if (method === 'beginSnapshotSync') return f.checkpoint
    if (method === 'beginSnapshotSyncPageTransfer') {
      const data = params[1] as { digest: string; totalBytes: number }
      staged = new Uint8Array(data.totalBytes)
      return {
        ...data,
        transferId,
        partBytes: remoteSnapshotSyncPartBytes,
        expiresAt: f.source.expiresAt,
        receivedBytes: 0
      }
    }
    if (method === 'writeSnapshotSyncPageTransferPart') {
      const part = params[1] as { offset: number; bytes: Uint8Array }
      expect(part.bytes.length).toBeLessThanOrEqual(remoteSnapshotSyncPartBytes)
      expect(part.offset).toBe(received)
      staged.set(part.bytes, part.offset)
      received += part.bytes.length
      return received
    }
    if (method === 'commitSnapshotSyncPageTransfer') {
      expect(received).toBe(staged.length)
      expect(parseRemoteSnapshotSyncStagedPage(staged, f.checkpoint, 7).rows[0]).toHaveProperty(
        'label',
        'large-field'.repeat(70000)
      )
      return { checkpoint: { ...f.checkpoint, sequence: 4, tableIndex: 4 }, inserts: 1, updates: 0 }
    }
    if (method === 'releaseSnapshotSyncPageTransfer') {
      staged.fill(0)
      return true
    }
    throw new Error('Unexpected large-page method')
  })
  return { ...f, calls, transferId }
}

test('large page parts remain bounded and cleanup follows the exact staged commit', async () => {
  const f = largeFixture()
  await f.destination.begin(f.source, 'source')
  expect(await (await f.destination.prepare(f.checkpoint, f.page))()).toMatchObject({ inserts: 1 })
  expect(f.calls).not.toContain('commitSnapshotSyncPage')
  expect(f.calls.filter(method => method === 'writeSnapshotSyncPageTransferPart').length).toBeGreaterThan(1)
  expect(f.calls.at(-2)).toBe('commitSnapshotSyncPageTransfer')
  expect(f.calls.at(-1)).toBe('releaseSnapshotSyncPageTransfer')
})

test('failed staged cleanup retains the concrete owner through shared retry and completed idempotence', async () => {
  const f = largeFixture()
  await f.destination.begin(f.source, 'source')
  const apply = await f.destination.prepare(f.checkpoint, f.page),
    original = f.rpc.getMockImplementation()!,
    failure = new Error('Original release failed')
  let releases = 0
  f.rpc.mockImplementation(async (...args) => {
    if (args[0] === 'releaseSnapshotSyncPageTransfer' && ++releases <= 2) throw failure
    return await original(...args)
  })
  let retained: RemoteSnapshotSyncTransferCleanupError | undefined
  try {
    await apply()
  } catch (cause) {
    retained = cause as RemoteSnapshotSyncTransferCleanupError
  }
  expect(retained).toBeInstanceOf(RemoteSnapshotSyncTransferCleanupError)
  expect(retained!.cleaned).toBe(false)
  const first = retained!.retryCleanup(),
    same = retained!.retryCleanup()
  expect(first).toBe(same)
  await expect(first).rejects.toBe(failure)
  expect(retained!.cleaned).toBe(false)
  await retained!.retryCleanup()
  expect(retained!.cleaned).toBe(true)
  await retained!.retryCleanup()
  expect(releases).toBe(3)
})

test.each([undefined, null])(
  'reader-only destination refuses absent %p DATA without a destination RPC',
  async absent => {
    const f = fixture()
    f.peer.mockResolvedValue({ storageIdentityKey: 'destination', supportsDestination: false })
    for (const operation of [
      () => f.destination.begin(absent as never, undefined),
      () => f.destination.begin(f.source, 'source'),
      () => f.destination.checkpoint(identity, 'source'),
      () => f.destination.prepare(absent as never, absent as never),
      () => f.destination.prepare(f.checkpoint, f.page)
    ])
      await expect(operation()).rejects.toThrow('Remote snapshot destination is not negotiated')
    expect(f.rpc).not.toHaveBeenCalled()
  }
)
test('pending peer negotiation cannot change synchronously detached source DATA', async () => {
  const f = fixture()
  f.source.user.created_at = new Date(when)
  let release!: (peer: { storageIdentityKey: string; supportsDestination: boolean }) => void
  f.peer.mockImplementationOnce(
    async () =>
      await new Promise(resolve => {
        release = resolve
      })
  )
  const opening = f.destination.begin(f.source, 'source')
  f.source.snapshotId = 'c'.repeat(64)
  f.source.sourceStorage.storageIdentityKey = 'changed'
  f.source.user.identityKey = 'changed'
  f.source.user.created_at.setTime(0)
  release({ storageIdentityKey: 'destination', supportsDestination: true })
  expect(await opening).toEqual(f.checkpoint)
  expect(f.rpc.mock.calls[0][1][0]).toMatchObject({
    snapshotId: 'a'.repeat(64),
    sourceStorage: { storageIdentityKey: 'source' },
    user: { identityKey: identity, created_at: new Date('2026-10-06T00:00:00.000Z') }
  })
})
