import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { outputU64, OutputProtocolError } from '@bsv/sdk'

export const position = (value: string): string => outputU64(value).toString(16).padStart(16, '0')
export function decimal(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 16 || /[^0-9a-f]/.test(value))
    throw new OutputProtocolError('reset-required', 'Invalid lookup index sequence')
  return BigInt('0x' + value).toString()
}
export const bytes = (value: string): number => new TextEncoder().encode(value).length

/** Every provider query must compile to a statement; empty SQL is a caller error. */
export function prepareLookupStatement(
  database: Pick<DatabaseSync, 'prepare'>,
  sql: string
): StatementSync {
  if (sql.trim().length === 0)
    throw new OutputProtocolError('invalid', 'Lookup SQL statement is empty')
  return database.prepare(sql)
}
