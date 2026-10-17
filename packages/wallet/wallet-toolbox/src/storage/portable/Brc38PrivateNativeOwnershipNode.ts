import createKnex, { type Knex } from 'knex'
import { type FileHandle } from 'node:fs/promises'
import { requirePrivatePath } from './Brc38PrivateFilesystemNode'
import { join } from 'node:path'
import { Brc38NativeRecoveryScratchNode } from './Brc38NativeRecoveryScratchNode'
import { Brc39RecoveryAuthenticationNode } from './Brc39RecoveryAuthenticationNode'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'
import type { Brc38StagingBoundMetadata } from './Brc38StagingBinding'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { assertBrc38ProfileFileDescriptor, type Brc38ProfileFileIdentity } from './Brc38ProfilePhysicalIdentityNode'

interface Session {
  readonly identity?: object
}
interface Driver {
  NativeProfileSqlite: {
    startPrivateStageForClaim(
      executable: string,
      directory: string,
      fixedJson: string,
      binding: string
    ): Promise<Readonly<{ session: Session; failure?: unknown }>>
    startRecoveryStageForClaim(
      executable: string,
      directory: string,
      fixedJson: string,
      binding: string
    ): Promise<Readonly<{ session: Session; failure?: unknown }>>
  }
  privateStageSessionIdentity(session: Session): Readonly<{ token: object }> | undefined
  nativeKnex(knex: typeof createKnex, client: unknown, session: Session, slot: number): Knex
  nativeDatabaseIdentity(database: Knex): Readonly<{ token: object; slot: number }> | undefined
  nativeTransactionIdentity(trx: Knex.Transaction): Readonly<{ token: object; slot: number }> | undefined
  reopenPrivateComparisonDatabase(session: Session, previous: Knex): Promise<Knex>
  admitDeleteOwned(session: Session): Promise<unknown>
  beginPrivateComparisonOwned(session: Session): Promise<void>
  requirePrivateComparisonOwned(session: Session): Promise<void>
  drainStartedNativeSession(session: Session): Promise<
    Readonly<{
      terminal: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
      failed: boolean
      failure?: unknown
    }>
  >
}
let transport: Driver | undefined
function driver(): Driver {
  return (transport ??= require('./NativeProfileSqlite.cjs') as Driver)
}
/** Physical actor identity only, checked freshly through actual native leases. */
export function privateNativeWriterToken(trx: Knex.Transaction): object | undefined {
  const actual = transport?.nativeTransactionIdentity(trx)
  return actual?.slot === 0 ? actual.token : undefined
}
export function privateNativeTransactionIdentity(
  trx: Knex.Transaction
): Readonly<{ token: object; slot: number }> | undefined {
  const actual = transport?.nativeTransactionIdentity(trx)
  return actual !== undefined && [0, 3].includes(actual.slot) ? actual : undefined
}
/** Actual factory-created root identity only. Copied clients/configs cannot
 * supply this transport-owned membership, nor renew its parent's lifetime. */
export function privateNativeDatabaseIdentity(database: Knex): Readonly<{ token: object; slot: number }> | undefined {
  const actual = transport?.nativeDatabaseIdentity(database)
  return actual !== undefined && [0, 3].includes(actual.slot) ? actual : undefined
}
/** Internal actual kernel owner for a closed authenticated private stage.
 * It keeps the original reservation/binding/deadline and owns no public route,
 * profile publication, capability or activation. Live source and receiver
 * checks remain the store/caller's job for each native transaction. */
export class Brc38PrivateNativeOwnershipNode {
  #released = false
  #releasing = false
  #retired = false
  readonly #deadline: number
  readonly #session: Session
  readonly #recoveryCheck?: () => void
  readonly #physical: Readonly<{
    directory: Brc38ProfileFileIdentity
    stage: Brc38ProfileFileIdentity
    owner: Brc38ProfileFileIdentity
  }>
  private constructor(
    readonly directory: string,
    readonly expiresAt: number,
    session: Session,
    monotonicDeadline: number,
    physical: Readonly<{
      directory: Brc38ProfileFileIdentity
      stage: Brc38ProfileFileIdentity
      owner: Brc38ProfileFileIdentity
    }>,
    recoveryCheck?: () => void
  ) {
    this.#session = session
    this.#recoveryCheck = recoveryCheck
    this.#deadline = monotonicDeadline
    this.#physical = Object.freeze({
      directory: Object.freeze({ ...physical.directory }),
      stage: Object.freeze({ ...physical.stage }),
      owner: Object.freeze({ ...physical.owner })
    })
    Object.defineProperties(this, {
      directory: { value: directory, enumerable: true, writable: false, configurable: false },
      expiresAt: { value: expiresAt, enumerable: true, writable: false, configurable: false }
    })
  }
  static async claimExisting(
    directory: string,
    limits: KnexBrc38StagingLimits,
    bound: Brc38StagingBoundMetadata,
    executable: string
  ): Promise<
    Readonly<{
      owner: Brc38PrivateNativeOwnershipNode
      database: Knex
    }>
  > {
    return await this.#claim(directory, limits, bound, executable)
  }
  /** Own only the NEW genuine copied scratch, under both original copy and
   * fresh full-envelope authentication scopes. No expired reservation is
   * reopened. The kernel is permanently in comparison phase at spawn. */
  static async claimRecovery(
    scratch: Brc38NativeRecoveryScratchNode,
    source: Brc39RecoveryAuthenticationNode,
    limits: KnexBrc38StagingLimits,
    bound: Brc38StagingBoundMetadata,
    executable: string
  ): Promise<
    Readonly<{
      owner: Brc38PrivateNativeOwnershipNode
      database: Knex
    }>
  > {
    Brc38NativeRecoveryScratchNode.prototype.assertRetained.call(scratch)
    Brc39RecoveryAuthenticationNode.prototype.assertRetained.call(source)
    if (
      source.original.digest !== bound.digest ||
      source.original.limitsJson !== bound.limitsJson ||
      source.original.bindingJson !== bound.bindingJson ||
      limits.expiresAt > Date.now() ||
      limits.maximumPhysicalBytes !== scratch.policy.maximumPhysicalBytes ||
      scratch.policy.workingAllocation.maximum > limits.maximumRowAllocationBytes
    )
      throw new Error('Recovery comparison scopes differ from original immutable allowances')
    await Brc38NativeRecoveryScratchNode.prototype.assertPhysical.call(scratch)
    const check = (): void => {
        Brc38NativeRecoveryScratchNode.prototype.assertRetained.call(scratch)
        Brc39RecoveryAuthenticationNode.prototype.assertRetained.call(source)
      },
      expiresAt = Math.min(scratch.policy.expiresAt, source.expiresAt),
      deadline = Math.min(scratch.monotonicDeadline, source.deadline)
    return await this.#claim(
      scratch.directory,
      limits,
      bound,
      executable,
      Object.freeze({ expiresAt, deadline, check })
    )
  }
  static async #claim(
    directory: string,
    limits: KnexBrc38StagingLimits,
    bound: Brc38StagingBoundMetadata,
    executable: string,
    recovery?: Readonly<{ expiresAt: number; deadline: number; check(): void }>
  ): Promise<
    Readonly<{
      owner: Brc38PrivateNativeOwnershipNode
      database: Knex
    }>
  > {
    recovery?.check()
    // This is a descriptor vector identifying DATA, not a portable admission.
    const expiresAt = recovery?.expiresAt ?? limits.expiresAt,
      monotonicDeadline = Math.min(
        performance.now() + Math.max(0, expiresAt - Date.now()),
        recovery?.deadline ?? Infinity
      ),
      entries = [
        await requirePrivatePath(directory, true),
        ...(await Promise.all(
          ['stage.sqlite', 'brc38-owner.sqlite'].map(name => requirePrivatePath(join(directory, name), false))
        ))
      ],
      identity = entries.map(value => ({ device: value.dev.toString(), inode: value.ino.toString() })),
      fixedJson = JSON.stringify({
        protocol: recovery === undefined ? 'brc38-private-native-session/v1' : 'brc38-recovery-native-session/v1',
        bindingSha256: bound.digest,
        bindingJson: bound.bindingJson,
        limitsJson: bound.limitsJson,
        archiveSha256: bound.binding.archiveSha256,
        limits: {
          maximumRowAllocationBytes: limits.maximumRowAllocationBytes,
          maximumPhysicalBytes: limits.maximumPhysicalBytes,
          expiresAt: limits.expiresAt
        },
        ...(recovery === undefined ? {} : { recovery: { expiresAt, monotonicDeadline } }),
        physicalIdentity: { directory: identity[0], stage: identity[1], owner: identity[2] }
      }),
      actual = driver(),
      attempt = await (recovery === undefined
        ? actual.NativeProfileSqlite.startPrivateStageForClaim(executable, directory, fixedJson, bound.digest)
        : actual.NativeProfileSqlite.startRecoveryStageForClaim(executable, directory, fixedJson, bound.digest)),
      owner = new Brc38PrivateNativeOwnershipNode(
        directory,
        expiresAt,
        attempt.session,
        monotonicDeadline,
        { directory: identity[0], stage: identity[1], owner: identity[2] },
        recovery?.check
      )
    let database: Knex | undefined,
      destroyed = false
    const cleanup = async (): Promise<void> => {
      if (database !== undefined && !destroyed) {
        await database.destroy()
        destroyed = true
      }
      await owner.release()
    }
    try {
      if (Object.hasOwn(attempt, 'failure')) throw attempt.failure
      owner.assertLive()
      // The C framing check does not replace the store's complete current
      // binding/seal/field validation after this actual claim.
      await actual.admitDeleteOwned(attempt.session)
      const client: unknown = require('knex/lib/dialects/sqlite3/index.js')
      database = actual.nativeKnex(createKnex, client, attempt.session, 0)
      owner.assertLive()
      if (recovery !== undefined) await owner.requireComparison(database)
      return Object.freeze({ owner, database })
    } catch (cause) {
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError([cause, error_], 'Private native claim retains physical cleanup', cleanup)
      }
      throw cause
    }
  }
  /** Returned token is actual transport identity only. It must be enrolled by
   * the actual reopened store and checked under that store's current scope. */
  get transactionToken(): object {
    this.assertLive()
    return driver().privateStageSessionIdentity(this.#session)!.token
  }
  get recoveryComparisonOnly(): boolean {
    this.assertLive()
    return this.#recoveryCheck !== undefined
  }
  /** Original clock exhaustion only, for post-expiry resource cleanup. This
   * does not establish liveness, grant SQL access or renew either deadline. */
  get operationExpired(): boolean {
    return Date.now() >= this.expiresAt || performance.now() >= this.#deadline
  }
  assertLive(): void {
    this.#recoveryCheck?.()
    if (
      this.#retired ||
      this.#released ||
      Date.now() >= this.expiresAt ||
      performance.now() >= this.#deadline ||
      driver().privateStageSessionIdentity(this.#session) === undefined
    )
      throw new Error('Private native stage owner is unavailable or expired')
  }
  /** New actual read-only physical lease; no copied client config establishes it. */
  createReadDatabase(): Knex {
    this.assertLive()
    const client: unknown = require('knex/lib/dialects/sqlite3/index.js')
    return driver().nativeKnex(createKnex, client, this.#session, 3)
  }
  /** The original private process remains alive across descriptor copy. Its
   * frozen phase and physically drained original Root0 are checked by the
   * transport before another facade is issued. Expiry is never renewed. */
  async reopenComparedDatabase(previous: Knex): Promise<Knex> {
    this.assertLive()
    const database = await driver().reopenPrivateComparisonDatabase(this.#session, previous)
    try {
      this.assertDatabase(database)
      await this.requireComparison(database)
      return database
    } catch (cause) {
      try {
        await database.destroy()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Original comparison owner retains reopened SQL cleanup',
          async () => await database.destroy()
        )
      }
      throw cause
    }
  }
  assertDatabase(database: Knex, allowReadOnly = false): void {
    this.assertLive()
    const identity = driver().nativeDatabaseIdentity(database)
    if (
      identity === undefined ||
      (identity.slot !== 0 && !(allowReadOnly && identity.slot === 3)) ||
      identity.token !== this.transactionToken
    )
      throw new Error('Private native stage requires its actual current database lease')
  }
  assertTransaction(trx: Knex.Transaction, allowReadOnly = false): void {
    this.assertLive()
    const identity = driver().nativeTransactionIdentity(trx)
    if (
      identity === undefined ||
      (identity.slot !== 0 && !(allowReadOnly && identity.slot === 3)) ||
      identity.token !== this.transactionToken
    )
      throw new Error('Private native stage requires its actual current wallet writer')
  }
  /** Permanently close semantic mutation admission in THIS actual kernel.
   * Comparison scratch writes retain their original schema/quota guards. No
   * inventory result or digest enters here, and this does not publish a copy. */
  async beginComparison(database: Knex): Promise<void> {
    this.assertDatabase(database)
    await driver().beginPrivateComparisonOwned(this.#session)
    this.assertDatabase(database)
  }
  async requireComparison(database: Knex): Promise<void> {
    this.assertDatabase(database)
    await driver().requirePrivateComparisonOwned(this.#session)
    this.assertDatabase(database)
  }
  /** The actual source descriptor must still be the main file enrolled at
   * original kernel claim, even after all SQL facades close. These physical
   * identities are DATA; the genuine live owner is also checked each time. */
  async assertCopySource(file: FileHandle): Promise<void> {
    this.assertLive()
    await assertBrc38ProfileFileDescriptor(file, this.#physical.stage)
    const [directory, owner, stage] = await Promise.all([
      requirePrivatePath(this.directory, true),
      requirePrivatePath(join(this.directory, 'brc38-owner.sqlite'), false),
      requirePrivatePath(join(this.directory, 'stage.sqlite'), false)
    ])
    if (
      directory.dev.toString() !== this.#physical.directory.device ||
      directory.ino.toString() !== this.#physical.directory.inode ||
      owner.dev.toString() !== this.#physical.owner.device ||
      owner.ino.toString() !== this.#physical.owner.inode ||
      stage.dev.toString() !== this.#physical.stage.device ||
      stage.ino.toString() !== this.#physical.stage.inode
    )
      throw new Error('Private copy original kernel directory, source or owner identity differs')
    this.assertLive()
  }
  /** Caller must destroy its actual SQL facade first. The transport refuses
   * drain while any real native facade lease remains owned. */
  async release(): Promise<void> {
    if (this.#released) return
    if (this.#releasing) throw new Error('Private native stage cleanup is already owned')
    this.#retired = true
    this.#releasing = true
    try {
      const result = await driver().drainStartedNativeSession(this.#session)
      // A real terminal event and executable descriptor close have settled;
      // report a native cleanup failure instead of turning it into success.
      this.#released = true
      if (result.failed) throw result.failure
    } finally {
      this.#releasing = false
    }
  }
}
