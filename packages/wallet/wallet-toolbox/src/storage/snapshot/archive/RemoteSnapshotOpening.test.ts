import { remoteReaderFixture } from '../../../../test/utils/remoteSnapshotReaderFixtures'
import { openRemoteSnapshot, RemoteSnapshotOpeningCleanupError } from './openRemoteSnapshot'
import { SnapshotArchiveTransportFailure } from './SnapshotArchiveTransportFailure'
import { SnapshotArchiveTransport } from './SnapshotArchiveTransport'

afterEach(() => jest.restoreAllMocks())

test('an old server is declined before any request or timer is retained', async () => {
  jest.useFakeTimers()
  try {
    const rpc = jest.fn()
    const transport = new SnapshotArchiveTransport(rpc, '02' + '11'.repeat(32), 'source', 'test')
    expect(await openRemoteSnapshot(transport)).toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    jest.useRealTimers()
  }
})

test('a refused server offer declines before any capture request exists', async () => {
  const { transport, rpc } = remoteReaderFixture([])
  jest.spyOn(transport, 'readerOffer').mockResolvedValue({ version: 1, outcome: 'resource-limited' })
  expect(await openRemoteSnapshot(transport)).toBeUndefined()
  expect(rpc).not.toHaveBeenCalled()
})

test.each(['before', 'after'])(
  'one same-request retry recovers an admission response lost %s the server accepted it',
  async when => {
    const { transport, rpc } = remoteReaderFixture([])
    const implementation = transport.admit.bind(transport)
    const admitted = jest.spyOn(transport, 'admit')
    admitted.mockImplementationOnce(async (request, signal) => {
      if (when === 'after') await implementation(request, signal)
      throw new SnapshotArchiveTransportFailure(new Error('synthetic lost response'))
    })
    const view = (await openRemoteSnapshot(transport))!
    try {
      expect(admitted).toHaveBeenCalledTimes(2)
      expect(admitted.mock.calls[1][0]).toEqual(admitted.mock.calls[0][0])
      expect(rpc.mock.calls.filter(([method]) => method === 'getSnapshotArchiveReaderOffer')).toHaveLength(1)
      expect(rpc.mock.calls.filter(([method]) => method === 'getSnapshotArchiveStatus')).toHaveLength(0)
      expect(view.isOpen).toBe(true)
    } finally {
      await view.close()
    }
  }
)

test('an admission refusal closes its retained offer before permitting fallback', async () => {
  const { transport, rpc } = remoteReaderFixture([])
  const admitted = jest.spyOn(transport, 'admit').mockImplementation(async request => ({
    version: 1,
    outcome: 'resource-limited',
    requestId: request.requestId,
    expiresAt: request.notAfter
  }))
  expect(await openRemoteSnapshot(transport)).toBeUndefined()
  const request = admitted.mock.calls[0][0]
  expect(rpc.mock.calls.map(([method]) => method)).toEqual([
    'getSnapshotArchiveReaderOffer',
    'cancelSnapshotArchiveRequest'
  ])
  expect(rpc.mock.calls[1][1]).toEqual([{ version: 1, identityKey: expect.any(String), request }])
})

test('unknown admission errors never trigger retries, status recovery or compatibility fallback', async () => {
  const { transport, rpc } = remoteReaderFixture([])
  const failure = new Error('synthetic signature or framing validation failure')
  const admitted = jest.spyOn(transport, 'admit').mockRejectedValue(failure)
  await expect(openRemoteSnapshot(transport)).rejects.toBe(failure)
  expect(admitted).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls.map(([method]) => method)).toEqual([
    'getSnapshotArchiveReaderOffer',
    'cancelSnapshotArchiveRequest'
  ])
})

test('a second native-fetch failure is bounded and still cancels the identical request', async () => {
  const { transport, rpc } = remoteReaderFixture([])
  const failure = new SnapshotArchiveTransportFailure(new Error('synthetic repeated connection loss'))
  const admitted = jest.spyOn(transport, 'admit').mockRejectedValue(failure)
  await expect(openRemoteSnapshot(transport)).rejects.toBe(failure)
  expect(admitted).toHaveBeenCalledTimes(2)
  expect(admitted.mock.calls[0][0]).toEqual(admitted.mock.calls[1][0])
  expect(rpc.mock.calls.map(([method]) => method)).toEqual([
    'getSnapshotArchiveReaderOffer',
    'cancelSnapshotArchiveRequest'
  ])
})

test('opening and cancellation failures both remain observable without requiring AggregateError', async () => {
  const { transport } = remoteReaderFixture([])
  const original = new Error('synthetic malformed archive')
  const cleanup = new Error('synthetic failed cancellation acknowledgement')
  jest.spyOn(transport, 'directory').mockRejectedValue(original)
  jest.spyOn(transport, 'cancelRequest').mockRejectedValue(cleanup)
  const error = await openRemoteSnapshot(transport).catch(error => error)
  expect(error).toBeInstanceOf(RemoteSnapshotOpeningCleanupError)
  expect(error.cause).toBe(original)
  expect(error.cleanupError).toBe(cleanup)
})

test('status recovery uses the admitted tuple without requesting another offer or capture', async () => {
  const { transport, rpc } = remoteReaderFixture([])
  const admit = transport.admit.bind(transport)
  jest.spyOn(transport, 'admit').mockImplementation(async (...args) => {
    const admission = await admit(...args)
    if (admission.outcome !== 'accepted') throw new Error('Expected fixture admission')
    return {
      ...admission,
      receipt: { ...admission.receipt, state: 'building', archiveId: undefined, digest: undefined }
    }
  })
  const status = jest.spyOn(transport, 'readerStatus')
  status.mockRejectedValueOnce(new SnapshotArchiveTransportFailure('synthetic status connection loss'))
  const view = (await openRemoteSnapshot(transport))!
  try {
    expect(status).toHaveBeenCalledTimes(2)
    expect(status.mock.calls[0]).toEqual(status.mock.calls[1])
    expect(rpc.mock.calls.filter(([method]) => method === 'getSnapshotArchiveReaderOffer')).toHaveLength(1)
    expect(rpc.mock.calls.filter(([method]) => method === 'admitSnapshotArchive')).toHaveLength(1)
  } finally {
    await view.close()
  }
})

test.each(['resource-limited', 'failed', 'closed', 'expired'] as const)(
  'a durable %s capture receipt is preserved until exact cancellation completes',
  async state => {
    const { transport, rpc } = remoteReaderFixture([])
    const implementation = transport.admit.bind(transport)
    jest.spyOn(transport, 'admit').mockImplementation(async (...args) => {
      const admitted = await implementation(...args)
      if (admitted.outcome !== 'accepted') throw new Error('Expected fixture admission')
      return {
        ...admitted,
        receipt: {
          version: 1,
          requestId: admitted.receipt.requestId,
          expiresAt: admitted.receipt.expiresAt,
          state
        }
      }
    })
    const pending = openRemoteSnapshot(transport)
    if (state === 'resource-limited') await expect(pending).resolves.toBeUndefined()
    else await expect(pending).rejects.toThrow(`Snapshot archive capture is ${state}`)
    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'getSnapshotArchiveReaderOffer',
      'admitSnapshotArchive',
      'cancelSnapshotArchiveRequest'
    ])
  }
)

test('directory verification cannot expose a view at the conservatively rounded server expiry', async () => {
  jest.useFakeTimers()
  const monotonic = jest.spyOn(performance, 'now').mockReturnValue(0)
  const { transport, rpc } = remoteReaderFixture([])
  const directory = transport.directory.bind(transport)
  jest.spyOn(transport, 'directory').mockImplementation(async (...args) => {
    const result = await directory(...args)
    monotonic.mockReturnValue(999.1)
    return result
  })
  try {
    await expect(openRemoteSnapshot(transport, { lifetimeMs: 1000 })).rejects.toThrow('Remote snapshot expired')
    expect(rpc.mock.calls.filter(([method]) => method === 'cancelSnapshotArchiveRequest')).toHaveLength(1)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    jest.useRealTimers()
  }
})

test('building status uses bounded exponential polling without renewing or readmitting its request', async () => {
  jest.useFakeTimers({ now: 1790812800000 })
  const controller = new AbortController()
  const { transport, rpc } = remoteReaderFixture([])
  const originalAdmit = transport.admit.bind(transport)
  const originalStatus = transport.readerStatus.bind(transport)
  const times: number[] = []
  jest.spyOn(transport, 'admit').mockImplementation(async (...args) => {
    const admitted = await originalAdmit(...args)
    if (admitted.outcome !== 'accepted') throw new Error('Expected accepted fixture')
    return { ...admitted, receipt: { ...admitted.receipt, state: 'building' } }
  })
  const status = jest.spyOn(transport, 'readerStatus').mockImplementation(async (...args) => {
    times.push(Date.now() - 1790812800000)
    const receipt = await originalStatus(...args)
    return times.length < 6 ? { ...receipt, state: 'building' } : receipt
  })
  const pending = openRemoteSnapshot(transport, { signal: controller.signal })
  void pending.catch(() => undefined)
  try {
    await jest.advanceTimersByTimeAsync(3500)
    expect(times).toEqual([100, 300, 700, 1500, 2500, 3500])
    const view = await pending
    expect(view!.isOpen).toBe(true)
    expect(view!.expiresAt).toBe(1790813100000)
    expect(status.mock.calls.every(call => call[0] === status.mock.calls[0][0])).toBe(true)
    expect(rpc.mock.calls.filter(([method]) => method === 'getSnapshotArchiveReaderOffer')).toHaveLength(1)
    expect(rpc.mock.calls.filter(([method]) => method === 'admitSnapshotArchive')).toHaveLength(1)
  } finally {
    controller.abort()
    const view = await pending.catch(() => undefined)
    await view?.close()
    jest.useRealTimers()
  }
})
