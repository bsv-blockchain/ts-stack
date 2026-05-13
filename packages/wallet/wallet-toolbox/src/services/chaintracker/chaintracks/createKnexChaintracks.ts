import { Knex } from 'knex'

import { Chain } from '../../../sdk'
import { Chaintracks } from './Chaintracks'
import { ChaintracksFetch } from './util/ChaintracksFetch'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { ChaintracksStorageKnex } from './Storage/ChaintracksStorageKnex'
import { createDefaultKnexChaintracksOptions } from './createDefaultKnexChaintracksOptions'

export async function createKnexChaintracks (
  chain: Chain,
  rootFolder = './data/',
  knexConfig?: Knex.Config,
  whatsonchainApiKey = '',
  maxPerFile = 100000,
  maxRetained = 2,
  fetch?: ChaintracksFetchApi,
  cdnUrl = 'https://cdn.projectbabbage.com/blockheaders/',
  liveHeightThreshold = 2000,
  reorgHeightThreshold = 400,
  bulkMigrationChunkSize = 500,
  batchInsertLimit = 400,
  addLiveRecursionLimit = 36
): Promise<{
    chain: Chain
    maxPerFile: number
    fetch: ChaintracksFetchApi
    storage: ChaintracksStorageKnex
    chaintracks: Chaintracks
    available: Promise<void>
  }> {
  try {
    fetch ||= new ChaintracksFetch()

    const co = createDefaultKnexChaintracksOptions(
      chain,
      rootFolder,
      knexConfig,
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
      storage: co.storage as ChaintracksStorageKnex,
      chaintracks,
      available
    }
  } catch (error) {
    console.error('Error setting up Chaintracks with Knex Storage:', error)
    throw error
  }
}
