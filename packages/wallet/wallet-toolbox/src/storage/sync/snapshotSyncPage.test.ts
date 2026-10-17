import type { RequestSyncChunkArgs, SyncChunk } from '../../sdk/WalletStorage.interfaces'
import { snapshotSyncPage } from './snapshotSyncPage'

test.each(['array', 'typed view', 'Buffer view'] as const)(
  'owns %s bytes and checkpoint values across an asynchronous handoff',
  async representation => {
    const backing = representation === 'Buffer view' ? Buffer.from([9, 1, 2, 3, 8]) : new Uint8Array([9, 1, 2, 3, 8])
    const bytes = representation === 'array' ? [1, 2, 3] : backing.subarray(1, 4)
    const since = new Date(10)
    const updatedAt = new Date(20)
    const args = {
      identityKey: 'wallet',
      fromStorageIdentityKey: 'source',
      toStorageIdentityKey: 'destination',
      maxItems: 1,
      maxRoughSize: 1024,
      since,
      offsets: [{ name: 'transaction', offset: 1 }]
    } as RequestSyncChunkArgs
    // The snapshot owns incoming byte storage before downstream schema/proof
    // validation. Runtime byte views must never keep a producer's backing store.
    const chunk = {
      fromStorageIdentityKey: 'source',
      toStorageIdentityKey: 'destination',
      userIdentityKey: 'wallet',
      transactions: [{ rawTx: bytes, updated_at: updatedAt }]
    } as unknown as SyncChunk
    const snapshot = snapshotSyncPage(args, chunk)
    await Promise.resolve()
    bytes[0] = 7
    since.setTime(30)
    updatedAt.setTime(40)
    args.offsets[0].offset = 99

    const copied = snapshot.chunk.transactions![0]
    expect(Array.from(copied.rawTx!)).toEqual([1, 2, 3])
    expect(copied.updated_at.getTime()).toBe(20)
    expect(snapshot.args.since?.getTime()).toBe(10)
    expect(snapshot.args.offsets[0].offset).toBe(1)
    copied.rawTx![1] = 6
    expect(bytes[1]).toBe(2)
    expect(backing[0]).toBe(9)
    expect(backing[4]).toBe(8)
  }
)
