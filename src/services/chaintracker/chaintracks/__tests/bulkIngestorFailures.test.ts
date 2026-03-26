import { Chaintracks } from '../Chaintracks'
import { HeightRange } from '../util/HeightRange'
import { wait } from '../../../../utility/utilityHelpers'

describe('Chaintracks bulk ingestor failure handling', () => {
  test('does not loop indefinitely when a bulk ingestor keeps returning incomplete live headers', async () => {
    const initialRanges = {
      bulk: new HeightRange(0, 100),
      live: new HeightRange(101, 110)
    }

    const repeatedLiveHeader = {
      version: 1,
      previousHash: '0'.repeat(64),
      merkleRoot: '1'.repeat(64),
      time: 1,
      bits: 1,
      nonce: 1,
      height: 111,
      hash: '2'.repeat(64)
    }

    let synchronizeCalls = 0
    const bulkIngestor = {
      setStorage: async () => {},
      shutdown: async () => {},
      getPresentHeight: async () => 112,
      fetchHeaders: async () => [],
      storage: () => {
        throw new Error('unused')
      },
      synchronize: async (_presentHeight: number, _before: any, priorLiveHeaders: any[]) => {
        synchronizeCalls += 1
        return {
          liveHeaders: [...priorLiveHeaders, repeatedLiveHeader],
          liveRange: HeightRange.from([...priorLiveHeaders, repeatedLiveHeader]),
          done: false,
          log: ''
        }
      }
    }

    const storage = {
      log: () => {},
      getAvailableHeightRanges: async () => initialRanges
    }

    const liveIngestor = {
      setStorage: async () => {},
      startListening: async () => {},
      getHeaderByHash: async () => undefined,
      shutdown: async () => {}
    }

    const chaintracks = new Chaintracks({
      chain: 'main',
      storage: storage as any,
      bulkIngestors: [bulkIngestor as any],
      liveIngestors: [liveIngestor as any],
      addLiveRecursionLimit: 36,
      readonly: false,
      logging: () => {}
    })

    const syncPromise = (chaintracks as any).syncBulkStorageNoLock(112, initialRanges)
    const timeoutPromise = wait(250).then(() => {
      throw new Error('syncBulkStorageNoLock did not return in time')
    })

    await expect(Promise.race([syncPromise, timeoutPromise])).resolves.toBeUndefined()
    expect(synchronizeCalls).toBe(2)
    expect((chaintracks as any).liveHeaders.length).toBe(2)
  })

  test('treats post-startup bulk sync errors as transient and returns without setting startupError', async () => {
    const initialRanges = {
      bulk: new HeightRange(0, 200),
      live: new HeightRange(201, 220)
    }

    const bulkIngestor = {
      setStorage: async () => {},
      shutdown: async () => {},
      getPresentHeight: async () => 221,
      fetchHeaders: async () => [],
      storage: () => {
        throw new Error('unused')
      },
      synchronize: async () => {
        throw new Error('temporary upstream failure')
      }
    }

    const storage = {
      log: () => {},
      getAvailableHeightRanges: async () => initialRanges
    }

    const liveIngestor = {
      setStorage: async () => {},
      startListening: async () => {},
      getHeaderByHash: async () => undefined,
      shutdown: async () => {}
    }

    const chaintracks = new Chaintracks({
      chain: 'main',
      storage: storage as any,
      bulkIngestors: [bulkIngestor as any],
      liveIngestors: [liveIngestor as any],
      addLiveRecursionLimit: 36,
      readonly: false,
      logging: () => {}
    })

    ;(chaintracks as any).available = true

    await expect((chaintracks as any).syncBulkStorageNoLock(221, initialRanges)).resolves.toBeUndefined()
    expect((chaintracks as any).startupError).toBeNull()
  })
})
