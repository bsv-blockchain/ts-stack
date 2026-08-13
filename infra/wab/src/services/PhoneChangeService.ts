import { createHash, randomBytes } from 'node:crypto'
import { db } from '../db/knex'
import type { AuthMethodEntity, User } from '../types'

const PHONE_CHANGE_TTL_MS = 10 * 60 * 1000

interface PhoneChangeSessionEntity {
  id: number
  tokenHash: string
  userId: number | null
  methodType: string
  config: string
  expiresAtEpochMs: string | number
  consumedAtEpochMs: string | number | null
  committedChangeId: number | null
  createdAtEpochMs: string | number
}

interface PhoneChangeHistoryEntity {
  id: number
  targetUserId: number | null
  phoneAuthMethodId: number | null
  previousPhoneOwnerUserId: number | null
  replacedAuthMethodId: number | null
  methodType: string
  config: string
  previousPresentationKey: string
  newPresentationKey: string
  createdAtEpochMs: string | number
  restoredAtEpochMs: string | number | null
}

export class PhoneChangeError extends Error {
  constructor(
    message: string,
    readonly status: number = 409
  ) {
    super(message)
    this.name = 'PhoneChangeError'
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function insertedId(result: unknown): number | undefined {
  const candidate = Array.isArray(result) ? result[0] : result
  if (typeof candidate === 'number') return candidate
  if (candidate == null || typeof candidate !== 'object' || !('id' in candidate)) return undefined
  const id = (candidate as { id?: unknown }).id
  return typeof id === 'number' ? id : undefined
}

export class PhoneChangeService {
  static async createAuthorization(
    userId: number,
    methodType: string,
    config: string
  ): Promise<string> {
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    await db('phone_change_sessions').insert({
      tokenHash: tokenHash(token),
      userId,
      methodType,
      config,
      expiresAtEpochMs: now + PHONE_CHANGE_TTL_MS,
      consumedAtEpochMs: null,
      committedChangeId: null,
      createdAtEpochMs: now
    })
    return token
  }

  static async commit(
    token: string,
    currentPresentationKey: string,
    newPresentationKey: string
  ): Promise<number> {
    return await db.transaction(async trx => {
      const session = await trx<PhoneChangeSessionEntity>('phone_change_sessions')
        .where({ tokenHash: tokenHash(token) })
        .forUpdate()
        .first()
      if (session?.userId == null) {
        throw new PhoneChangeError('Phone change authorization is invalid or expired.', 401)
      }

      if (session.consumedAtEpochMs != null) {
        if (session.committedChangeId == null) {
          throw new PhoneChangeError('Phone change authorization was already used.', 401)
        }
        const committed = await trx<PhoneChangeHistoryEntity>('phone_change_history')
          .where({ id: session.committedChangeId })
          .first()
        if (committed?.newPresentationKey !== newPresentationKey) {
          throw new PhoneChangeError('Phone change authorization was already used.', 401)
        }
        return committed.id
      }
      if (Number(session.expiresAtEpochMs) <= Date.now()) {
        throw new PhoneChangeError('Phone change authorization is invalid or expired.', 401)
      }

      const user = await trx<User>('users').where({ id: session.userId }).forUpdate().first()
      if (user?.presentationKey !== currentPresentationKey) {
        throw new PhoneChangeError('The current wallet account could not be verified.', 401)
      }

      const currentMethod = await trx<AuthMethodEntity>('auth_methods')
        .where({ userId: user.id, methodType: session.methodType })
        .forUpdate()
        .first()
      let claimedMethod = await trx<AuthMethodEntity>('auth_methods')
        .where({ methodType: session.methodType, config: session.config })
        .forUpdate()
        .first()
      const previousPhoneOwnerUserId = claimedMethod?.userId ?? null

      if (claimedMethod == null) {
        const result = await trx('auth_methods').insert(
          {
            userId: user.id,
            methodType: session.methodType,
            config: session.config,
            receivedFaucet: false
          },
          ['id']
        )
        const id = insertedId(result)
        if (id == null) throw new Error('Failed to create the phone authentication record.')
        claimedMethod = await trx<AuthMethodEntity>('auth_methods').where({ id }).first()
        if (claimedMethod == null)
          throw new Error('Failed to load the phone authentication record.')
      }

      if (currentMethod != null && currentMethod.id !== claimedMethod.id) {
        await trx('auth_methods')
          .where({ id: currentMethod.id, userId: user.id })
          .update({ userId: null })
      }
      if (claimedMethod.userId !== user.id) {
        await trx('auth_methods').where({ id: claimedMethod.id }).update({ userId: user.id })
      }

      await trx('users').where({ id: user.id }).update({
        presentationKey: newPresentationKey,
        umpTokenOutpoint: null
      })

      const now = Date.now()
      const historyResult = await trx('phone_change_history').insert(
        {
          targetUserId: user.id,
          phoneAuthMethodId: claimedMethod.id,
          previousPhoneOwnerUserId,
          replacedAuthMethodId: currentMethod?.id ?? null,
          methodType: session.methodType,
          config: session.config,
          previousPresentationKey: currentPresentationKey,
          newPresentationKey,
          createdAtEpochMs: now,
          restoredAtEpochMs: null
        },
        ['id']
      )
      const changeId = insertedId(historyResult)
      if (changeId == null) throw new Error('Failed to record the phone change.')

      await trx('phone_change_sessions').where({ id: session.id, consumedAtEpochMs: null }).update({
        consumedAtEpochMs: now,
        committedChangeId: changeId
      })
      return changeId
    })
  }

  static async restore(changeId: number): Promise<void> {
    await db.transaction(async trx => {
      const history = await trx<PhoneChangeHistoryEntity>('phone_change_history')
        .where({ id: changeId })
        .forUpdate()
        .first()
      if (history == null) throw new PhoneChangeError('Phone change record was not found.', 404)
      if (history.restoredAtEpochMs != null) return
      if (history.targetUserId == null || history.phoneAuthMethodId == null) {
        throw new PhoneChangeError('Phone change record can no longer be restored automatically.')
      }

      const phoneMethod = await trx<AuthMethodEntity>('auth_methods')
        .where({ id: history.phoneAuthMethodId })
        .forUpdate()
        .first()
      if (phoneMethod?.userId !== history.targetUserId) {
        throw new PhoneChangeError('Phone ownership changed again; manual review is required.')
      }

      await trx('auth_methods')
        .where({ id: history.phoneAuthMethodId, userId: history.targetUserId })
        .update({ userId: history.previousPhoneOwnerUserId })

      if (
        history.replacedAuthMethodId != null &&
        history.replacedAuthMethodId !== history.phoneAuthMethodId
      ) {
        const replaced = await trx<AuthMethodEntity>('auth_methods')
          .where({ id: history.replacedAuthMethodId })
          .forUpdate()
          .first()
        if (replaced?.userId != null) {
          throw new PhoneChangeError(
            'The prior phone record is already linked; manual review is required.'
          )
        }
        await trx('auth_methods')
          .where({ id: history.replacedAuthMethodId })
          .whereNull('userId')
          .update({ userId: history.targetUserId })
      }

      await trx('phone_change_history')
        .where({ id: history.id })
        .update({ restoredAtEpochMs: Date.now() })
    })
  }
}
