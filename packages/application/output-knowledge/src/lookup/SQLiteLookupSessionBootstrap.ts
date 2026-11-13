import { OutputProtocolError } from '@bsv/sdk'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'
import type { SQLiteLookupBridge } from './SQLiteLookupBridge.js'
import type { LookupSessionCodec } from './LookupSessionCodec.js'
import type { LookupSessionCapacity } from './LookupSessionStorage.js'
import { SQLiteLookupSessions, sqliteLookupSessionComposition } from './SQLiteLookupSessions.js'

/**
 * Internal installation capability. Session schema and inventory initialization
 * join the caller's already active compound transaction. Thereafter every public
 * session operation uses the ordinary owned transaction gate. No public nested
 * transaction or raw database port is introduced.
 */
export function bootstrapSQLiteLookupSessions(
  domain: SQLiteTransactionDomain,
  bridge: SQLiteLookupBridge,
  codec: LookupSessionCodec,
  clock: () => string,
  capacity: Partial<LookupSessionCapacity>,
  create: boolean
): SQLiteLookupSessions {
  domain.writing()
  if (bridge.database !== domain.database)
    throw new OutputProtocolError(
      'invalid',
      'Session bootstrap requires the same physical connection'
    )
  let initializing = true
  const installed: SQLiteLookupBridge = {
    ...bridge,
    transaction: work => (initializing ? domain.savepoint(work) : bridge.transaction(work))
  }
  try {
    return SQLiteLookupSessions[sqliteLookupSessionComposition](
      installed,
      codec,
      clock,
      capacity,
      create
    )
  } finally {
    initializing = false
  }
}
