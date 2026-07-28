import { Chain } from '../../../sdk'
import { Chaintracks } from './Chaintracks'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { ChaintracksStorageKnex } from './Storage/ChaintracksStorageKnex'
import { createDefaultKnexChaintracksOptions } from './createDefaultKnexChaintracksOptions'
import {
  createAndStartDefaultKnexChaintracks,
  type DefaultKnexChaintracksArguments
} from './configureKnexChaintracks'

export async function createKnexChaintracks (...args: DefaultKnexChaintracksArguments): Promise<{
  chain: Chain
  maxPerFile: number
  fetch: ChaintracksFetchApi
  storage: ChaintracksStorageKnex
  chaintracks: Chaintracks
  available: Promise<void>
}> {
  try {
    return createAndStartDefaultKnexChaintracks<ChaintracksStorageKnex>(args, createDefaultKnexChaintracksOptions)
  } catch (error) {
    console.error('Error setting up Chaintracks with Knex Storage:', error)
    throw error
  }
}
