export interface DatabaseRetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

interface DatabaseError {
  code?: unknown
  errno?: unknown
  sqlState?: unknown
}

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_BASE_DELAY_MS = 10
const DEFAULT_MAX_DELAY_MS = 250

function readBoundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

export function readDatabaseRetryConfig(): DatabaseRetryConfig {
  const config = {
    maxRetries: readBoundedInteger('MESSAGE_BOX_DB_DEADLOCK_RETRIES', DEFAULT_MAX_RETRIES, 0, 20),
    baseDelayMs: readBoundedInteger(
      'MESSAGE_BOX_DB_DEADLOCK_RETRY_BASE_MS',
      DEFAULT_BASE_DELAY_MS,
      1,
      10_000
    ),
    maxDelayMs: readBoundedInteger(
      'MESSAGE_BOX_DB_DEADLOCK_RETRY_MAX_MS',
      DEFAULT_MAX_DELAY_MS,
      1,
      60_000
    )
  }
  if (config.baseDelayMs > config.maxDelayMs) {
    throw new Error(
      'MESSAGE_BOX_DB_DEADLOCK_RETRY_BASE_MS must not exceed MESSAGE_BOX_DB_DEADLOCK_RETRY_MAX_MS'
    )
  }
  return config
}

export function isRetryableDatabaseConflict(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const databaseError = error as DatabaseError
  return (
    databaseError.code === 'ER_LOCK_DEADLOCK' ||
    databaseError.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    databaseError.errno === 1213 ||
    databaseError.errno === 1205 ||
    databaseError.sqlState === '40001'
  )
}

export async function withDatabaseConflictRetry<T>(
  operation: () => Promise<T>,
  config: DatabaseRetryConfig,
  onRetry?: (error: unknown, retry: number, delayMs: number) => void,
  sleep: (delayMs: number) => Promise<void> = async delayMs =>
    await new Promise(resolve => setTimeout(resolve, delayMs))
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isRetryableDatabaseConflict(error) || attempt >= config.maxRetries) throw error
      const retry = attempt + 1
      const delayMs = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs)
      onRetry?.(error, retry, delayMs)
      await sleep(delayMs)
    }
  }
}
