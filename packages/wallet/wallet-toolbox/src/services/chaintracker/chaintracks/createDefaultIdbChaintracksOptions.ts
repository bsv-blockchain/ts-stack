import { ChaintracksOptions } from './Api/ChaintracksApi'
import { ChaintracksStorageIdb } from './Storage/ChaintracksStorageIdb'
import {
  buildChaintracksOptionsWithIngestors,
  createDefaultChaintracksStorageOptions,
  type DefaultChaintracksArguments,
  resolveDefaultChaintracksArguments
} from './configureChaintracksIngestors'

export function createDefaultIdbChaintracksOptions (...args: DefaultChaintracksArguments): ChaintracksOptions {
  const params = resolveDefaultChaintracksArguments(args)
  const storage = new ChaintracksStorageIdb(createDefaultChaintracksStorageOptions(params))
  return buildChaintracksOptionsWithIngestors(params, storage)
}
