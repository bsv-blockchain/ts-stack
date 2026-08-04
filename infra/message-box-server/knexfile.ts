import dotenv from 'dotenv'
import type { Knex } from 'knex'
dotenv.config()

const connectionConfig =
  process.env.KNEX_DB_CONNECTION != null && process.env.KNEX_DB_CONNECTION.trim() !== ''
    ? JSON.parse(process.env.KNEX_DB_CONNECTION)
    : undefined

function readPoolValue(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const pattern = allowZero ? /^\d+$/ : /^[1-9]\d*$/
  if (!pattern.test(raw)) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`)
  return value
}

const pool = {
  min: readPoolValue('MESSAGE_BOX_DB_POOL_MIN', 0, true),
  max: readPoolValue('MESSAGE_BOX_DB_POOL_MAX', 7),
  idleTimeoutMillis: readPoolValue('MESSAGE_BOX_DB_IDLE_TIMEOUT_MS', 15_000)
}
if (pool.min > pool.max) {
  throw new Error('MESSAGE_BOX_DB_POOL_MIN must not exceed MESSAGE_BOX_DB_POOL_MAX')
}

const config: Knex.Config = {
  client: process.env.KNEX_DB_CLIENT ?? 'mysql2',
  connection: connectionConfig,
  useNullAsDefault: true,
  migrations: {
    directory: './out/src/migrations'
  },
  pool
}

const knexfile: { [key: string]: Knex.Config } = {
  development: config,
  staging: config,
  production: config
}

export default knexfile
