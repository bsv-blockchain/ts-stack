import type * as sdk from '../../../sdk'

export type PreparedBeefState = 'ready' | 'stale' | 'failed'

/**
 * Rebuildable, user-scoped proof material prepared for a future spend.
 *
 * This table is deliberately excluded from wallet synchronization. The
 * authoritative transaction, proof, and output rows can always rebuild it.
 */
export interface TablePreparedBeef extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  preparedBeefId: number
  userId: number
  rootTxid: string
  beef: number[]
  checksum: string
  formatVersion: number
  state: PreparedBeefState
  txCount: number
  bumpCount: number
  byteLength: number
}
