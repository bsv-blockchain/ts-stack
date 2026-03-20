import { Chain } from '../../../sdk'
import { ChaintracksOptions } from './Api/ChaintracksApi'
import { BulkIngestorCDNBabbage } from './Ingest/BulkIngestorCDNBabbage'
import { LiveIngestorWhatsOnChainOptions, LiveIngestorWhatsOnChainPoll } from './Ingest/LiveIngestorWhatsOnChainPoll'
import { BulkIngestorWhatsOnChainCdn, BulkIngestorWhatsOnChainOptions } from './Ingest/BulkIngestorWhatsOnChainCdn'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { BulkIngestorCDNOptions } from './Ingest/BulkIngestorCDN'
import { WhatsOnChainServicesOptions } from './Ingest/WhatsOnChainServices'

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

/**
 * Builds the shared portion of ChaintracksOptions that all storage backends
 * (Knex, Idb, NoDb) have in common: the options shell and bulk/live ingestors.
 *
 * The caller is responsible for providing the storage implementation.
 */
export function buildChaintracksOptionsWithIngestors(
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
