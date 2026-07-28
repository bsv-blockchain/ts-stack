import { ChaintracksOptions } from './Api/ChaintracksApi'
import { ChaintracksStorageNoDb } from './Storage/ChaintracksStorageNoDb'
import {
  buildChaintracksOptionsWithIngestors,
  createDefaultChaintracksStorageOptions,
  type DefaultChaintracksArguments,
  resolveDefaultChaintracksArguments
} from './configureChaintracksIngestors'

export function createDefaultNoDbChaintracksOptions (...args: DefaultChaintracksArguments): ChaintracksOptions {
  const params = resolveDefaultChaintracksArguments(args)
  const storage = new ChaintracksStorageNoDb(createDefaultChaintracksStorageOptions(params))
  return buildChaintracksOptionsWithIngestors(params, storage)
}
