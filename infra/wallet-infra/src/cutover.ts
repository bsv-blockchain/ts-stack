import { runSchemaCutover } from '@bsv/wallet-toolbox'
import knexPkg from 'knex'
const { knex: makeKnex } = knexPkg
import type { Knex } from 'knex'
import * as dotenv from 'dotenv'
dotenv.config()

const { KNEX_DB_CONNECTION } = process.env

async function main() {
  if (!KNEX_DB_CONNECTION) throw new Error('KNEX_DB_CONNECTION must be set')

  const connection = JSON.parse(KNEX_DB_CONNECTION)
  const knexConfig: Knex.Config = {
    client: 'mysql2',
    connection,
    useNullAsDefault: true,
    pool: { min: 1, max: 4 }
  }
  const knex = makeKnex(knexConfig)

  console.log('Running schema cutover…')
  await runSchemaCutover(knex)
  console.log('Schema cutover complete.')

  await knex.destroy()
}

main().catch(err => {
  console.error('Cutover failed:', err)
  process.exit(1)
})
