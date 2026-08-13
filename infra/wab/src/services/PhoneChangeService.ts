import { createHash, randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
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
  finalizedAtEpochMs: string | number | null
  restoredAtEpochMs: string | number | null
}

export interface PendingPhoneChange {
  changeId: number
  presentationKey: string
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

async function findOrCreatePhoneMethod(
  trx: Knex.Transaction,
  userId: number,
  methodType: string,
  config: string
): Promise<{ claimedMethod: AuthMethodEntity; previousPhoneOwnerUserId: number | null }> {
  const existingMethod = await trx<AuthMethodEntity>('auth_methods')
    .where({ methodType, config })
    .forUpdate()
    .first()
  if (existingMethod != null) {
    return {
      claimedMethod: existingMethod,
      previousPhoneOwnerUserId: existingMethod.userId ?? null
    }
  }

  const result = await trx('auth_methods').insert(
    { userId, methodType, config, receivedFaucet: false },
    ['id']
  )
  const id = insertedId(result)
  if (id == null) throw new Error('Failed to create the phone authentication record.')
  const claimedMethod = await trx<AuthMethodEntity>('auth_methods').where({ id }).first()
  if (claimedMethod == null) throw new Error('Failed to load the phone authentication record.')
  return { claimedMethod, previousPhoneOwnerUserId: null }
}

export class PhoneChangeService {
  static async findPending(
    userId: number,
    methodType?: string,
    config?: string
  ): Promise<PendingPhoneChange | undefined> {
    const user = await db<User>('users').where({ id: userId }).first()
    if (user?.pendingPresentationKey == null) return undefined
    const query = db<PhoneChangeHistoryEntity>('phone_change_history')
      .where({
        targetUserId: userId,
        newPresentationKey: user.pendingPresentationKey,
        finalizedAtEpochMs: null,
        restoredAtEpochMs: null
      })
    if (methodType != null) query.andWhere({ methodType })
    if (config != null) query.andWhere({ config })
    const history = await query
      .orderBy('id', 'desc')
      .first()
    return history == null
      ? undefined
      : { changeId: history.id, presentationKey: user.pendingPresentationKey }
  }

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
      if (
        user.pendingPresentationKey != null &&
        user.pendingPresentationKey !== newPresentationKey
      ) {
        throw new PhoneChangeError('A phone change is already awaiting wallet completion.')
      }

      const currentMethod = await trx<AuthMethodEntity>('auth_methods')
        .where({ userId: user.id, methodType: session.methodType })
        .forUpdate()
        .first()
      const { claimedMethod, previousPhoneOwnerUserId } = await findOrCreatePhoneMethod(
        trx,
        user.id,
        session.methodType,
        session.config
      )

      if (currentMethod != null && currentMethod.id !== claimedMethod.id) {
        await trx('auth_methods')
          .where({ id: currentMethod.id, userId: user.id })
          .update({ userId: null })
      }
      if (claimedMethod.userId !== user.id) {
        await trx('auth_methods').where({ id: claimedMethod.id }).update({ userId: user.id })
      }

      await trx('users')
        .where({ id: user.id })
        .update({ pendingPresentationKey: newPresentationKey })

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
          finalizedAtEpochMs: null,
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

  static async finalize(
    changeId: number,
    currentPresentationKey: string,
    newPresentationKey: string
  ): Promise<void> {
    await db.transaction(async trx => {
      const history = await trx<PhoneChangeHistoryEntity>('phone_change_history')
        .where({ id: changeId })
        .forUpdate()
        .first()
      if (
        history?.targetUserId == null ||
        history.restoredAtEpochMs != null ||
        history.previousPresentationKey !== currentPresentationKey ||
        history.newPresentationKey !== newPresentationKey
      ) {
        throw new PhoneChangeError('Phone change finalization could not be verified.', 401)
      }

      const user = await trx<User>('users').where({ id: history.targetUserId }).forUpdate().first()
      if (history.finalizedAtEpochMs != null) {
        if (user?.presentationKey !== newPresentationKey) {
          throw new PhoneChangeError('Phone change finalization no longer matches the account.')
        }
        return
      }
      if (
        user?.presentationKey !== currentPresentationKey ||
        user.pendingPresentationKey !== newPresentationKey
      ) {
        throw new PhoneChangeError('Phone change finalization no longer matches the account.')
      }

      const now = Date.now()
      await trx('users').where({ id: user.id }).update({
        presentationKey: newPresentationKey,
        pendingPresentationKey: null,
        umpTokenOutpoint: null
      })
      await trx('phone_change_history')
        .where({ id: history.id })
        .update({ finalizedAtEpochMs: now })
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

      if (history.finalizedAtEpochMs == null) {
        await trx('users')
          .where({ id: history.targetUserId, pendingPresentationKey: history.newPresentationKey })
          .update({ pendingPresentationKey: null })
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
