import { Knex, knex as makeKnex } from 'knex'
import { Chain } from '../../../sdk'
import { ChaintracksOptions } from './Api/ChaintracksApi'
import { ChaintracksFs } from './util/ChaintracksFs'
import { ChaintracksStorageKnex, ChaintracksStorageKnexOptions } from './Storage/ChaintracksStorageKnex'
import { ChaintracksFetch } from './util/ChaintracksFetch'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { BulkFileDataManager, BulkFileDataManagerOptions } from './util/BulkFileDataManager'
import { buildChaintracksOptionsWithIngestors } from './configureChaintracksIngestors'

/**
 *
 * @param chain
 * @param rootFolder defaults to "./data/"
 * @returns
 */
export function createDefaultKnexChaintracksOptions (
  ...[
    chain,
    rootFolder = './data/',
    knexConfig,
    whatsonchainApiKey = '',
    maxPerFile = 100000,
    maxRetained = 2,
    fetch,
    cdnUrl = 'https://cdn.projectbabbage.com/blockheaders/',
    liveHeightThreshold = 2000,
    reorgHeightThreshold = 400,
    bulkMigrationChunkSize = 500,
    batchInsertLimit = 400,
    addLiveRecursionLimit = 36
  ]: [
    chain: Chain,
    rootFolder?: string,
    knexConfig?: Knex.Config,
    whatsonchainApiKey?: string,
    maxPerFile?: number,
    maxRetained?: number,
    fetch?: ChaintracksFetchApi,
    cdnUrl?: string,
    liveHeightThreshold?: number,
    reorgHeightThreshold?: number,
    bulkMigrationChunkSize?: number,
    batchInsertLimit?: number,
    addLiveRecursionLimit?: number
  ]
): ChaintracksOptions {
  fetch ??= new ChaintracksFetch()

  const bfo: BulkFileDataManagerOptions = {
    chain,
    fetch,
    maxPerFile,
    maxRetained,
    fromKnownSourceUrl: cdnUrl
  }
  const bulkFileDataManager = new BulkFileDataManager(bfo)

  knexConfig ??= {
    client: 'better-sqlite3',
    connection: { filename: ChaintracksFs.pathJoin(rootFolder, `${chain}Net_chaintracks.sqlite`) },
    useNullAsDefault: true
  }
  const knexInstance = makeKnex(knexConfig)

  const so: ChaintracksStorageKnexOptions = {
    chain,
    knex: knexInstance,
    bulkFileDataManager,
    liveHeightThreshold,
    reorgHeightThreshold,
    bulkMigrationChunkSize,
    batchInsertLimit
  }
  const storage = new ChaintracksStorageKnex(so)

  return buildChaintracksOptionsWithIngestors(
    { chain, whatsonchainApiKey, maxPerFile, fetch, cdnUrl, addLiveRecursionLimit },
    storage
  )
}
