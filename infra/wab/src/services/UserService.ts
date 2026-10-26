/**
 * UserService
 *
 * Provides utility methods to handle storing and retrieving user data,
 * linking/unlinking auth methods, and retrieving faucet payments.
 */

import { Setup } from '@bsv/wallet-toolbox'
import type { Knex } from 'knex'
import { db } from '../db/knex'
import { insertedIdFromResult } from '../db/resultValidation'
import { User, AuthMethodEntity, PaymentEntity } from '../types'
import { Curve, Random, RPuzzle, Transaction, Utils } from '@bsv/sdk'
import { log } from '../logger'
import { readFaucetWalletConfig } from '../config/faucet'
import {
  decryptPresentationKey,
  encryptPresentationKey,
  isRedactedPresentationKey,
  presentationKeyVaultMode,
  presentationKeyLookup
} from '../security/presentationKeyVault'

export interface UserStorageRow extends User {
  presentationKeyLookup?: string | null
  presentationKeyCiphertext?: string | null
  pendingPresentationKeyLookup?: string | null
  pendingPresentationKeyCiphertext?: string | null
}

export function storedPresentationKeyColumns(key: string): Record<string, string | null> {
  const mode = presentationKeyVaultMode()
  if (mode === 'legacy') {
    return {
      presentationKey: key,
      presentationKeyLookup: null,
      presentationKeyCiphertext: null
    }
  }
  const lookup = presentationKeyLookup(key)
  return {
    presentationKey: mode === 'dual-write' ? key : `encrypted_${lookup.slice(0, 54)}`,
    presentationKeyLookup: lookup,
    presentationKeyCiphertext: encryptPresentationKey(key)
  }
}

export function storedPendingPresentationKeyColumns(key: string): Record<string, string | null> {
  const mode = presentationKeyVaultMode()
  if (mode === 'legacy') {
    return {
      pendingPresentationKey: key,
      pendingPresentationKeyLookup: null,
      pendingPresentationKeyCiphertext: null
    }
  }
  return {
    pendingPresentationKey: mode === 'dual-write' ? key : null,
    pendingPresentationKeyLookup: presentationKeyLookup(key),
    pendingPresentationKeyCiphertext: encryptPresentationKey(key)
  }
}

function hydratedPresentationKey(
  row: UserStorageRow,
  mode: ReturnType<typeof presentationKeyVaultMode>
): string {
  if (mode !== 'encrypted') {
    if (!isRedactedPresentationKey(row.presentationKey)) return row.presentationKey
    if (mode === 'dual-write' && row.presentationKeyCiphertext != null) {
      return decryptPresentationKey(row.presentationKeyCiphertext)
    }
    throw new Error('The presentation key is redacted but the vault is not in encrypted mode.')
  }

  if (row.presentationKeyCiphertext != null) {
    return decryptPresentationKey(row.presentationKeyCiphertext)
  }
  const isShamirPlaceholder = row.userIdHash != null && row.presentationKey.startsWith('shamir_')
  if (!isShamirPlaceholder) {
    throw new Error('Encrypted mode requires presentation-key ciphertext on every legacy account.')
  }
  return row.presentationKey
}

function hydratedPendingPresentationKey(
  row: UserStorageRow,
  mode: ReturnType<typeof presentationKeyVaultMode>
): string | null | undefined {
  if (mode !== 'encrypted') return row.pendingPresentationKey
  if (row.pendingPresentationKeyCiphertext != null) {
    return decryptPresentationKey(row.pendingPresentationKeyCiphertext)
  }
  if (row.pendingPresentationKey != null) {
    throw new Error('Encrypted mode requires ciphertext for a pending presentation key.')
  }
  return row.pendingPresentationKey
}

export function hydrateUserRow(row: UserStorageRow | undefined): User | undefined {
  if (row == null) return undefined
  const mode = presentationKeyVaultMode()
  return {
    id: row.id,
    presentationKey: hydratedPresentationKey(row, mode),
    registrationStatus: row.registrationStatus,
    pendingPresentationKey: hydratedPendingPresentationKey(row, mode),
    umpTokenOutpoint: row.umpTokenOutpoint,
    userIdHash: row.userIdHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

const MAX_FAUCET_ATOMIC_BEEF_BYTES = 16 * 1024 * 1024

function copyDenseBytes(value: unknown, field: string, maxBytes: number): number[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a dense byte array.`)
  const length = value.length
  if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes) {
    throw new Error(`${field} exceeds its byte limit.`)
  }
  const bytes = Array.from({ length }, () => 0)
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    const ownValue =
      descriptor == null ? undefined : Object.getOwnPropertyDescriptor(descriptor, 'value')
    const byte = ownValue?.value
    if (ownValue == null || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`${field} must be a dense byte array.`)
    }
    bytes[index] = byte
  }
  return bytes
}

function ownDataProperty(value: unknown, field: string): unknown {
  if (value == null || typeof value !== 'object') {
    throw new Error('Faucet wallet returned malformed transaction evidence.')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  const ownValue =
    descriptor == null ? undefined : Object.getOwnPropertyDescriptor(descriptor, 'value')
  if (ownValue == null) {
    throw new Error('Faucet wallet returned malformed transaction evidence.')
  }
  return ownValue.value
}

/**
 * A faucet reservation and a prior auth-method marker are both durable proof
 * that a user has consumed the one-time grant. Callers must first lock the
 * user row so identity changes serialize with this check.
 */
export async function userHasFaucetClaim(trx: Knex.Transaction, userId: number): Promise<boolean> {
  // A persisted payment row means an irreversible payout may already have
  // happened. Unknown or forward-version states must therefore fail closed.
  const payment = await trx<Pick<PaymentEntity, 'userId'>>('payments')
    .select('userId')
    .where({ userId })
    .first()
  if (payment != null) return true

  const claimedMethod = await trx<AuthMethodEntity>('auth_methods')
    .select('id')
    .where({ userId, receivedFaucet: true })
    .first()
  return claimedMethod != null
}

/** Preserve one-time faucet evidence even when database FK enforcement differs. */
export async function orphanUserFaucetRecords(
  trx: Knex.Transaction,
  userId: number
): Promise<void> {
  const authMethods = await trx<AuthMethodEntity>('auth_methods')
    .select('id', 'receivedFaucet')
    .where({ userId })
    .forUpdate()
  const payments = await trx<PaymentEntity>('payments')
    .select('id', 'status')
    .where({ userId })
    .forUpdate()
  // Any payment row is durable claim evidence, including a state written by a
  // newer server version or a value that requires operator reconciliation.
  const hasFaucetClaim =
    payments.length > 0 || authMethods.some(method => Boolean(method.receivedFaucet))

  if (authMethods.length > 0) {
    const orphanedMethods = await trx('auth_methods')
      .where({ userId })
      .whereIn(
        'id',
        authMethods.map(method => method.id)
      )
      .update({
        userId: null,
        ...(hasFaucetClaim ? { receivedFaucet: true } : {})
      })
    if (orphanedMethods !== authMethods.length) {
      throw new Error('Authentication methods changed during account deletion.')
    }
  }

  if (payments.length > 0) {
    const orphanedPayments = await trx('payments')
      .where({ userId })
      .whereIn(
        'id',
        payments.map(payment => payment.id)
      )
      .update({ userId: null })
    if (orphanedPayments !== payments.length) {
      throw new Error('Faucet payments changed during account deletion.')
    }
  }
}

async function markFaucetClaimedMethods(
  trx: Knex.Transaction,
  userId: number,
  authMethods: AuthMethodEntity[]
): Promise<void> {
  const unmarkedIds = authMethods.filter(method => !method.receivedFaucet).map(method => method.id)
  if (unmarkedIds.length > 0) {
    const marked = await trx('auth_methods')
      .where({ userId })
      .whereIn('id', unmarkedIds)
      .andWhere(query => query.where({ receivedFaucet: false }).orWhereNull('receivedFaucet'))
      .update({ receivedFaucet: true })
    if (marked !== unmarkedIds.length) {
      throw new Error('Faucet authentication methods changed during reservation.')
    }
  }

  const confirmed = await trx<AuthMethodEntity>('auth_methods')
    .select('id', 'receivedFaucet')
    .where({ userId })
    .forUpdate()
  const expectedIds = new Set(authMethods.map(method => method.id))
  if (
    confirmed.length !== expectedIds.size ||
    confirmed.some(method => !expectedIds.has(method.id) || !method.receivedFaucet)
  ) {
    throw new Error('Faucet authentication methods changed during reservation.')
  }
}

export class AuthIdentityConflictError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'AuthIdentityConflictError'
  }
}

export class FaucetPaymentPendingError extends Error {
  public constructor(message = 'Faucet payment creation is pending reconciliation.') {
    super(message)
    this.name = 'FaucetPaymentPendingError'
  }
}

export class FaucetAlreadyClaimedError extends Error {
  public constructor(message = 'This authentication identity already received a faucet payment.') {
    super(message)
    this.name = 'FaucetAlreadyClaimedError'
  }
}

export class UserService {
  /**
   * Create a new user with a given presentationKey
   */
  static async createUser(
    presentationKey: string,
    registrationStatus: User['registrationStatus'] = 'active'
  ): Promise<User> {
    // Note: SQLite does not support RETURNING. Knex will return the inserted row id as a number in SQLite,
    // while in MySQL it may return an object when specifying returning columns.
    const insertResult: unknown = await db('users').insert({
      ...storedPresentationKeyColumns(presentationKey),
      registrationStatus
    })

    const insertedId = insertedIdFromResult(insertResult)
    if (insertedId === undefined) throw new Error('User creation failed')
    const user = await this.getUserById(insertedId)
    if (!user) {
      throw new Error('User creation failed')
    }
    return user
  }

  /**
   * Retrieve user by ID
   */
  static async getUserById(id: number): Promise<User | undefined> {
    return hydrateUserRow(await db<UserStorageRow>('users').where({ id }).first())
  }

  /**
   * Retrieve user by presentationKey
   */
  static async getUserByPresentationKey(key: string): Promise<User | undefined> {
    const query = db<UserStorageRow>('users').where({ presentationKey: key })
    if (presentationKeyVaultMode() !== 'legacy') {
      query.orWhere({ presentationKeyLookup: presentationKeyLookup(key) })
    }
    return hydrateUserRow(await query.first())
  }

  static async setUMPTokenOutpoint(userId: number, outpoint: string | null): Promise<void> {
    await db('users').where({ id: userId }).update({ umpTokenOutpoint: outpoint })
  }

  /**
   * Atomically finds the owner of an authentication identity or creates a
   * pending registration and links that identity. This prevents a database
   * failure or concurrent completion from leaving a user and auth method in
   * separate states.
   */
  static async findOrCreatePendingRegistration(
    presentationKey: string,
    methodType: string,
    config: string
  ): Promise<{ user: User; created: boolean }> {
    try {
      return await db.transaction(async trx => {
        const existingMethod = await trx<AuthMethodEntity>('auth_methods')
          .where({ methodType, config })
          .first()
        if (existingMethod?.userId != null) {
          const user = hydrateUserRow(
            await trx<UserStorageRow>('users').where({ id: existingMethod.userId }).first()
          )
          if (!user)
            throw new AuthIdentityConflictError('Authentication identity owner was not found.')
          return { user, created: false }
        }

        const insertResult: unknown = await trx('users').insert({
          ...storedPresentationKeyColumns(presentationKey),
          registrationStatus: 'pending'
        })
        const userId = insertedIdFromResult(insertResult)
        if (userId === undefined) throw new Error('User creation failed')

        if (existingMethod) {
          const claimed = await trx('auth_methods')
            .where({ id: existingMethod.id })
            .whereNull('userId')
            .update({ userId })
          if (claimed !== 1) {
            throw new AuthIdentityConflictError('Authentication method could not be linked safely.')
          }
        } else {
          await trx('auth_methods').insert({
            userId,
            methodType,
            config,
            receivedFaucet: false
          })
        }

        const user = hydrateUserRow(
          await trx<UserStorageRow>('users').where({ id: userId }).first()
        )
        if (!user) throw new Error('User creation failed')
        return { user, created: true }
      })
    } catch (error) {
      // A concurrent completion can win the unique auth identity race.
      // Re-read only after the losing transaction has rolled back.
      const user = await this.findUserByConfig(methodType, config)
      if (user) return { user, created: false }
      throw error
    }
  }

  /** Idempotently marks a pending registration as fully published. */
  static async finalizeRegistration(presentationKey: string): Promise<User | undefined> {
    const user = await this.getUserByPresentationKey(presentationKey)
    if (!user) return undefined
    if (user.registrationStatus !== 'pending' && user.registrationStatus !== 'active') {
      throw new Error('Stored registration status is invalid')
    }
    if (user.registrationStatus === 'pending') {
      await db('users')
        .where({ id: user.id, registrationStatus: 'pending' })
        .update({ registrationStatus: 'active' })
    }
    return await this.getUserById(user.id)
  }

  /** Support-only repair for a registration known to have no published UMP token. */
  static async reopenRegistration(userId: number): Promise<void> {
    await db('users').where({ id: userId }).update({ registrationStatus: 'pending' })
  }

  /** Delete a user while detaching durable faucet-abuse evidence. */
  static async deleteUserByPresentationKey(key: string): Promise<void> {
    await db.transaction(async trx => {
      const query = trx<UserStorageRow>('users').where({ presentationKey: key })
      if (presentationKeyVaultMode() !== 'legacy') {
        query.orWhere({ presentationKeyLookup: presentationKeyLookup(key) })
      }
      const user = await query.select('id').forUpdate().first()
      if (user == null) return

      await orphanUserFaucetRecords(trx, user.id)
      const deleted = await trx('users').where({ id: user.id }).del()
      if (deleted !== 1) throw new Error('User account changed before it could be deleted.')
    })
  }

  /**
   * Retrieve user by userIdHash (for Shamir flow)
   */
  static async getUserByUserIdHash(userIdHash: string): Promise<User | undefined> {
    return hydrateUserRow(await db<UserStorageRow>('users').where({ userIdHash }).first())
  }

  /**
   * Create a new user with userIdHash (for Shamir flow)
   * Uses a placeholder presentationKey since legacy field is NOT NULL
   */
  /** Delete a Shamir user while detaching durable faucet-abuse evidence. */
  static async deleteUserByUserIdHash(userIdHash: string): Promise<void> {
    await db.transaction(async trx => {
      const user = await trx<UserStorageRow>('users')
        .select('id')
        .where({ userIdHash })
        .forUpdate()
        .first()
      if (user == null) return

      await orphanUserFaucetRecords(trx, user.id)
      const deleted = await trx('users').where({ id: user.id }).del()
      if (deleted !== 1) throw new Error('User account changed before it could be deleted.')
    })
  }

  static async createUserWithUserIdHash(userIdHash: string): Promise<User> {
    // Generate a unique placeholder for the legacy presentationKey field
    const placeholderKey = `shamir_${userIdHash.substring(0, 48)}`

    const insertResult: unknown = await db('users').insert({
      presentationKey: placeholderKey,
      userIdHash
    })

    const insertedId = insertedIdFromResult(insertResult)
    if (insertedId === undefined) throw new Error('User creation failed')
    const user = await this.getUserById(insertedId)
    if (!user) {
      throw new Error('User creation failed')
    }
    return user
  }

  /**
   * Attach a Shamir identity hash to an existing legacy user exactly once.
   * A user or hash that is already bound elsewhere fails closed.
   */
  static async attachUserIdHash(userId: number, userIdHash: string): Promise<User> {
    const current = await this.getUserById(userId)
    if (!current) {
      throw new AuthIdentityConflictError('Authenticated user no longer exists.')
    }
    if (current.userIdHash === userIdHash) {
      return current
    }
    if (current.userIdHash) {
      throw new AuthIdentityConflictError(
        'Authenticated identity is already bound to another Shamir account.'
      )
    }

    try {
      const updated = await db('users')
        .where({ id: userId })
        .whereNull('userIdHash')
        .update({ userIdHash })
      if (updated !== 1) {
        throw new AuthIdentityConflictError('Authenticated identity could not be bound safely.')
      }
    } catch (error) {
      if (error instanceof AuthIdentityConflictError) throw error
      throw new AuthIdentityConflictError('Shamir identity hash is already bound to another user.')
    }

    const user = await this.getUserById(userId)
    if (user?.userIdHash !== userIdHash) {
      throw new AuthIdentityConflictError('Authenticated identity could not be bound safely.')
    }
    return user
  }

  /**
   * Link an AuthMethod to the user
   * Checks if this auth method (methodType + config) already exists.
   * If it belongs to a deleted account (`userId` is null), reuse it without
   * clearing its faucet history. Never move an identity between live users.
   */
  static async linkAuthMethod(
    userId: number,
    methodType: string,
    config: string
  ): Promise<AuthMethodEntity> {
    return await db.transaction(async trx => {
      const user = await trx<UserStorageRow>('users')
        .select('id')
        .where({ id: userId })
        .forUpdate()
        .first()
      if (user == null) {
        throw new AuthIdentityConflictError('Authenticated user no longer exists.')
      }

      const inheritsFaucetClaim = await userHasFaucetClaim(trx, userId)
      const existing = await trx<AuthMethodEntity>('auth_methods')
        .where({ methodType, config })
        .forUpdate()
        .first()

      if (existing) {
        if (existing.userId !== null && existing.userId !== userId) {
          throw new AuthIdentityConflictError(
            'Authentication method is already linked to another user.'
          )
        }

        const receivedFaucet = Boolean(existing.receivedFaucet) || inheritsFaucetClaim
        if (existing.userId !== userId || Boolean(existing.receivedFaucet) !== receivedFaucet) {
          const updated = await trx('auth_methods')
            .where({ id: existing.id })
            .modify(query => {
              if (existing.userId === null) query.whereNull('userId')
              else query.where({ userId })
            })
            .update({ userId, receivedFaucet })
          if (updated !== 1) {
            throw new AuthIdentityConflictError('Authentication method could not be linked safely.')
          }
        }

        const linked = await trx<AuthMethodEntity>('auth_methods')
          .where({ id: existing.id, userId })
          .first()
        if (linked == null) {
          throw new AuthIdentityConflictError('Authentication method could not be linked safely.')
        }
        return linked
      }

      const insertResult: unknown = await trx('auth_methods').insert(
        {
          userId,
          methodType,
          config,
          receivedFaucet: inheritsFaucetClaim
        },
        ['id']
      )
      const authMethodId = insertedIdFromResult(insertResult)
      if (authMethodId === undefined) {
        throw new Error('Failed to determine new auth method ID')
      }
      const authMethod = await trx<AuthMethodEntity>('auth_methods')
        .where({ id: authMethodId })
        .first()

      if (!authMethod) {
        throw new Error('Failed to create auth method record')
      }
      return authMethod
    })
  }

  /**
   * Find user by auth method config (email, phone, etc.)
   * Returns undefined if auth method doesn't exist or has no linked user
   */
  static async findUserByConfig(methodType: string, config: string): Promise<User | undefined> {
    const authMethod = await db<AuthMethodEntity>('auth_methods')
      .where({
        methodType,
        config
      })
      .first()

    if (!authMethod?.userId) {
      return undefined
    }
    return await this.getUserById(authMethod.userId)
  }

  /**
   * Check if an auth method exists for user with the same config (to see if already linked).
   */
  static async getAuthMethodsByUserId(userId: number): Promise<AuthMethodEntity[]> {
    return db<AuthMethodEntity>('auth_methods').where({ userId })
  }

  static async getAuthMethodById(id: number): Promise<AuthMethodEntity | undefined> {
    return db<AuthMethodEntity>('auth_methods').where({ id }).first()
  }

  static async deleteAuthMethodById(id: number, userId: number): Promise<boolean> {
    return await db.transaction(async trx => {
      const user = await trx<UserStorageRow>('users')
        .select('id')
        .where({ id: userId })
        .forUpdate()
        .first()
      if (user == null) return false

      const method = await trx<AuthMethodEntity>('auth_methods')
        .where({ id, userId })
        .forUpdate()
        .first()
      if (method == null) return false
      const receivedFaucet =
        Boolean(method.receivedFaucet) || (await userHasFaucetClaim(trx, userId))
      const unlinked = await trx('auth_methods')
        .where({ id, userId })
        .update({ userId: null, receivedFaucet })
      return unlinked === 1
    })
  }

  /**
   * Mark all auth methods for a user as having received the faucet.
   * This prevents re-claiming even if the user deletes and re-signs up.
   */
  static async markFaucetReceived(userId: number): Promise<void> {
    await db('auth_methods').where({ userId }).update({ receivedFaucet: true })
  }

  /**
   * Retrieve or create a faucet payment for a user.
   */
  static async getOrCreateFaucetPayment(
    userId: number,
    faucetAmount: number,
    allowCreate = true
  ): Promise<PaymentEntity> {
    if (!Number.isSafeInteger(faucetAmount) || faucetAmount <= 0 || faucetAmount > 21e14) {
      throw new Error('Faucet amount must be a positive safe satoshi amount.')
    }
    const reservation = await db.transaction(async trx => {
      const user = await trx('users').select('id').where({ id: userId }).forUpdate().first()
      if (!user) throw new Error('Faucet user not found.')

      const authMethods = await trx<AuthMethodEntity>('auth_methods').where({ userId }).forUpdate()
      if (authMethods.length === 0) throw new FaucetAlreadyClaimedError()

      const payment = await trx<PaymentEntity>('payments').where({ userId }).first()
      if (payment != null) {
        await markFaucetClaimedMethods(trx, userId, authMethods)
        if (payment.status === 'ready') return { payment }
        // Return a sentinel so the marker repair commits before the pending
        // response is raised outside the transaction.
        return { pending: true as const }
      }

      if (!allowCreate || authMethods.some(method => Boolean(method.receivedFaucet))) {
        throw new FaucetAlreadyClaimedError()
      }

      // Validate all wallet authority before creating an irreversible
      // reservation. A ready retry does not depend on current wallet config.
      const walletConfig = readFaucetWalletConfig()
      // Reserve the one-time recovery secret in the same transaction that wins
      // the funding right. It must exist before any irreversible wallet call.
      const k = Random(32)
      const rPuzzle = new RPuzzle('raw')
      const c = new Curve()
      let r = c.g.mul(k).x?.umod(c.n)?.toArray()
      if (r !== null && r !== undefined) r = r[0] > 127 ? [0, ...r] : r
      if (r == null) throw new FaucetPaymentPendingError()
      const lockingScript = rPuzzle.lock(r)
      const recoverySecret = Utils.toHex(k)
      const insertResult: unknown = await trx('payments').insert({
        userId,
        amount: faucetAmount,
        outputIndex: 0,
        k: recoverySecret,
        status: 'creating'
      })
      const paymentId = insertedIdFromResult(insertResult)
      if (paymentId === undefined) throw new Error('Failed to reserve faucet payment.')

      await markFaucetClaimedMethods(trx, userId, authMethods)
      return { paymentId, walletConfig, lockingScript }
    })

    if ('payment' in reservation && reservation.payment != null) return reservation.payment
    if ('pending' in reservation) throw new FaucetPaymentPendingError()
    if (!('paymentId' in reservation) || reservation.walletConfig == null) {
      throw new FaucetPaymentPendingError()
    }
    const { walletConfig, lockingScript } = reservation

    // Persist the reservation before wallet/network work. Any crash or
    // ambiguous wallet failure leaves one visible creating row and must not
    // trigger a second irreversible faucet payment automatically.
    try {
      const wallet = await Setup.createWalletClientNoEnv({
        chain: walletConfig.chain,
        rootKeyHex: walletConfig.rootKeyHex,
        storageUrl: walletConfig.storageUrl
      })
      const result = await wallet.createAction({
        description: 'Here is your funds!',
        outputs: [
          {
            lockingScript: lockingScript.toHex(),
            satoshis: faucetAmount,
            outputDescription: 'Faucet payment'
          }
        ],
        options: {
          randomizeOutputs: false,
          acceptDelayedBroadcast: false
        }
      })
      const resultTxid = ownDataProperty(result, 'txid')
      const resultTx = copyDenseBytes(
        ownDataProperty(result, 'tx'),
        'Faucet wallet Atomic BEEF',
        MAX_FAUCET_ATOMIC_BEEF_BYTES
      )
      if (typeof resultTxid !== 'string' || !/^[0-9a-f]{64}$/i.test(resultTxid)) {
        throw new Error('Faucet wallet returned incomplete transaction evidence.')
      }
      const canonicalTxid = resultTxid.toLowerCase()
      const transaction = Transaction.fromAtomicBEEF(resultTx)
      const output = transaction.outputs[0]
      if (
        transaction.id('hex') !== canonicalTxid ||
        output == null ||
        output.satoshis !== faucetAmount ||
        output.lockingScript.toHex() !== lockingScript.toHex()
      ) {
        throw new Error('Faucet wallet substituted the authorized payment transaction.')
      }

      const updated = await db('payments')
        .where({ id: reservation.paymentId, status: 'creating' })
        .update({
          beef: Buffer.from(resultTx),
          txid: canonicalTxid,
          status: 'ready'
        })
      if (updated !== 1) throw new Error('Faucet payment reservation changed unexpectedly.')
      log.info(
        { operation: 'service.user.faucet_funding', txid: canonicalTxid },
        'Funding txid created'
      )
    } catch (error) {
      log.error(
        { operation: 'service.user.faucet_funding', err: error, outcome: 'ambiguous' },
        'Faucet payment requires reconciliation'
      )
      throw new FaucetPaymentPendingError()
    }

    const payment = await db<PaymentEntity>('payments')
      .where({ id: reservation.paymentId, status: 'ready' })
      .first()
    if (!payment) throw new FaucetPaymentPendingError()
    return payment
  }
}
