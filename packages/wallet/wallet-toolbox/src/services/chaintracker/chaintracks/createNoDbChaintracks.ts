import { promiseFromSync } from '../../../utility/promiseFromSync'
import { Chain } from '../../../sdk'
import { Chaintracks } from './Chaintracks'
import { ChaintracksFetchApi } from './Api/ChaintracksFetchApi'
import { ChaintracksStorageNoDb } from './Storage/ChaintracksStorageNoDb'
import { createDefaultNoDbChaintracksOptions } from './createDefaultNoDbChaintracksOptions'
import { createAndStartDefaultChaintracks, type DefaultChaintracksArguments } from './configureChaintracksIngestors'

export function createNoDbChaintracks(...args: DefaultChaintracksArguments): Promise<{
  chain: Chain
  maxPerFile: number
  fetch: ChaintracksFetchApi
  storage: ChaintracksStorageNoDb
  chaintracks: Chaintracks
  available: Promise<void>
}> {
  return promiseFromSync(() => {
    return createAndStartDefaultChaintracks<ChaintracksStorageNoDb>(args, createDefaultNoDbChaintracksOptions)
  })
}
