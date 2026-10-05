/* eslint-disable @typescript-eslint/no-empty-function */
import { Chain } from '../../../../sdk/types'
import { LiveIngestorApi } from '../Api/LiveIngestorApi'
import { ChaintracksStorageApi } from '../Api/ChaintracksStorageApi'
import { BlockHeader } from '../Api/BlockHeaderApi'

const SUPPORTED_CHAINS = new Set<Chain>(['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'])

export interface LiveIngestorBaseOptions {
  /**
   * The target chain: "main" or "test"
   */
  chain: Chain
}

/**
 *
 */
export abstract class LiveIngestorBase implements LiveIngestorApi {
  static createLiveIngestorBaseOptions(chain: Chain) {
    const options: LiveIngestorBaseOptions = {
      chain
    }
    return options
  }

  chain: Chain
  log: (...args: any[]) => void = () => {}

  constructor(options: LiveIngestorBaseOptions) {
    if (options == null || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Live ingestor options must be a data object.')
    }
    const descriptors = Object.getOwnPropertyDescriptors(options)
    if (Object.keys(descriptors).length > 64 || Object.values(descriptors).some(d => d.get != null || d.set != null)) {
      throw new Error('Live ingestor options must contain only bounded data properties.')
    }
    if (!SUPPORTED_CHAINS.has(options.chain)) throw new Error('chain must be a supported Chain value.')
    this.chain = options.chain
  }

  /**
   * Release resources.
   * Override if required.
   */
  async shutdown(): Promise<void> {}

  private storageEngine?: ChaintracksStorageApi

  /**
   * Allocate resources.
   * @param storage coordinating storage engine.
   */
  async setStorage(storage: ChaintracksStorageApi, log: (...args: any[]) => void): Promise<void> {
    if (storage == null || typeof storage !== 'object') throw new Error('storage must be an object.')
    if (typeof log !== 'function') throw new Error('log must be a function.')
    this.storageEngine = storage
    this.log = log
  }

  /**
   *
   * @returns coordinating storage engine.
   */
  storage(): ChaintracksStorageApi {
    if (this.storageEngine == null) throw new Error('storageEngine must be set.')
    return this.storageEngine
  }

  /**
   * Called to retrieve a missing block header,
   * when the previousHash of a new header is unknown.
   *
   * @param hash block hash of missing header
   */
  abstract getHeaderByHash(hash: string): Promise<BlockHeader | undefined>

  /**
   * Begin retrieving new block headers.
   *
   * New headers are pushed onto the liveHeaders array.
   *
   * Continue waiting for new headers.
   *
   * Return only when either `stopListening` or `shutdown` are called.
   *
   * Be prepared to resume listening after `stopListening` but not
   * after `shutdown`.
   *
   * @param liveHeaders
   */
  abstract startListening(liveHeaders: BlockHeader[]): Promise<void>

  /**
   * Causes `startListening` to stop listening for new block headers and return.
   */
  abstract stopListening(): void
}
