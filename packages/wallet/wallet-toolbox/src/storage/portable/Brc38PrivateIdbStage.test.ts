import 'fake-indexeddb/auto'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'

test('cancellation before genuine browser ownership retains the cause and creates no namespace', async () => {
  const controller = new AbortController(),
    cause = new Error('private browser import canceled')
  controller.abort(cause)
  const limits = {
      maximumRows: 100,
      maximumLogicalBytes: 1048576,
      maximumPhysicalBytes: 4194304,
      maximumRowBytes: 65536,
      maximumRowAllocationBytes: 1048576,
      expiresAt: Date.now() + 120000
    },
    binding = {
      archiveSha256: 'a'.repeat(64),
      identityKey: 'profile',
      chain: 'test' as const,
      sourceStorageIdentityKey: 'source',
      targetStorageIdentityKey: 'target',
      targetGeneration: 0
    }
  await expect(Brc38PrivateIdbStage.create(limits, binding, 1000, controller.signal)).rejects.toBe(cause)
})
test('copying a private stage prototype cannot enroll an IndexedDB or source actor', async () => {
  const copied = Object.create(Brc38PrivateIdbStage.prototype) as Brc38PrivateIdbStage
  await expect(copied.count('outputs')).rejects.toThrow()
})
