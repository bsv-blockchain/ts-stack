import { Chain } from '../../../sdk'
import { Chaintracks } from './Chaintracks'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { ChaintracksStorageIdb } from './Storage/ChaintracksStorageIdb'
import { createDefaultIdbChaintracksOptions } from './createDefaultIdbChaintracksOptions'
import {
  createAndStartDefaultChaintracks,
  type DefaultChaintracksArguments
} from './configureChaintracksIngestors'

export async function createIdbChaintracks (...args: DefaultChaintracksArguments): Promise<{
  chain: Chain
  maxPerFile: number
  fetch: ChaintracksFetchApi
  storage: ChaintracksStorageIdb
  chaintracks: Chaintracks
  available: Promise<void>
}> {
  try {
    return createAndStartDefaultChaintracks<ChaintracksStorageIdb>(args, createDefaultIdbChaintracksOptions)
  } catch (error) {
    console.error('Error setting up Chaintracks with Idb Storage:', error)
    throw error
  }
}
