import dotenv from 'dotenv'
import type { Knex } from 'knex'
dotenv.config()

const connectionConfig = process.env.KNEX_DB_CONNECTION != null && process.env.KNEX_DB_CONNECTION.trim() !== ''
  ? JSON.parse(process.env.KNEX_DB_CONNECTION)
  : undefined

const config: Knex.Config = {
  client: process.env.KNEX_DB_CLIENT ?? 'mysql2',
  connection: connectionConfig,
  useNullAsDefault: true,
  migrations: {
    directory: './out/src/migrations'
  },
  pool: {
    min: 0,
    max: 7,
    idleTimeoutMillis: 15000
  }
}

const knexfile: { [key: string]: Knex.Config } = {
  development: config,
  staging: config,
  production: config
}

export default knexfile
