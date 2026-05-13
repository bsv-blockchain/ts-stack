import { Chain } from '../../../sdk'
import { ChaintracksOptions } from './Api/ChaintracksApi'
import { ChaintracksFetch } from './util/ChaintracksFetch'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { BulkFileDataManager, BulkFileDataManagerOptions } from './util/BulkFileDataManager'
import { ChaintracksStorageIdb, ChaintracksStorageIdbOptions } from './Storage/ChaintracksStorageIdb'
import { buildChaintracksOptionsWithIngestors } from './configureChaintracksIngestors'

export function createDefaultIdbChaintracksOptions (
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

  const so: ChaintracksStorageIdbOptions = {
    chain,
    bulkFileDataManager,
    liveHeightThreshold,
    reorgHeightThreshold,
    bulkMigrationChunkSize,
    batchInsertLimit
  }
  const storage = new ChaintracksStorageIdb(so)

  return buildChaintracksOptionsWithIngestors(
    { chain, whatsonchainApiKey, maxPerFile, fetch, cdnUrl, addLiveRecursionLimit },
    storage
  )
}
