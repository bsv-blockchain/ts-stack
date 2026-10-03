import { SnapshotArchiveTransport } from './SnapshotArchiveTransport'
import { snapshotArchiveRequestId } from './SnapshotArchiveRequest'
import { snapshotArchiveReaderRequestId } from './SnapshotArchiveReaderRequest'
import { fixture, expected, now } from '../../../../test/utils/snapshotArchiveDirectoryFixtures'

const fields = { version: 1 as const, nonce: 'a'.repeat(64), notAfter: now + 1000, maxBytes: 32768 }
const request = { ...fields, requestId: snapshotArchiveRequestId(fields) }
const source = () => {
  const { directory, payloads, binding } = fixture()
  const offer = {
    version: 1 as const,
    serverTime: now,
    sourceStorageIdentityKey: expected.sourceStorageIdentityKey,
    sourceSchema: binding.sourceSchema,
    chain: 'test' as const
  }
  const ready = {
    version: 1 as const,
    requestId: request.requestId,
    expiresAt: request.notAfter,
    state: 'ready' as const,
    archiveId: directory.archiveId,
    digest: directory.digest
  }
  const rpc = jest.fn(async (method: string, params: unknown[], _signal?: AbortSignal): Promise<unknown> => {
    const input = params[0] as Record<string, unknown>
    if (method === 'getSnapshotArchiveOffer') return offer
    if (method === 'startSnapshotArchive' || method === 'getSnapshotArchiveStatus') return ready
    if (method === 'getSnapshotArchiveDirectory') return directory
    if (method === 'readSnapshotArchivePage') {
      const i = input.sequence as number
      return { ...directory.receipts[i], bytes: payloads[i] }
    }
    return true
  })
  const transport = new SnapshotArchiveTransport(rpc, expected.identityKey, expected.sourceStorageIdentityKey, 'test')
  return { transport, rpc, ready, offer, directory, payloads }
}

test.each(['readerOffer', 'admit', 'readerStatus', 'cancelRequest'] as const)(
  'an archive-only transport refuses %s before network I/O with the negotiated-capability error',
  async method => {
    const { transport, rpc } = source()
    const readerFields = { ...fields, version: 2 as const }
    const readerRequest = { ...readerFields, requestId: snapshotArchiveReaderRequestId(readerFields) }
    const operation =
      method === 'readerOffer'
        ? transport.readerOffer({ lifetimeMs: 1000, maxBytes: 32768 })
        : transport[method](readerRequest)
    await expect(operation).rejects.toThrow(new TypeError('Snapshot archive reader was not negotiated'))
    expect(rpc).not.toHaveBeenCalled()
  }
)

test('auth transport binds exact immutable request/root/profile and forwards cancellation for each operation', async () => {
  const { transport, rpc, ready, offer, payloads } = source()
  const signal = new AbortController().signal
  expect(await transport.offer(signal)).toEqual(offer)
  expect(await transport.start(request, signal)).toEqual(ready)
  expect(await transport.status(request, signal)).toEqual(ready)
  const verified = await transport.directory(ready, offer, now, signal)
  expect(await transport.page(verified, 12, signal)).toEqual(payloads[12])
  await transport.cancel(request.requestId, signal)
  expect(rpc.mock.calls).toHaveLength(6)
  for (const [, params, callSignal] of rpc.mock.calls) {
    expect(params[0]).toMatchObject({ version: 1, identityKey: expected.identityKey })
    expect(callSignal).toBe(signal)
  }
  expect((rpc.mock.calls[1][1][0] as { request: unknown }).request).not.toBe(request)
})

test('declines malformed local arguments before network calls', async () => {
  const { transport, rpc, ready, offer } = source()
  expect(() => new SnapshotArchiveTransport(rpc, '', 'source', 'test')).toThrow()
  await expect(transport.start({ ...request, maxBytes: 0 })).rejects.toThrow()
  await expect(transport.status({ ...request, nonce: '' })).rejects.toThrow()
  await expect(transport.cancel('')).rejects.toThrow()
  for (const receipt of [
    { ...ready, state: 'building' as const },
    { ...ready, archiveId: undefined },
    { ...ready, digest: undefined }
  ]) {
    await expect(transport.directory(receipt, offer, now)).rejects.toThrow('not ready')
  }
  expect(rpc).not.toHaveBeenCalled()
  const verified = await transport.directory(ready, offer, now)
  rpc.mockClear()
  for (const sequence of [-1, 0.1, 13, NaN])
    await expect(transport.page(verified, sequence)).rejects.toThrow('sequence')
  expect(rpc).not.toHaveBeenCalled()
})

test('refuses changed expiry, root, profile, sequence and payload even when the server sends a success envelope', async () => {
  const { transport, rpc, ready, offer, directory, payloads } = source()
  await expect(transport.directory({ ...ready, expiresAt: ready.expiresAt + 1 }, offer, now)).rejects.toThrow(
    'expiry changed'
  )
  await expect(transport.directory({ ...ready, digest: '0'.repeat(64) }, offer, now)).rejects.toThrow(
    'Invalid snapshot archive directory'
  )
  const verified = await transport.directory(ready, offer, now)
  rpc.mockResolvedValueOnce({ ...directory.receipts[1], bytes: payloads[1] })
  await expect(transport.page(verified, 0)).rejects.toThrow()
  rpc.mockResolvedValueOnce({ ...directory.receipts[0], bytes: new Uint8Array([0]) })
  await expect(transport.page(verified, 0)).rejects.toThrow()
  rpc.mockResolvedValueOnce(false)
  await expect(transport.cancel(request.requestId)).rejects.toThrow('cancellation receipt')
  rpc.mockResolvedValueOnce({ ...offer, sourceStorageIdentityKey: 'changed' })
  await expect(transport.offer()).rejects.toThrow()
  rpc.mockResolvedValueOnce({ ...ready, requestId: '0'.repeat(64) })
  await expect(transport.start(request)).rejects.toThrow()
  rpc.mockRejectedValueOnce(new Error('network failure'))
  await expect(transport.status(request)).rejects.toThrow('network failure')
})
