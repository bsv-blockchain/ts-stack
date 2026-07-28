import { Knex, knex as makeKnex } from 'knex'
import { ChaintracksOptions } from './Api/ChaintracksApi'
import { ChaintracksFs } from './util/ChaintracksFs'
import { ChaintracksStorageKnex } from './Storage/ChaintracksStorageKnex'
import {
  buildChaintracksOptionsWithIngestors,
  createDefaultChaintracksStorageOptions
} from './configureChaintracksIngestors'
import {
  type DefaultKnexChaintracksArguments,
  resolveDefaultKnexChaintracksArguments
} from './configureKnexChaintracks'

/**
 *
 * @param chain
 * @param rootFolder defaults to "./data/"
 * @returns
 */
export function createDefaultKnexChaintracksOptions (...args: DefaultKnexChaintracksArguments): ChaintracksOptions {
  const params = resolveDefaultKnexChaintracksArguments(args)

  const knexConfig: Knex.Config = params.knexConfig ?? {
    client: 'better-sqlite3',
    connection: {
      filename: ChaintracksFs.pathJoin(params.rootFolder, `${params.chain}Net_chaintracks.sqlite`)
    },
    useNullAsDefault: true
  }
  const knexInstance = makeKnex(knexConfig)

  const storage = new ChaintracksStorageKnex({
    ...createDefaultChaintracksStorageOptions(params),
    knex: knexInstance
  })

  return buildChaintracksOptionsWithIngestors(params, storage)
}
