import { Chaintracks } from '../Chaintracks'
import { HeightRange } from '../util/HeightRange'
import { wait } from '../../../../utility/utilityHelpers'

describe('Chaintracks bulk ingestor failure handling', () => {
  const liveIngestor = {
    setStorage: async () => {},
    startListening: async () => {},
    getHeaderByHash: async () => undefined,
    shutdown: async () => {}
  }

  test('falls through failed present-height sources and records their health', async () => {
    const failed = {
      getPresentHeight: jest.fn(async () => {
        throw new Error('CDN unavailable')
      })
    }
    const healthy = {
      getPresentHeight: jest.fn(async () => 321)
    }
    const storage = {
      log: () => {},
      getAvailableHeightRanges: async () => ({ bulk: HeightRange.empty, live: HeightRange.empty })
    }
    const chaintracks = new Chaintracks({
      chain: 'main',
      storage: storage as any,
      bulkIngestors: [failed as any, healthy as any],
      liveIngestors: [liveIngestor as any],
      addLiveRecursionLimit: 36,
      readonly: false,
      logging: () => {}
    })

    await expect(chaintracks.getPresentHeight()).resolves.toBe(321)
    expect(failed.getPresentHeight).toHaveBeenCalledTimes(1)
    expect(healthy.getPresentHeight).toHaveBeenCalledTimes(1)
    expect(Array.from((chaintracks as any).sourceStatus.values())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'bulk', state: 'degraded', error: 'CDN unavailable' }),
        expect.objectContaining({ role: 'bulk', state: 'healthy' })
      ])
    )
  })

  test('uses the locally validated height when every external provider is unavailable', async () => {
    const failed = {
      getPresentHeight: jest.fn(async () => {
        throw new Error('upstream unavailable')
      })
    }
    const storage = {
      log: () => {},
      getAvailableHeightRanges: async () => ({ bulk: new HeightRange(0, 400), live: new HeightRange(401, 420) })
    }
    const chaintracks = new Chaintracks({
      chain: 'main',
      storage: storage as any,
      bulkIngestors: [failed as any],
      liveIngestors: [liveIngestor as any],
      addLiveRecursionLimit: 36,
      readonly: false,
      logging: () => {}
    })

    await expect(chaintracks.getPresentHeight()).resolves.toBe(420)
  })

  test('continues missing-header lookup with the next live source after a failure', async () => {
    const header = {
      version: 1,
      previousHash: '0'.repeat(64),
      merkleRoot: '1'.repeat(64),
      time: 1,
      bits: 1,
      nonce: 1,
      height: 1,
      hash: '2'.repeat(64)
    }
    const failed = {
      getHeaderByHash: jest.fn(async () => {
        throw new Error('primary live source unavailable')
      })
    }
    const healthy = {
      getHeaderByHash: jest.fn(async () => header)
    }
    const chaintracks = new Chaintracks({
      chain: 'main',
      storage: { log: () => {} } as any,
      bulkIngestors: [{ getPresentHeight: async () => 1 } as any],
      liveIngestors: [failed as any, healthy as any],
      addLiveRecursionLimit: 36,
      readonly: false,
      logging: () => {}
    })

    await expect((chaintracks as any).getMissingBlockHeader(header.hash)).resolves.toBe(header)
    expect(failed.getHeaderByHash).toHaveBeenCalledWith(header.hash)
    expect(healthy.getHeaderByHash).toHaveBeenCalledWith(header.hash)
    expect(Array.from((chaintracks as any).sourceStatus.values())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'live', state: 'degraded', error: 'primary live source unavailable' }),
        expect.objectContaining({ role: 'live', state: 'healthy' })
      ])
    )
  })

  test('continues initial bulk synchronization with the next source after a failure', async () => {
    const initialRanges = { bulk: new HeightRange(0, 100), live: HeightRange.empty }
    const first = {
      synchronize: jest.fn(async () => {
        throw new Error('primary unavailable')
      })
    }
    const second = {
      synchronize: jest.fn(async () => ({
        liveHeaders: [],
        liveRange: HeightRange.empty,
        done: true,
        log: ''
      }))
    }
    const storage = {
      log: () => {},
      getAvailableHeightRanges: async () => initialRanges
    }
    const chaintracks = new Chaintracks({
      chain: 'main',
      storage: storage as any,
      bulkIngestors: [first as any, second as any],
      liveIngestors: [liveIngestor as any],
      addLiveRecursionLimit: 36,
      readonly: false,
      logging: () => {}
    })

    await expect((chaintracks as any).syncBulkStorageNoLock(101, initialRanges)).resolves.toBeUndefined()
    expect(first.synchronize).toHaveBeenCalledTimes(1)
    expect(second.synchronize).toHaveBeenCalledTimes(1)
    expect((chaintracks as any).startupError).toBeNull()
  })

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
    expect((chaintracks as any).liveHeaders).toHaveLength(2)
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
