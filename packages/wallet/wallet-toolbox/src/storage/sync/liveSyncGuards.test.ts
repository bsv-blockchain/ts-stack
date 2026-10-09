import { WERR_INTERNAL, WERR_NETWORK_CHAIN } from '../../sdk/WERR_errors'
import { assertLiveSyncChainsMatch, throwIfProcessSyncChunkError } from './liveSyncGuards'
import type { TableSettings } from '../schema/tables'

function settings(chain: TableSettings['chain'], storageName: string): TableSettings {
  return {
    created_at: new Date(0),
    updated_at: new Date(0),
    storageIdentityKey: `${storageName}-key`,
    storageName,
    chain,
    dbtype: 'SQLite',
    maxOutputScript: 0
  }
}

describe('live sync guards', () => {
  test('throws WERR_NETWORK_CHAIN when reader and writer chains differ', () => {
    expect(() => assertLiveSyncChainsMatch(settings('test', 'reader'), settings('main', 'writer'))).toThrow(
      WERR_NETWORK_CHAIN
    )
    try {
      assertLiveSyncChainsMatch(settings('test', 'reader'), settings('main', 'writer'))
    } catch (e) {
      expect(e).toBeInstanceOf(WERR_NETWORK_CHAIN)
      expect((e as Error).message).toContain("Reader 'reader' is 'test'")
      expect((e as Error).message).toContain("writer 'writer' is 'main'")
    }
  })

  test('accepts matching chains', () => {
    expect(() => assertLiveSyncChainsMatch(settings('test', 'reader'), settings('test', 'writer'))).not.toThrow()
  })

  test('throws a custom ProcessSyncChunkResult.error and ignores a missing field', () => {
    const error = new WERR_INTERNAL('custom writer failed')
    expect(() =>
      throwIfProcessSyncChunkError({
        done: false,
        maxUpdated_at: undefined,
        updates: 0,
        inserts: 0,
        error
      })
    ).toThrow(error)
    expect(() =>
      throwIfProcessSyncChunkError({
        done: true,
        maxUpdated_at: undefined,
        updates: 0,
        inserts: 0
      })
    ).not.toThrow()
  })
})
