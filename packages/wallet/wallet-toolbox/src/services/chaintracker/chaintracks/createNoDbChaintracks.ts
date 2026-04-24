import { Chain } from '../../../sdk'
import { Chaintracks } from './Chaintracks'
import { ChaintracksFetch } from './util/ChaintracksFetch'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { ChaintracksStorageNoDb } from './Storage/ChaintracksStorageNoDb'
import { createDefaultNoDbChaintracksOptions } from './createDefaultNoDbChaintracksOptions'

export async function createNoDbChaintracks(
  chain: Chain,
  whatsonchainApiKey: string = '',
  maxPerFile: number = 100000,
  maxRetained: number = 2,
  fetch?: ChaintracksFetchApi,
  cdnUrl: string = 'https://cdn.projectbabbage.com/blockheaders/',
  liveHeightThreshold: number = 2000,
  reorgHeightThreshold: number = 400,
  bulkMigrationChunkSize: number = 500,
  batchInsertLimit: number = 400,
  addLiveRecursionLimit: number = 36
): Promise<{
  chain: Chain
  maxPerFile: number
  fetch: ChaintracksFetchApi
  storage: ChaintracksStorageNoDb
  chaintracks: Chaintracks
  available: Promise<void>
}> {
  try {
    fetch ||= new ChaintracksFetch()

    const co = createDefaultNoDbChaintracksOptions(
      chain,
      whatsonchainApiKey,
      maxPerFile,
      maxRetained,
      fetch,
      cdnUrl,
      liveHeightThreshold,
      reorgHeightThreshold,
      bulkMigrationChunkSize,
      batchInsertLimit,
      addLiveRecursionLimit
    )

    const chaintracks = new Chaintracks(co)
    const available = chaintracks.makeAvailable()

    return {
      chain,
      fetch,
      maxPerFile,
      storage: co.storage as ChaintracksStorageNoDb,
      chaintracks,
      available
    }
  } catch (error) {
    console.error('Error setting up Chaintracks with NoDb Storage:', error)
    throw error
  }
}
