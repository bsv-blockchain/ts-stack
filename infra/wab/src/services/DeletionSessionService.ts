import { createHash, randomBytes } from 'node:crypto'
import { db } from '../db/knex'
import { orphanUserFaucetRecords } from './UserService'

const DELETION_TOKEN = /^deletion_[0-9a-f]{64}$/
const SESSION_TTL_MS = 10 * 60 * 1000
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT_MAX_ATTEMPTS = 3

interface DeletionSession {
  id: number
  tokenHash: string
  userId: number | null
  methodType: string
  config: string
  expiresAtEpochMs: string | number
  consumedAtEpochMs: string | number | null
  createdAtEpochMs: string | number
}

export class DeletionSessionRateLimitError extends Error {
  public constructor() {
    super('Too many deletion attempts. Please try again later.')
    this.name = 'DeletionSessionRateLimitError'
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function epochMs(value: string | number): number {
  return typeof value === 'number' ? value : Number(value)
}

/**
 * Persistent, multi-instance-safe account-deletion intent records. Only a
 * SHA-256 digest of the bearer token is stored.
 */
export class DeletionSessionService {
  public static async create(methodType: string, config: string, userId?: number): Promise<string> {
    const now = Date.now()
    const windowStart = now - RATE_LIMIT_WINDOW_MS
    const expiresAtEpochMs = now + SESSION_TTL_MS

    return await db.transaction(async transaction => {
      // Sessions older than the rate-limit window are necessarily
      // expired and no longer contribute to throttling.
      await transaction('account_deletion_sessions')
        .where('createdAtEpochMs', '<', windowStart)
        .del()

      const recent = await transaction<DeletionSession>('account_deletion_sessions')
        .where({ methodType, config })
        .andWhere('createdAtEpochMs', '>=', windowStart)
        .forUpdate()
        .select('createdAtEpochMs')
      const recentCount = recent.filter(session => {
        const createdAt = epochMs(session.createdAtEpochMs)
        return Number.isFinite(createdAt) && createdAt >= windowStart
      }).length

      if (recentCount >= RATE_LIMIT_MAX_ATTEMPTS) {
        throw new DeletionSessionRateLimitError()
      }

      const token = `deletion_${randomBytes(32).toString('hex')}`
      await transaction('account_deletion_sessions').insert({
        tokenHash: hashToken(token),
        userId: userId ?? null,
        methodType,
        config,
        expiresAtEpochMs,
        createdAtEpochMs: now
      })
      return token
    })
  }

  public static async findActive(
    token: string,
    methodType: string,
    config: string
  ): Promise<DeletionSession | undefined> {
    if (!DELETION_TOKEN.test(token)) return undefined

    const session = await db<DeletionSession>('account_deletion_sessions')
      .where({
        tokenHash: hashToken(token),
        methodType,
        config
      })
      .first()

    if (
      !session ||
      session.consumedAtEpochMs != null ||
      session.userId === null ||
      !Number.isFinite(epochMs(session.expiresAtEpochMs)) ||
      epochMs(session.expiresAtEpochMs) <= Date.now()
    ) {
      return undefined
    }
    return session
  }

  public static async consume(session: DeletionSession): Promise<boolean> {
    const now = Date.now()
    if (epochMs(session.expiresAtEpochMs) <= now) return false
    const updated = await db('account_deletion_sessions')
      .where({ id: session.id })
      .whereNull('consumedAtEpochMs')
      .andWhere('expiresAtEpochMs', '>', now)
      .update({ consumedAtEpochMs: now })
    return updated === 1
  }

  /**
   * Consume a verified deletion intent and remove exactly the account that
   * still owns its authentication identity. Locking the user first makes
   * deletion serialize with faucet reservations and identity changes.
   */
  public static async consumeAndDeleteUser(session: DeletionSession): Promise<boolean> {
    const now = Date.now()
    const userId = session.userId
    if (userId === null || epochMs(session.expiresAtEpochMs) <= now) return false

    return await db.transaction(async transaction => {
      const user = await transaction('users').select('id').where({ id: userId }).forUpdate().first()
      if (!user) return false

      const authMethod = await transaction('auth_methods')
        .select('id')
        .where({
          userId,
          methodType: session.methodType,
          config: session.config
        })
        .forUpdate()
        .first()
      if (!authMethod) return false

      const consumed = await transaction('account_deletion_sessions')
        .where({
          id: session.id,
          tokenHash: session.tokenHash,
          userId,
          methodType: session.methodType,
          config: session.config
        })
        .whereNull('consumedAtEpochMs')
        .andWhere('expiresAtEpochMs', '>', now)
        .update({ consumedAtEpochMs: now })
      if (consumed !== 1) return false

      await orphanUserFaucetRecords(transaction, userId)
      const deleted = await transaction('users').where({ id: userId }).del()
      if (deleted !== 1) {
        throw new Error('User account changed before it could be deleted.')
      }
      return true
    })
  }
}
