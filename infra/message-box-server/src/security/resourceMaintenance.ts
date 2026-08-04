import type { Knex } from 'knex'
import { readResourceLimit } from './edgePolicy.js'
import { Logger } from '../utils/logger.js'

export interface MessageBoxMaintenance {
  run: () => Promise<void>
  stop: () => void
}

async function deleteExpired(
  knex: Knex,
  table: string,
  column: string,
  now: Date | number,
  batchSize: number
): Promise<number> {
  const query = knex(table).whereNotNull(column).where(column, '<=', now)
  if (batchSize !== -1) query.limit(batchSize)
  return await query.delete()
}

/**
 * Bounded expiry maintenance. Multiple replicas may run this safely because
 * every delete predicate is idempotent and database-atomic; operators can run
 * a singleton maintenance role later without changing the data model.
 */
export function startMessageBoxMaintenance(knex: Knex): MessageBoxMaintenance {
  const intervalMs = readResourceLimit(
    'MESSAGE_BOX',
    'RETENTION_CLEANUP_INTERVAL_MS',
    15 * 60 * 1_000
  )
  const batchSize = readResourceLimit('MESSAGE_BOX', 'RETENTION_CLEANUP_BATCH_SIZE', 1_000)
  let running = false
  let stopped = false

  const run = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const now = new Date()
      const [messages, replays, sessions] = await Promise.all([
        deleteExpired(knex, 'messages', 'expires_at', now, batchSize),
        deleteExpired(knex, 'payment_replays', 'expires_at', now, batchSize),
        deleteExpired(knex, 'auth_sessions', 'expiresAt', Date.now(), batchSize)
      ])
      if (messages + replays + sessions > 0) {
        Logger.log('[MAINTENANCE] Removed expired rows', { messages, replays, sessions })
      }
    } catch (error) {
      Logger.error('[MAINTENANCE] Failed to remove expired rows:', error)
    } finally {
      running = false
    }
  }

  void run()
  const timer = intervalMs === -1 ? undefined : setInterval(() => void run(), intervalMs)
  timer?.unref()
  return {
    run,
    stop: () => {
      stopped = true
      if (timer != null) clearInterval(timer)
    }
  }
}
