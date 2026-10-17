import type { BigIntStats } from 'node:fs'
import {
  requirePrivatePath,
  requirePrivateDescriptor,
  createPrivateFile,
  closePrivateDescriptor
} from './Brc38PrivateFilesystemNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import createKnex, { type Knex } from 'knex'
import { lstat, opendir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Brc38StagingOwnershipNode } from './Brc38StagingOwnershipNode'
import { brc38StagingBinding, type Brc38StagingBinding } from './Brc38StagingBinding'
import { KnexBrc38StagingStore, validateBrc38StagingLimits, type KnexBrc38StagingLimits } from './KnexBrc38StagingStore'
import { runInSeries } from '../../utility/runInSeries'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

const catalogName = 'brc38-admission.sqlite'
const catalogMaximum = 1048576
const catalogReservation = 3 * catalogMaximum
const protocol = 'brc38-private-admission/v1'
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface Brc38StagingCapacity {
  readonly maximumImports: number
  /** Includes conservative catalog/journal space and every import reservation. */
  readonly maximumPhysicalBytes: number
  readonly maximumLogicalBytes: number
}
export interface Brc38StagingReservation {
  readonly id: string
  readonly store: KnexBrc38StagingStore
}
interface CatalogConnection {
  readonly inTransaction: boolean
  exec(sql: string): unknown
  __knexTxId?: string
}
interface Reservation {
  id: string
  digest: string
  expiresAt: number
  maximumPhysicalBytes: number
  maximumLogicalBytes: number
  state: 'reserved' | 'ready'
}
export interface Brc38StagingUsage {
  imports: number
  physicalBytes: number
  logicalBytes: number
}
function boundedInteger(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid shared private staging capacity')
}
function capacity(value: Brc38StagingCapacity): Readonly<Brc38StagingCapacity> {
  boundedInteger(value.maximumImports, 1, 128)
  boundedInteger(value.maximumPhysicalBytes, catalogReservation + 1048576, Number.MAX_SAFE_INTEGER)
  boundedInteger(value.maximumLogicalBytes, 1, Number.MAX_SAFE_INTEGER)
  return Object.freeze({ ...value })
}
function policy(value: Brc38StagingCapacity): string {
  return JSON.stringify([value.maximumImports, value.maximumPhysicalBytes, value.maximumLogicalBytes])
}
function nativeCode(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code
}
async function optionalStat(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true })
  } catch (cause) {
    if (nativeCode(cause, 'ENOENT')) return undefined
    throw cause
  }
}
function database(directory: string): Knex {
  return createKnex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, catalogName) },
    useNullAsDefault: true,
    acquireConnectionTimeout: 1000,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (
        connection: { exec: (sql: string) => unknown },
        done: (error: Error | null, value?: unknown) => void
      ) => {
        try {
          connection.exec(
            'PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA busy_timeout=0; PRAGMA max_page_count=256;'
          )
          done(null, connection)
        } catch (cause) {
          done(cause instanceof Error ? cause : new Error('Private staging catalog setup failed'), connection)
        }
      }
    }
  })
}
async function visitEntries<R>(directory: string, work: (name: string) => Promise<R>): Promise<R | undefined> {
  const entries = await opendir(directory)
  async function* results() {
    for await (const entry of entries) yield work(entry.name)
  }
  let last: R | undefined
  for await (last of results()) {
    /* Pull lazily after each native operation settles. */
  }
  return last
}
function physicalBytes(value: BigIntStats): number {
  const allocated = value.blocks * 512n,
    bytes = value.size > allocated ? value.size : allocated
  if (value.size < 0n || value.blocks < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER))
    throw new SnapshotResourceLimitError('Private staging physical extent is invalid')
  return Number(bytes)
}
async function privateRoot(directory: string): Promise<{ dev: bigint; ino: bigint }> {
  const root = await requirePrivatePath(directory, true)
  return { dev: root.dev, ino: root.ino }
}
async function verifyCatalogPages(trx: Knex.Transaction): Promise<void> {
  const sizes = (await trx.raw('PRAGMA page_size')) as Array<{
      page_size: number
    }>,
    bounds = (await trx.raw('PRAGMA max_page_count')) as Array<{
      max_page_count: number
    }>
  if (sizes.at(0)?.page_size !== 4096 || bounds.at(0)?.max_page_count !== 256)
    throw new Error('Private staging catalog page bound was not established')
}

async function closeFailedStore(store: KnexBrc38StagingStore | undefined, cause: unknown): Promise<never> {
  if (store !== undefined) {
    try {
      await store.close()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Private staging admission and physical close failed',
        async () => await store.close()
      )
    }
  }
  throw cause
}
/** Node-only prospective integration. Reservations are durable before creating
 * a stage. A catalog writer excludes competing admission, creation and cleanup;
 * the independent stage owner excludes a live importer across its commits.
 * Expiry never releases a charge by itself. There is no active-wallet write. */
export class Brc38StagingAdmissionNode {
  #busy = false
  #closed = false
  #pendingCatalogCleanup: Brc38StagingCleanupError | undefined
  readonly #pendingDisposals = new Map<string, { readonly store: KnexBrc38StagingStore; readonly digest: string }>()
  private constructor(
    readonly knex: Knex,
    readonly directory: string,
    readonly limits: Readonly<Brc38StagingCapacity>,
    private readonly identity: { dev: bigint; ino: bigint },
    private readonly catalogIdentity: { dev: bigint; ino: bigint }
  ) {}
  static async create(directory: string, selected: Brc38StagingCapacity): Promise<Brc38StagingAdmissionNode> {
    const limits = capacity(selected),
      identity = await privateRoot(directory)
    await visitEntries(directory, async () => {
      throw new Error('Private staging root must initially be empty')
    })
    const file = await createPrivateFile(join(directory, catalogName))
    let catalogIdentity: BigIntStats
    try {
      catalogIdentity = await requirePrivateDescriptor(file)
    } finally {
      await closePrivateDescriptor(file)
    }
    const db = database(directory)
    try {
      await db.transaction(async trx => {
        await trx.schema.createTable('capacity', table => {
          table.integer('slot').primary()
          table.string('protocol', 32).notNullable()
          table.string('policy', 128).notNullable()
        })
        await trx.schema.createTable('reservations', table => {
          table.string('id', 36).primary()
          table.string('digest', 64).notNullable()
          table.bigInteger('expiresAt').notNullable()
          table.bigInteger('maximumPhysicalBytes').notNullable()
          table.bigInteger('maximumLogicalBytes').notNullable()
          table.string('state', 16).notNullable()
          table.index(['expiresAt', 'id'])
        })
        await trx('capacity').insert({
          slot: 1,
          protocol,
          policy: policy(limits)
        })
      })
      const root = new Brc38StagingAdmissionNode(db, directory, limits, identity, catalogIdentity)
      await root.usage()
      return root
    } catch (cause) {
      try {
        await db.destroy()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private staging catalog initialization and close failed',
          async () => await db.destroy()
        )
      }
      // Retain incomplete catalog for explicit operator recovery; never replace
      // an existing root or infer that an initialization failure erased it.
      throw cause
    }
  }
  static async reopen(directory: string, selected: Brc38StagingCapacity): Promise<Brc38StagingAdmissionNode> {
    const limits = capacity(selected),
      identity = await privateRoot(directory)
    const file = await requirePrivatePath(join(directory, catalogName), false)
    if (file.size > BigInt(catalogMaximum)) throw new Error('Invalid private staging catalog file')
    const db = database(directory)
    try {
      const root = new Brc38StagingAdmissionNode(db, directory, limits, identity, file)
      await root.usage()
      return root
    } catch (cause) {
      try {
        await db.destroy()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private staging catalog reopen and close failed',
          async () => await db.destroy()
        )
      }
      throw cause
    }
  }
  async #exclusive<T>(work: (trx: Knex.Transaction) => Promise<T>, removal = false): Promise<T> {
    if (this.#closed || this.#busy) throw new Error('Private staging catalog is unavailable or already owned')
    this.#busy = true
    try {
      await this.#pendingCatalogCleanup?.retryCleanup()
      const connection: CatalogConnection = await this.knex.client.acquireConnection()
      let retained = false
      try {
        return await this.knex.transaction(
          async trx => {
            // Acquire the real SQLite writer before any read or filesystem action.
            await trx('capacity').where({ slot: 1 }).update({ slot: 1 })
            await this.#verify(trx, removal)
            return await work(trx)
          },
          { connection }
        )
      } catch (cause) {
        try {
          // A rejected native COMMIT can leave the transaction active. Keep the
          // exact connection checked out until rollback physically settles.
          if (connection.inTransaction) connection.exec('ROLLBACK')
        } catch (error_) {
          retained = true
          const failure = new Brc38StagingCleanupError(
            [cause, error_],
            'Private staging catalog transaction and rollback failed',
            async () => {
              if (connection.inTransaction) connection.exec('ROLLBACK')
              delete connection.__knexTxId
              await this.knex.client.releaseConnection(connection)
              this.#pendingCatalogCleanup = undefined
            }
          )
          this.#pendingCatalogCleanup = failure
          throw failure
        }
        throw cause
      } finally {
        if (!retained) {
          delete connection.__knexTxId
          await this.knex.client.releaseConnection(connection)
        }
      }
    } finally {
      this.#busy = false
    }
  }
  async #verify(trx: Knex.Transaction, removal: boolean): Promise<void> {
    await verifyCatalogPages(trx)
    const identity = await privateRoot(this.directory)
    if (identity.dev !== this.identity.dev || identity.ino !== this.identity.ino)
      throw new Error('Private staging root was replaced')
    const catalog = await requirePrivatePath(join(this.directory, catalogName), false)
    if (catalog.dev !== this.catalogIdentity.dev || catalog.ino !== this.catalogIdentity.ino)
      throw new Error('Private staging catalog file was replaced')
    const extents = (await trx.raw(
      'SELECT length(CAST(protocol AS BLOB)) AS protocolBytes, length(CAST(policy AS BLOB)) AS policyBytes FROM capacity WHERE slot = 1 LIMIT 1'
    )) as Array<{ protocolBytes: number; policyBytes: number }>
    const extent = extents.at(0)
    if (extent?.protocolBytes !== protocol.length || extent.policyBytes !== Buffer.byteLength(policy(this.limits)))
      throw new Error('Private staging catalog metadata extent is invalid')
    const row = await trx<{ slot: number; protocol: string; policy: string }>('capacity')
      .where({ slot: 1 })
      .first('protocol', 'policy')
    if (row?.protocol !== protocol || row.policy !== policy(this.limits))
      throw new Error('Private staging catalog capacity is immutable')
    const invalid = (await trx.raw(
      "SELECT count(*) AS bad FROM reservations WHERE length(CAST(id AS BLOB)) != 36 OR length(CAST(digest AS BLOB)) != 64 OR typeof(expiresAt) != 'integer' OR expiresAt < 1 OR typeof(maximumPhysicalBytes) != 'integer' OR maximumPhysicalBytes < 1048576 OR maximumPhysicalBytes > ? OR typeof(maximumLogicalBytes) != 'integer' OR maximumLogicalBytes < 1 OR maximumLogicalBytes > ? OR state NOT IN ('reserved','ready')",
      [this.limits.maximumPhysicalBytes, this.limits.maximumLogicalBytes]
    )) as Array<{ bad: number }>
    if (invalid.at(0)?.bad !== 0) throw new Error('Private staging reservations are invalid')
    const usage = await this.#usage(trx)
    if (
      usage.imports > this.limits.maximumImports ||
      usage.physicalBytes > this.limits.maximumPhysicalBytes ||
      usage.logicalBytes > this.limits.maximumLogicalBytes
    )
      throw new Error('Private staging reservations exceed shared capacity')
    await this.#physical(trx, removal)
  }
  async #usage(trx: Knex.Transaction): Promise<Brc38StagingUsage> {
    const values = (await trx.raw(
      'SELECT count(*) AS imports, coalesce(sum(maximumPhysicalBytes),0) AS physicalBytes, coalesce(sum(maximumLogicalBytes),0) AS logicalBytes FROM reservations'
    )) as Brc38StagingUsage[]
    const value = values.at(0)
    if (
      value === undefined ||
      !Number.isSafeInteger(value.imports) ||
      !Number.isSafeInteger(value.physicalBytes) ||
      !Number.isSafeInteger(value.logicalBytes)
    )
      throw new Error('Invalid private staging usage counters')
    return {
      imports: value.imports,
      physicalBytes: catalogReservation + value.physicalBytes,
      logicalBytes: value.logicalBytes
    }
  }
  async #physical(trx: Knex.Transaction, removal: boolean): Promise<void> {
    let entries = 0,
      total = 0
    await visitEntries(this.directory, async name => {
      if (++entries > 2 * this.limits.maximumImports + 2) throw new Error('Private staging root entry bound exceeded')
      const filename = join(this.directory, name),
        value = await requirePrivatePath(
          filename,
          name === catalogName || name === catalogName + '-journal' ? false : true
        )
      if (name === catalogName || name === catalogName + '-journal') {
        if (value.size > BigInt(catalogMaximum + 65536)) throw new Error('Invalid private staging catalog footprint')
        total += physicalBytes(value)
      } else {
        total += await this.#reservedDirectoryPhysical(trx, name, value, removal)
      }
      if (!Number.isSafeInteger(total) || (!removal && total > this.limits.maximumPhysicalBytes))
        throw new SnapshotResourceLimitError('Shared private staging physical capacity exceeded')
    })
  }
  async #reservedDirectoryPhysical(
    trx: Knex.Transaction,
    name: string,
    value: BigIntStats,
    removal: boolean
  ): Promise<number> {
    const id = name.endsWith('.retired') ? name.slice(0, -8) : name
    if (!idPattern.test(id) || !value.isDirectory()) throw new Error('Unregistered private staging root entry')
    const other = await optionalStat(join(this.directory, name.endsWith('.retired') ? id : id + '.retired'))
    if (other !== undefined) throw new Error('Ambiguous private staging retirement')
    const reservation = await trx<Reservation>('reservations').where({ id }).first('maximumPhysicalBytes')
    if (reservation === undefined) throw new Error('Unregistered private staging directory')
    return await this.#stagePhysical(join(this.directory, name), reservation.maximumPhysicalBytes, removal)
  }
  async #stagePhysical(directory: string, maximum: number, removal: boolean): Promise<number> {
    let total = 0,
      count = 0
    await visitEntries(directory, async name => {
      if (
        ++count > 4 ||
        !['stage.sqlite', 'stage.sqlite-journal', 'brc38-owner.sqlite', 'brc38-owner.sqlite-journal'].includes(name)
      )
        throw new Error('Unknown file in private staging reservation')
      const file = await requirePrivatePath(join(directory, name), false)
      total += physicalBytes(file)
      if (!Number.isSafeInteger(total) || (!removal && total > maximum))
        throw new SnapshotResourceLimitError('Private stage physical reservation exceeded')
    })
    return total
  }
  async usage(): Promise<Brc38StagingUsage> {
    return await this.#exclusive(trx => this.#usage(trx))
  }
  async admit(selected: KnexBrc38StagingLimits, binding: Brc38StagingBinding): Promise<Brc38StagingReservation> {
    const limits = Object.freeze({ ...selected }),
      bound = brc38StagingBinding(binding, limits),
      digest = bound.digest
    validateBrc38StagingLimits(limits)
    boundedInteger(limits.maximumPhysicalBytes, 1048576, this.limits.maximumPhysicalBytes)
    boundedInteger(limits.maximumLogicalBytes, 1, this.limits.maximumLogicalBytes)
    boundedInteger(limits.expiresAt, Date.now() + 1, Date.now() + 86400000)
    const id = randomUUID()
    await this.#exclusive(async trx => {
      const usage = await this.#usage(trx)
      if (
        usage.imports >= this.limits.maximumImports ||
        limits.maximumPhysicalBytes > this.limits.maximumPhysicalBytes - usage.physicalBytes ||
        limits.maximumLogicalBytes > this.limits.maximumLogicalBytes - usage.logicalBytes
      )
        throw new SnapshotResourceLimitError('Shared private staging capacity is reserved')
      await trx('reservations').insert({
        id,
        digest,
        expiresAt: limits.expiresAt,
        maximumPhysicalBytes: limits.maximumPhysicalBytes,
        maximumLogicalBytes: limits.maximumLogicalBytes,
        state: 'reserved'
      })
    })
    let store: KnexBrc38StagingStore | undefined
    try {
      await this.#exclusive(async trx => {
        const row = await this.#reservation(trx, id)
        if (row.state !== 'reserved' || Date.now() >= row.expiresAt)
          throw new Error('Private staging creation reservation expired')
        store = await KnexBrc38StagingStore.createOwnedAt(
          join(this.directory, id),
          limits,
          bound.binding,
          join(this.directory, id + '.retired')
        )
        await trx('reservations').where({ id }).update({ state: 'ready' })
      })
      if (store === undefined) throw new Error('Private staging creation did not return an owner')
      return Object.freeze({ id, store })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError && store === undefined)
        throw new Brc38StagingCleanupError(
          [cause],
          'Private staging creation retains physical cleanup',
          async () => await this.#exclusive(async () => await cause.retryCleanup(), true)
        )
      return await closeFailedStore(store, cause)
    }
  }
  async #reservation(trx: Knex.Transaction, id: string): Promise<Reservation> {
    if (!idPattern.test(id)) throw new TypeError('Invalid private staging reservation identity')
    const value = await trx<Reservation>('reservations').where({ id }).first()
    if (value === undefined || !/^[0-9a-f]{64}$/.test(value.digest))
      throw new Error('Private staging reservation is absent or invalid')
    return value
  }
  async resume(
    id: string,
    selected: KnexBrc38StagingLimits,
    binding: Brc38StagingBinding
  ): Promise<Brc38StagingReservation> {
    const limits = Object.freeze({ ...selected }),
      bound = brc38StagingBinding(binding, limits)
    let store: KnexBrc38StagingStore | undefined
    try {
      return await this.#exclusive(async trx => {
        const row = await this.#reservation(trx, id)
        if (row.state !== 'ready' || row.digest !== bound.digest || row.expiresAt !== limits.expiresAt)
          throw new Error('Private staging reservation binding does not match')
        store = await KnexBrc38StagingStore.reopenOwned(
          join(this.directory, id),
          limits,
          bound.binding,
          join(this.directory, id + '.retired')
        )
        return Object.freeze({ id, store })
      })
    } catch (cause) {
      return await closeFailedStore(store, cause)
    }
  }
  /** Explicit internal handoff only. The prior store must physically close
   * before this call; actual kernel exclusion refuses a still-live claimant.
   * It does not enlarge capacity, change expiry or advertise a native receiver. */
  async resumeNative(
    id: string,
    selected: KnexBrc38StagingLimits,
    binding: Brc38StagingBinding,
    executable: string
  ): Promise<Brc38StagingReservation> {
    const limits = Object.freeze({ ...selected }),
      bound = brc38StagingBinding(binding, limits)
    let store: KnexBrc38StagingStore | undefined
    try {
      return await this.#exclusive(async trx => {
        const row = await this.#reservation(trx, id)
        if (row.state !== 'ready' || row.digest !== bound.digest || row.expiresAt !== limits.expiresAt)
          throw new Error('Private native reservation binding does not match')
        store = await KnexBrc38StagingStore.reopenOwnedNative(
          join(this.directory, id),
          limits,
          bound.binding,
          executable,
          join(this.directory, id + '.retired')
        )
        return Object.freeze({ id, store })
      })
    } catch (cause) {
      return await closeFailedStore(store, cause)
    }
  }
  async discard(reservation: Brc38StagingReservation, cause: unknown): Promise<void> {
    let owned = false
    try {
      await this.#exclusive(async trx => {
        const pending = this.#pendingDisposals.get(reservation.id)
        if (pending?.store === reservation.store) {
          const present = await trx<Reservation>('reservations').where({ id: reservation.id }).first('id')
          if (present === undefined) {
            this.#verifyPendingOwner(reservation.id, pending)
            owned = true
            // Another catalog writer can commit expired physical cleanup. This
            // owner still drains its native handle and proves exact path absence.
            await pending.store.close()
            await this.#releaseRemoved(trx, reservation.id)
            return
          }
        }
        const row = await this.#reservation(trx, reservation.id)
        if (
          reservation.store.directory !== join(this.directory, row.id) ||
          reservation.store.binding?.digest !== row.digest
        )
          throw new Error('Private staging disposal owner does not match its reservation')
        if (!this.#pendingDisposals.has(row.id) && this.#pendingDisposals.size >= this.limits.maximumImports)
          throw new SnapshotResourceLimitError(
            'Complete prior owned private staging disposal before additional disposal'
          )
        owned = true
        this.#pendingDisposals.set(row.id, Object.freeze({ store: reservation.store, digest: row.digest }))
        await reservation.store.discard(cause)
        await this.#releaseRemoved(trx, row.id)
      }, true)
    } catch (error_) {
      if (!owned) throw error_
      // The actual catalog COMMIT is part of disposal. A failure after unlink
      // must retain the same retry owner and charge until durable release.
      const detail = error_ instanceof Error ? error_.message : 'native teardown failed'
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Private staging disposal retains physical cleanup: ' + detail,
        async () => {
          if (this.#pendingDisposals.has(reservation.id)) await this.discard(reservation, cause)
        }
      )
    }
    this.#pendingDisposals.delete(reservation.id)
  }
  /** Explicit disposal after physical handoff drainage. Matching paths or a
   * close flag are insufficient: the actual closed store is checked, then the
   * catalog owner obtains fresh kernel cleanup exclusion before deleting only
   * this reservation. It works after expiry without reopening an import lease.
   * A concurrently live next owner refuses removal through the real lock. */
  async discardReleased(reservation: Brc38StagingReservation): Promise<void> {
    KnexBrc38StagingStore.assertReleasedForDisposal(reservation.store)
    const id = reservation.id,
      store = reservation.store
    await this.#exclusive(async trx => {
      KnexBrc38StagingStore.assertReleasedForDisposal(store)
      const present = await trx<Reservation>('reservations').where({ id }).first()
      if (present === undefined) {
        await this.#releaseRemoved(trx, id)
        return
      }
      const row = await this.#reservation(trx, id)
      if (
        store.directory !== join(this.directory, row.id) ||
        store.binding?.digest !== row.digest ||
        store.limits.expiresAt !== row.expiresAt ||
        store.limits.maximumPhysicalBytes !== row.maximumPhysicalBytes ||
        store.limits.maximumLogicalBytes !== row.maximumLogicalBytes
      )
        throw new Error('Released private disposal differs from its actual original reservation')
      await this.#remove(trx, row)
    }, true)
    this.#pendingDisposals.delete(id)
  }
  #verifyPendingOwner(id: string, pending: { readonly store: KnexBrc38StagingStore; readonly digest: string }): void {
    if (pending.store.directory !== join(this.directory, id) || pending.store.binding?.digest !== pending.digest)
      throw new Error('Pending private staging disposal owner changed')
  }
  async #releasedDisposals(trx: Knex.Transaction): Promise<string[]> {
    const removed: string[] = []
    await runInSeries([...this.#pendingDisposals], async ([id, pending]) => {
      const present = await trx<Reservation>('reservations').where({ id }).first('id')
      if (present !== undefined) return
      this.#verifyPendingOwner(id, pending)
      await pending.store.close()
      await this.#releaseRemoved(trx, id)
      removed.push(id)
    })
    return removed
  }
  async #releaseRemoved(trx: Knex.Transaction, id: string): Promise<void> {
    if (
      (await optionalStat(join(this.directory, id))) !== undefined ||
      (await optionalStat(join(this.directory, id + '.retired'))) !== undefined
    )
      throw new Error('Private staging files have not physically drained')
    await trx('reservations').where({ id }).delete()
  }
  /** Bounded cleanup visits only expired indexed reservations. A busy owner
   * refuses the pass and keeps its charge; a deadline never proves process exit. */
  async collectExpired(maximum: number): Promise<number> {
    boundedInteger(maximum, 1, this.limits.maximumImports)
    const removedIds: string[] = []
    const removed = await this.#exclusive(async trx => {
      const values = await trx<Reservation>('reservations')
        .where('expiresAt', '<=', Date.now())
        .orderBy('expiresAt')
        .orderBy('id')
        .limit(maximum)
      let removed = 0
      await runInSeries(values, async row => {
        try {
          await this.#remove(trx, row)
          removedIds.push(row.id)
          removed++
        } catch (cause) {
          if (!nativeCode(cause, 'SQLITE_BUSY')) throw cause
          // A physically live expired owner keeps its reservation. Other expired
          // imports can still drain during the same bounded pass.
        }
      })
      return removed
    }, true)
    // Clear retained ownership only after the catalog transaction commits.
    for (const id of removedIds) this.#pendingDisposals.delete(id)
    return removed
  }
  async #remove(trx: Knex.Transaction, row: Reservation): Promise<void> {
    await this.#reservation(trx, row.id)
    const original = join(this.directory, row.id),
      retired = original + '.retired'
    const old = await optionalStat(original),
      moved = await optionalStat(retired)
    if (old !== undefined && moved !== undefined) throw new Error('Ambiguous private staging retirement')
    let path: string | undefined
    if (old !== undefined) path = original
    else if (moved !== undefined) path = retired
    if (path !== undefined) {
      const ownerFile = await optionalStat(join(path, 'brc38-owner.sqlite'))
      if (ownerFile === undefined) {
        if (row.state !== 'reserved') throw new Error('A ready private stage lost its ownership file')
        await visitEntries(path, async () => {
          throw new Error('Incomplete private stage without an owner is not empty')
        })
        await rm(path, { recursive: true })
      } else {
        await this.#retireOwned(path, original, retired, row)
      }
    }
    await this.#releaseRemoved(trx, row.id)
  }
  async #retireOwned(path: string, original: string, retired: string, row: Reservation): Promise<void> {
    const owner = await Brc38StagingOwnershipNode.claimForCleanup(
      path,
      row.digest,
      row.expiresAt,
      row.state === 'reserved'
    )
    let target = path
    try {
      if (path === original) {
        await rename(original, retired)
        target = retired
      }
      // First remove the resumable path under its owner, then physically
      // close before unlinking. A failed close must retain visible files.
      // The root writer excludes every cleanup/creator on the retired path.
      await owner.release()
      await rm(target, { recursive: true })
    } catch (cause) {
      try {
        await owner.release()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private staging removal and owner close both failed',
          async () => await owner.release()
        )
      }
      throw cause
    }
  }
  async close(): Promise<void> {
    if (this.#busy) throw new Error('Wait for private staging catalog work before close')
    if (this.#pendingDisposals.size !== 0 || this.#pendingCatalogCleanup !== undefined) {
      const removed = await this.#exclusive(trx => this.#releasedDisposals(trx), true)
      // An independent committed cleanup can release this catalog's lifetime
      // fence only after native close, exact path proof and this commit settle.
      for (const id of removed) this.#pendingDisposals.delete(id)
      if (this.#pendingDisposals.size !== 0)
        throw new Error('Complete owned private staging disposal before catalog close')
    }
    this.#closed = true
    await this.knex.destroy()
  }
}
