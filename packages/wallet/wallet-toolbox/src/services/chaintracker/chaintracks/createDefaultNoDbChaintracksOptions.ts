import { Chain } from '../../../sdk'
import { ChaintracksOptions } from './Api/ChaintracksApi'
import { ChaintracksFetch } from './util/ChaintracksFetch'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { BulkFileDataManager, BulkFileDataManagerOptions } from './util/BulkFileDataManager'
import { ChaintracksStorageNoDb, ChaintracksStorageNoDbOptions } from './Storage/ChaintracksStorageNoDb'
import { buildChaintracksOptionsWithIngestors } from './configureChaintracksIngestors'

export function createDefaultNoDbChaintracksOptions (
  chain: Chain,
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
): ChaintracksOptions {
  fetch ||= new ChaintracksFetch()

  const bfo: BulkFileDataManagerOptions = {
    chain,
    fetch,
    maxPerFile,
    maxRetained,
    fromKnownSourceUrl: cdnUrl
  }
  const bulkFileDataManager = new BulkFileDataManager(bfo)

  const so: ChaintracksStorageNoDbOptions = {
    chain,
    bulkFileDataManager,
    liveHeightThreshold,
    reorgHeightThreshold,
    bulkMigrationChunkSize,
    batchInsertLimit
  }
  const storage = new ChaintracksStorageNoDb(so)

  return buildChaintracksOptionsWithIngestors(
    { chain, whatsonchainApiKey, maxPerFile, fetch, cdnUrl, addLiveRecursionLimit },
    storage
  )
}
