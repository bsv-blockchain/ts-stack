import { Chain } from '../../../sdk'
import { ChaintracksOptions } from './Api/ChaintracksApi'
import { Chaintracks } from './Chaintracks'
import { BulkIngestorCDNBabbage } from './Ingest/BulkIngestorCDNBabbage'
import { LiveIngestorWhatsOnChainOptions, LiveIngestorWhatsOnChainPoll } from './Ingest/LiveIngestorWhatsOnChainPoll'
import { BulkIngestorWhatsOnChainCdn, BulkIngestorWhatsOnChainOptions } from './Ingest/BulkIngestorWhatsOnChainCdn'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { BulkIngestorCDNOptions } from './Ingest/BulkIngestorCDN'
import { WhatsOnChainServicesOptions } from './Ingest/WhatsOnChainServices'
import { BulkFileDataManager, BulkFileDataManagerOptions } from './util/BulkFileDataManager'
import { ChaintracksFetch } from './util/ChaintracksFetch'

export type ChaintracksArgumentsTail = [
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

export type DefaultChaintracksArguments = [chain: Chain, ...options: ChaintracksArgumentsTail]

/**
 * Shared parameters for configuring Chaintracks ingestors.
 */
export interface ChaintracksIngestorParams {
  chain: Chain
  whatsonchainApiKey: string
  maxPerFile: number
  fetch: ChaintracksFetchApi
  cdnUrl: string
  addLiveRecursionLimit: number
}

export interface ResolvedDefaultChaintracksParams extends ChaintracksIngestorParams {
  maxRetained: number
  liveHeightThreshold: number
  reorgHeightThreshold: number
  bulkMigrationChunkSize: number
  batchInsertLimit: number
}

export interface CreatedChaintracks<TStorage extends ChaintracksOptions['storage']> {
  chain: Chain
  maxPerFile: number
  fetch: ChaintracksFetchApi
  storage: TStorage
  chaintracks: Chaintracks
  available: Promise<void>
}

export function resolveDefaultChaintracksArguments (
  args: DefaultChaintracksArguments
): ResolvedDefaultChaintracksParams {
  const [
    chain,
    whatsonchainApiKey = '',
    maxPerFile = 100000,
    maxRetained = 2,
    fetch = new ChaintracksFetch(),
    cdnUrl = 'https://cdn.projectbabbage.com/blockheaders/',
    liveHeightThreshold = 2000,
    reorgHeightThreshold = 400,
    bulkMigrationChunkSize = 500,
    batchInsertLimit = 400,
    addLiveRecursionLimit = 36
  ] = args

  return {
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
  }
}

export function toDefaultChaintracksArguments (
  params: ResolvedDefaultChaintracksParams
): DefaultChaintracksArguments {
  return [
    params.chain,
    params.whatsonchainApiKey,
    params.maxPerFile,
    params.maxRetained,
    params.fetch,
    params.cdnUrl,
    params.liveHeightThreshold,
    params.reorgHeightThreshold,
    params.bulkMigrationChunkSize,
    params.batchInsertLimit,
    params.addLiveRecursionLimit
  ]
}

export function createDefaultBulkFileDataManager (
  params: ResolvedDefaultChaintracksParams
): BulkFileDataManager {
  const options: BulkFileDataManagerOptions = {
    chain: params.chain,
    fetch: params.fetch,
    maxPerFile: params.maxPerFile,
    maxRetained: params.maxRetained,
    fromKnownSourceUrl: params.cdnUrl
  }
  return new BulkFileDataManager(options)
}

export function createDefaultChaintracksStorageOptions (
  params: ResolvedDefaultChaintracksParams
) {
  return {
    chain: params.chain,
    bulkFileDataManager: createDefaultBulkFileDataManager(params),
    liveHeightThreshold: params.liveHeightThreshold,
    reorgHeightThreshold: params.reorgHeightThreshold,
    bulkMigrationChunkSize: params.bulkMigrationChunkSize,
    batchInsertLimit: params.batchInsertLimit
  }
}

export function startChaintracks<TStorage extends ChaintracksOptions['storage']> (
  params: ResolvedDefaultChaintracksParams,
  options: ChaintracksOptions
): CreatedChaintracks<TStorage> {
  const chaintracks = new Chaintracks(options)
  return {
    chain: params.chain,
    fetch: params.fetch,
    maxPerFile: params.maxPerFile,
    storage: options.storage as TStorage,
    chaintracks,
    available: chaintracks.makeAvailable()
  }
}

export function createAndStartDefaultChaintracks<TStorage extends ChaintracksOptions['storage']> (
  args: DefaultChaintracksArguments,
  createOptions: (...args: DefaultChaintracksArguments) => ChaintracksOptions
): CreatedChaintracks<TStorage> {
  const params = resolveDefaultChaintracksArguments(args)
  const options = createOptions(...toDefaultChaintracksArguments(params))
  return startChaintracks<TStorage>(params, options)
}

/**
 * Builds the shared portion of ChaintracksOptions that all storage backends
 * (Knex, Idb, NoDb) have in common: the options shell and bulk/live ingestors.
 *
 * The caller is responsible for providing the storage implementation.
 */
export function buildChaintracksOptionsWithIngestors (
  params: ChaintracksIngestorParams,
  storage: ChaintracksOptions['storage']
): ChaintracksOptions {
  const { chain, whatsonchainApiKey, maxPerFile, fetch, cdnUrl, addLiveRecursionLimit } = params

  const co: ChaintracksOptions = {
    chain,
    storage,
    bulkIngestors: [],
    liveIngestors: [],
    addLiveRecursionLimit,
    logging: (...args) => console.log(new Date().toISOString(), ...args),
    readonly: false
  }

  const jsonResource = `${chain}NetBlockHeaders.json`

  const bulkCdnOptions: BulkIngestorCDNOptions = {
    chain,
    jsonResource,
    fetch,
    cdnUrl,
    maxPerFile
  }
  co.bulkIngestors.push(new BulkIngestorCDNBabbage(bulkCdnOptions))

  const wocOptions: WhatsOnChainServicesOptions = {
    chain,
    apiKey: whatsonchainApiKey,
    timeout: 30000,
    userAgent: 'BabbageWhatsOnChainServices',
    enableCache: true,
    chainInfoMsecs: 5000
  }

  const bulkOptions: BulkIngestorWhatsOnChainOptions = {
    ...wocOptions,
    jsonResource,
    idleWait: 5000
  }
  co.bulkIngestors.push(new BulkIngestorWhatsOnChainCdn(bulkOptions))

  const liveOptions: LiveIngestorWhatsOnChainOptions = {
    ...wocOptions,
    idleWait: 100000
  }
  co.liveIngestors.push(new LiveIngestorWhatsOnChainPoll(liveOptions))

  return co
}
