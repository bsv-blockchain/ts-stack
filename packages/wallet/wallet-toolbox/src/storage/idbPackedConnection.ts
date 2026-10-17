import { unwrap, wrap, type IDBPDatabase } from 'idb'
import type { StorageIdbSchema } from './schema/StorageIdbSchema'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'
import { attachPackedIdbStages, type PackedIdbStagedField } from './idbPackedStaging'
import {
  idbImportJournalStores,
  isIdbRestoreDatabaseName,
  verifyIdbImportJournalSchema
} from './idbImportJournalSchema'
import { readBrc38IdbRestorePublication } from './portable/Brc38IdbRestorePublication'
import {
  admissionCopy,
  boundedJson,
  read as readImportReceipt,
  type StoredReceipt
} from './portable/Brc38ImportJournalContract'
import {
  boundPackedIdbTransaction,
  checkPackedIdbTransactionTime,
  chargePackedIdb,
  hydratePackedIdbRow,
  packIdbRow,
  packedIdbAllocationBytes,
  packedIdbInvalid,
  packedIdbDateTimestamp,
  packedIdbIsAbortError,
  packedIdbKey,
  packedIdbMarker,
  packedIdbMetadataCharge,
  packedIdbPortableKey,
  packedIdbReplicaKey,
  packedIdbRowAllocation,
  packedIdbRowValue,
  packedIdbStores,
  packedIdbReferences,
  packedIdbVersionCharge,
  readPackedIdbClock,
  requirePackedIdbWriter,
  retainPackedIdbFields,
  unpackPackedIdbMetadata,
  checkPackedIdbContent,
  verifyPackedIdbReferences,
  type PackedIdbDatabase,
  type PackedIdbRow,
  type PackedIdbTransaction
} from './idbPackedFields'

type PackedStore = ReturnType<PackedIdbTransaction['objectStore']>
type PackedIndex = ReturnType<PackedStore['index']>
type PackedCursor = NonNullable<Awaited<ReturnType<PackedStore['openCursor']>>>
type PackedKeyCursor = NonNullable<Awaited<ReturnType<PackedStore['openKeyCursor']>>>
interface RestoreEffects {
  raw: PackedIdbTransaction
  stores: readonly string[]
  sealed: boolean
  pending: Set<Promise<unknown>>
  failure?: unknown
}
/** Current-row position DATA. Only fields actually attached to that same row
 * at this exact revision may be retained; descriptors confer no admission. */
export interface PackedIdbRetainedFields {
  readonly revision: number
  readonly names: readonly string[]
}
export function capturePackedIdbRetainedFields(
  value: PackedIdbRetainedFields | undefined
): Readonly<PackedIdbRetainedFields> | undefined {
  if (value === undefined) return undefined
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Array.isArray(value.names) ||
    value.names.length < 1 ||
    value.names.length > 128 ||
    value.names.some(
      name =>
        typeof name !== 'string' ||
        name.length < 1 ||
        name.length > 128 ||
        ['__proto__', 'constructor', 'prototype', packedIdbMarker].includes(name)
    ) ||
    new Set(value.names).size !== value.names.length
  )
    packedIdbInvalid()
  return Object.freeze({ revision: value.revision, names: Object.freeze([...value.names]) })
}
const connections = new WeakMap<object, PackedIdbConnection>()
const transactions = new WeakMap<object, PackedIdbConnection>()

/** Genuine factory membership selects this explicit layout. It does not cache
 * a schema, profile, user, primary or content verification result. */
export function getPackedIdbConnection(db: IDBPDatabase<StorageIdbSchema>): PackedIdbConnection | undefined {
  return connections.get(db)
}
export function requirePackedIdbTransaction(db: IDBPDatabase<StorageIdbSchema>, tx: object): void {
  const owner = connections.get(db)
  if (owner === undefined || !owner.isOpen || transactions.get(tx) !== owner) packedIdbInvalid()
}
function metadata(value: Record<string, unknown>, store: string): PackedIdbRow {
  // The initial settings row is written by the versionchange transaction.
  if (store === 'settings' && !Object.hasOwn(value, packedIdbMarker)) {
    packedIdbMetadataCharge(value)
    return { fields: { ...value }, extents: {} }
  }
  return unpackPackedIdbMetadata(value)
}
function boundMethod(target: object, property: PropertyKey): unknown {
  const value: unknown = Reflect.get(target, property, target)
  return typeof value === 'function' ? value.bind(target) : value
}
function nativeKeyFields(store: PackedStore, fields: Record<string, unknown>, key: IDBValidKey): void {
  if (typeof store.keyPath === 'string') fields[store.keyPath] = key
  else if (Array.isArray(store.keyPath)) {
    if (!Array.isArray(key) || key.length !== store.keyPath.length) packedIdbInvalid()
    store.keyPath.forEach((name, index) => {
      fields[name] = key[index]
    })
  } else packedIdbInvalid()
}
function indexedFields(store: PackedStore): ReadonlySet<string> {
  const fields = new Set<string>()
  for (const path of [store.keyPath, ...Array.from(store.indexNames, name => store.index(name).keyPath)]) {
    if (typeof path === 'string') fields.add(path)
    else if (Array.isArray(path)) path.forEach(name => fields.add(name))
  }
  return fields
}
export class PackedIdbConnection {
  // Actual factory-issued facade membership, never a reusable schema, source
  // authorization or semantic verdict. Current writer/lifecycle checks repeat.
  readonly #wrappedTransactions = new WeakMap<object, { raw: PackedIdbTransaction; stores: readonly string[] }>()
  readonly database: IDBPDatabase<StorageIdbSchema>
  readonly #native: IDBDatabase
  readonly #nativeTransaction: IDBDatabase['transaction']
  readonly #nativeClose: IDBDatabase['close']
  readonly #maximumBytes: number
  readonly #maximumRecords: number
  #open = true
  readonly #pending = new Set<Promise<void>>()
  readonly #restoreEffects = new WeakMap<object, RestoreEffects>()
  readonly #operationalEffects = new WeakMap<object, RestoreEffects>()
  #closePromise?: Promise<void>

  private constructor(raw: PackedIdbDatabase, native: IDBDatabase, maximumBytes: number, maximumRecords: number) {
    this.#native = native
    this.#nativeTransaction = IDBDatabase.prototype.transaction
    this.#nativeClose = IDBDatabase.prototype.close
    this.#maximumBytes = maximumBytes
    this.#maximumRecords = maximumRecords
    const proxy = new Proxy(raw, {
      get: (target, property) => {
        if (property === 'transaction')
          return (
            stores: string | string[],
            mode: 'readonly' | 'readwrite' = 'readonly',
            options?: IDBTransactionOptions
          ) => this.transaction(typeof stores === 'string' ? [stores] : stores, mode, options)
        if (property === 'close')
          return () => {
            void this.close().catch(() => undefined)
          }
        // idb's convenience methods otherwise create transactions on the raw
        // connection and bypass observation. Route every one through this owner.
        if (
          ['get', 'getKey', 'getAll', 'getAllKeys', 'count', 'put', 'add', 'delete', 'clear'].includes(String(property))
        )
          return async (store: string, ...args: unknown[]) => this.convenience(String(property), store, undefined, args)
        if (
          ['getFromIndex', 'getKeyFromIndex', 'getAllFromIndex', 'getAllKeysFromIndex', 'countFromIndex'].includes(
            String(property)
          )
        )
          return async (store: string, index: string, ...args: unknown[]) =>
            this.convenience(String(property).replace('FromIndex', ''), store, index, args)
        return boundMethod(target, property)
      }
    }) as unknown as IDBPDatabase<StorageIdbSchema>
    this.database = proxy
    connections.set(proxy, this)
    IDBDatabase.prototype.addEventListener.call(native, 'versionchange', () => {
      void this.close().catch(() => undefined)
    })
    IDBDatabase.prototype.addEventListener.call(native, 'close', () => {
      this.#open = false
    })
  }
  static create(raw: PackedIdbDatabase, maximumBytes: number, maximumRecords: number): PackedIdbConnection {
    if (typeof IDBDatabase === 'undefined') packedIdbInvalid()
    const native = unwrap(raw)
    if (native === undefined) packedIdbInvalid()
    // The intrinsic checks the actual browser database receiver. A structural
    // object, prototype/label copy or proxy cannot enroll by claiming version7.
    const probe = wrap(
      IDBDatabase.prototype.transaction.call(native, Object.values(packedIdbStores), 'readonly')
    ) as PackedIdbTransaction<'readonly'>
    void probe.done.catch(() => undefined)
    try {
      probe.abort()
    } catch {
      /* No requests were issued. */
    }
    if (native.version !== 7 || Object.values(packedIdbStores).some(name => !native.objectStoreNames.contains(name)))
      packedIdbInvalid()
    const owner = new PackedIdbConnection(raw, native, maximumBytes, maximumRecords)
    owner.track(probe)
    return owner
  }
  get isOpen(): boolean {
    return this.#open
  }
  assertOpen(): void {
    if (!this.#open) packedIdbInvalid()
  }
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#open = false
    this.#nativeClose.call(this.#native)
    this.#closePromise = (async () => {
      const settled = await Promise.allSettled(this.#pending)
      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason as unknown)
        .filter(error => !packedIdbIsAbortError(error))
      if (failures.length !== 0)
        throw new AggregateError(failures, 'Packed IndexedDB connection transaction drain failed')
    })()
    return this.#closePromise
  }
  private track(tx: PackedIdbTransaction): void {
    boundPackedIdbTransaction(tx, this.#maximumBytes, this.#maximumRecords)
    transactions.set(tx, this)
    this.#pending.add(tx.done)
    void tx.done.then(
      () => this.#pending.delete(tx.done),
      () => this.#pending.delete(tx.done)
    )
  }

  /** Short actual transactions only. These internal stores always participate
   * in the same transaction as approved row mutations and their versions. */
  rawTransaction<Mode extends 'readonly' | 'readwrite'>(
    stores: readonly string[],
    mode: Mode
  ): PackedIdbTransaction<Mode> {
    this.assertOpen()
    const internal = new Set<string>(Object.values(packedIdbStores))
    if (stores.some(store => store.startsWith('_wallet_packed_') && !internal.has(store))) packedIdbInvalid()
    const tx = wrap(
      this.#nativeTransaction.call(this.#native, this.actualTransactionStores(stores), mode)
    ) as PackedIdbTransaction<Mode>
    this.track(tx)
    void tx.done.catch(() => undefined)
    return tx
  }
  transaction<Mode extends 'readonly' | 'readwrite'>(
    stores: readonly string[],
    mode: Mode,
    options?: IDBTransactionOptions
  ): PackedIdbTransaction<Mode> {
    this.assertOpen()
    if (mode !== 'readonly' && mode !== 'readwrite') packedIdbInvalid()
    if (!Array.isArray(stores) || stores.length === 0 || stores.some(name => name.startsWith('_wallet_packed_')))
      packedIdbInvalid()
    const raw = wrap(
      this.#nativeTransaction.call(this.#native, this.actualTransactionStores(stores), mode, options)
    ) as PackedIdbTransaction<Mode>
    this.track(raw)
    void raw.done.catch(() => undefined)
    return this.wrapTransaction(raw, stores)
  }
  private actualTransactionStores(stores: readonly string[]): string[] {
    const name = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name')?.get
    if (name === undefined) packedIdbInvalid()
    const restore = isIdbRestoreDatabaseName(name.call(this.#native) as string)
    return [
      ...new Set([
        ...stores,
        ...Object.values(packedIdbStores),
        ...(restore ? ['settings', 'users', ...Object.values(idbImportJournalStores)] : [])
      ])
    ]
  }
  /** Actual current lifecycle gate, repeated in the writer. A prepared or
   * merely published namespace cannot become an ordinary wallet by using a
   * generic provider method. Actual enrolled restore effects remain separate.
   * This operational state is not a cached archive/semantic verdict. */
  private async requireOperationalRestoreWrite(tx: PackedIdbTransaction): Promise<void> {
    if (!isIdbRestoreDatabaseName(tx.db.name)) return
    const effects = this.#restoreEffects.get(tx)
    if (effects !== undefined) {
      if (effects.sealed) packedIdbInvalid()
      return
    }
    verifyIdbImportJournalSchema(tx)
    const clock = await readPackedIdbClock(tx),
      entry = await tx.objectStore(idbImportJournalStores.journal).get(1)
    if (
      entry === undefined ||
      (await tx.objectStore(idbImportJournalStores.journal).count()) !== 1 ||
      (await tx.objectStore('settings').count()) !== 1 ||
      (await tx.objectStore('users').count()) !== 1
    )
      packedIdbInvalid()
    const publication = readBrc38IdbRestorePublication(entry.publicationJson),
      settings = await tx.objectStore('settings').openCursor(),
      user = await tx.objectStore('users').openCursor()
    boundedJson(entry)
    if (typeof entry.admissionJson !== 'string') packedIdbInvalid()
    const admission = admissionCopy(JSON.parse(entry.admissionJson)),
      receipt = readImportReceipt(entry as unknown as StoredReceipt, admission)
    if (
      publication.state !== 'ACTIVATED' ||
      publication.databaseName !== tx.db.name ||
      publication.epoch !== clock.epoch ||
      publication.activatedRevision! > clock.revision ||
      entry.epoch !== publication.epoch ||
      entry.revision !== publication.activatedRevision ||
      entry.bindingSha256 !== publication.bindingSha256 ||
      entry.archiveSha256 !== publication.archiveSha256 ||
      publication.importId !== admission.scope.importId ||
      publication.previewId !== admission.previewId ||
      publication.publishedAt >= admission.expiresAt ||
      publication.activatedAt! >= admission.expiresAt ||
      receipt.state !== 'COMPLETE' ||
      receipt.nextRow !== entry.originalRows ||
      (await tx.objectStore(idbImportJournalStores.ids).count()) !== receipt.mappedIds ||
      (await tx.objectStore(idbImportJournalStores.originals).count()) !== entry.originalRows ||
      settings === null ||
      settings.value.chain !== publication.chain ||
      settings.value.storageIdentityKey !== publication.targetStorageIdentityKey ||
      user === null ||
      user.value.userId !== entry.userId ||
      user.value.identityKey !== publication.identityKey
    )
      packedIdbInvalid()
  }
  /** Internal isolated restore writer. Row operations use the normal observed
   * facade; journal/maps/originals use the same native transaction. Callers must
   * prepare/authenticate source data before entry and supply no network work.
   * Neither returned object establishes source or activation authority. */
  restoreTransaction<Mode extends 'readonly' | 'readwrite'>(
    stores: readonly string[],
    mode: Mode
  ): { wallet: PackedIdbTransaction<Mode>; journal: PackedIdbTransaction<Mode> } {
    this.assertOpen()
    const name = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name')?.get
    if (
      name === undefined ||
      !isIdbRestoreDatabaseName(name.call(this.#native) as string) ||
      !Array.isArray(stores) ||
      stores.length === 0 ||
      (mode !== 'readonly' && mode !== 'readwrite') ||
      stores.some(store => typeof store !== 'string' || store.startsWith('_'))
    )
      packedIdbInvalid()
    const raw = this.rawTransaction([...stores, ...Object.values(idbImportJournalStores)], mode)
    try {
      verifyIdbImportJournalSchema(raw)
      const wallet = this.wrapTransaction(raw, stores),
        effects: RestoreEffects = {
          raw,
          stores: Object.freeze([...stores]),
          sealed: false,
          pending: new Set()
        }
      this.#restoreEffects.set(raw, effects)
      this.#restoreEffects.set(wallet, effects)
      return { wallet, journal: raw }
    } catch (cause) {
      try {
        raw.abort()
      } catch {
        /* settled */
      }
      throw cause
    }
  }
  /** Wallet effects and operational checkpoint DATA share one physical
   * transaction. This never enrolls isolated restore effects or waives their
   * current lifecycle. All source/network preparation precedes this scope. */
  operationalTransaction<Mode extends 'readonly' | 'readwrite'>(
    stores: readonly string[],
    mode: Mode
  ): { wallet: PackedIdbTransaction<Mode>; journal: PackedIdbTransaction<Mode> } {
    if (
      !Array.isArray(stores) ||
      stores.length === 0 ||
      (mode !== 'readonly' && mode !== 'readwrite') ||
      stores.some(store => typeof store !== 'string' || store.startsWith('_'))
    )
      packedIdbInvalid()
    const raw = this.rawTransaction(stores, mode),
      wallet = this.wrapTransaction(raw, stores),
      effects: RestoreEffects = { raw, stores: Object.freeze([...stores]), sealed: false, pending: new Set() }
    this.#operationalEffects.set(raw, effects)
    this.#operationalEffects.set(wallet, effects)
    return { wallet, journal: raw }
  }
  /** Fresh operational lifecycle check in this owner's actual current view.
   * It returns no reusable admission or source-authentication token. */
  async checkOperationalTransaction(tx: PackedIdbTransaction): Promise<void> {
    if (transactions.get(tx) !== this || this.#operationalEffects.get(tx) === undefined) packedIdbInvalid()
    this.assertOpen()
    await readPackedIdbClock(tx)
    await this.requireOperationalRestoreWrite(tx)
  }
  /** Same actual native transaction for bounded metadata inspection. This
   * unwraps the ordinary hydrating facade only within its original operational
   * phase; copied transactions, restore phases and closed phases refuse. It
   * grants no profile, schema, source or semantic admission. */
  operationalMetadataTransaction(tx: PackedIdbTransaction): PackedIdbTransaction {
    const effects = this.#operationalEffects.get(tx)
    if (
      transactions.get(tx) !== this ||
      effects === undefined ||
      effects.sealed ||
      transactions.get(effects.raw) !== this
    )
      packedIdbInvalid()
    this.assertOpen()
    return effects.raw
  }
  async sealOperationalEffects(tx: PackedIdbTransaction): Promise<void> {
    const effects = this.#operationalEffects.get(tx)
    if (effects === undefined || transactions.get(tx) !== this) packedIdbInvalid()
    if (effects.sealed) return
    effects.sealed = true
    if (effects.pending.size !== 0) {
      try {
        effects.raw.abort()
      } catch {
        /* settled */
      }
      await Promise.allSettled(effects.pending)
      throw new Error('Operational sync returned with unawaited provider effects')
    }
    if (effects.failure !== undefined) throw effects.failure
  }
  private wrapTransaction<Mode extends 'readonly' | 'readwrite'>(
    raw: PackedIdbTransaction<Mode>,
    stores: readonly string[]
  ): PackedIdbTransaction<Mode> {
    let wrapper: PackedIdbTransaction<Mode>
    wrapper = new Proxy(raw, {
      get: (target, property) => {
        if (property === 'db') return this.database
        if (property === 'store')
          return stores.length === 1 ? this.store(target.objectStore(stores[0]), target, wrapper) : undefined
        if (property === 'objectStore')
          return (name: string) => {
            if (!stores.includes(name)) packedIdbInvalid()
            return this.store(target.objectStore(name), target, wrapper)
          }
        return boundMethod(target, property)
      }
    })
    transactions.set(wrapper, this)
    this.#wrappedTransactions.set(wrapper, { raw, stores: Object.freeze([...stores]) })
    return wrapper
  }
  /** End this genuine one-use row-effect phase before writing a checkpoint.
   * Unawaited normal provider mutations abort the complete native writer. */
  async sealRestoreEffects(tx: PackedIdbTransaction): Promise<void> {
    const effects = this.#restoreEffects.get(tx)
    if (effects === undefined || transactions.get(tx) !== this) packedIdbInvalid()
    if (effects.sealed) return
    effects.sealed = true
    if (effects.pending.size !== 0) {
      try {
        effects.raw.abort()
      } catch {
        /* settled */
      }
      await Promise.allSettled(effects.pending)
      throw new Error('Restore returned with unawaited provider effects')
    }
    if (effects.failure !== undefined) throw effects.failure
  }
  abandonRestoreEffects(tx: PackedIdbTransaction): void {
    const effects = this.#restoreEffects.get(tx)
    if (effects === undefined || transactions.get(tx) !== this) packedIdbInvalid()
    effects.sealed = true
    try {
      effects.raw.abort()
    } catch {
      /* settled */
    }
  }
  private async convenience(
    method: string,
    name: string,
    index: string | undefined,
    args: unknown[]
  ): Promise<unknown> {
    const write = ['put', 'add', 'delete', 'clear'].includes(method)
    const tx = this.transaction([name], write ? 'readwrite' : 'readonly')
    try {
      const store = tx.objectStore(name),
        target = index === undefined ? store : store.index(index)
      const operation: unknown = Reflect.get(target, method)
      if (typeof operation !== 'function') packedIdbInvalid()
      const answer: unknown = await Reflect.apply(operation, target, args)
      await tx.done
      this.assertOpen()
      return answer
    } catch (error) {
      await this.abort(tx, error)
      throw error
    }
  }
  private async abort(tx: PackedIdbTransaction, original: unknown): Promise<void> {
    try {
      tx.abort()
    } catch {
      /* The transaction may already have settled. */
    }
    try {
      await tx.done
    } catch (error) {
      if (error !== original && !packedIdbIsAbortError(error))
        throw new AggregateError([original, error], 'Packed IndexedDB operation and transaction cleanup failed', {
          cause: original
        })
    }
  }
  private guarded<T>(tx: PackedIdbTransaction, run: () => Promise<T>, mutation = false): Promise<T> {
    const effects = mutation ? (this.#restoreEffects.get(tx) ?? this.#operationalEffects.get(tx)) : undefined
    if (effects?.sealed) return Promise.reject(new Error('Packed provider effect phase ended'))
    const operation = (async () => {
      try {
        this.assertOpen()
        await readPackedIdbClock(tx)
        if (effects?.sealed) packedIdbInvalid()
        const answer = await run()
        this.assertOpen()
        checkPackedIdbTransactionTime(tx)
        return answer
      } catch (error) {
        if (effects !== undefined) effects.failure = error
        try {
          tx.abort()
        } catch {
          /* Awaiting callers still observe tx.done. */
        }
        throw error
      }
    })()
    if (effects === undefined) return operation
    const result: Promise<T> = operation.finally(() => {
      effects.pending.delete(result)
    })
    effects.pending.add(result)
    void result.catch(() => undefined)
    return result
  }
  private async observe(
    tx: PackedIdbTransaction<'readwrite'>,
    name: string,
    key: IDBValidKey,
    row?: PackedIdbRow
  ): Promise<void> {
    await this.requireOperationalRestoreWrite(tx)
    const clock = await readPackedIdbClock(tx),
      revision = clock.revision + 1
    if (!Number.isSafeInteger(revision)) packedIdbInvalid()
    const heads = tx.objectStore(packedIdbStores.heads),
      versions = tx.objectStore(packedIdbStores.versions)
    const head = await heads.get([name, key])
    let prior: PackedIdbRow | undefined
    if (head !== undefined) {
      const old = await versions.get([name, key, head.revision as number])
      if (old === undefined || old.obsoleteAt !== undefined) packedIdbInvalid()
      if (name === 'transactions' && old.deleted === false) {
        if (old.value === null || typeof old.value !== 'object') packedIdbInvalid()
        prior = unpackPackedIdbMetadata(old.value as Record<string, unknown>)
      }
      await versions.put({ ...old, obsoleteAt: revision })
    } else await chargePackedIdb(tx, 512, 1)
    const value = row === undefined ? undefined : packedIdbRowValue(row)
    const charge = packedIdbVersionCharge(row)
    await chargePackedIdb(tx, charge, 1)
    if (row !== undefined) await retainPackedIdbFields(tx, row, 1)
    await versions.add({
      store: name,
      key,
      revision,
      deleted: row === undefined,
      ...(value === undefined ? {} : { value }),
      charge,
      references: row === undefined ? [] : packedIdbReferences(row),
      ...(row === undefined ? { deletedAt: revision } : {}),
      ...(typeof row?.fields.txid === 'string' ? { txid: row.fields.txid } : {}),
      ...(typeof row?.fields.provenTxId === 'number' ? { provenTxId: row.fields.provenTxId } : {})
    })
    await heads.put({
      store: name,
      key,
      portableKey: packedIdbPortableKey(name, key),
      replicaKey: packedIdbReplicaKey(name, key),
      revision
    })
    const charged = await readPackedIdbClock(tx)
    // Notification mappings depend on native transaction existence, owner and
    // txid, not descriptions, payloads or lifecycle updates. This scalar is
    // observed in the same atomic row/version writer, including cursor deletes,
    // clears, ordinary puts and staged writes. It is never a read/write grant.
    const changedMembership =
      name === 'transactions' &&
      (prior === undefined ||
        row === undefined ||
        prior.fields.transactionId !== row.fields.transactionId ||
        prior.fields.userId !== row.fields.userId ||
        prior.fields.txid !== row.fields.txid)
    const transactionMembershipRevision = (charged.transactionMembershipRevision ?? 0) + Number(changedMembership)
    if (!Number.isSafeInteger(transactionMembershipRevision) || transactionMembershipRevision > revision)
      packedIdbInvalid()
    await tx.objectStore(packedIdbStores.clock).put({ ...charged, revision, transactionMembershipRevision }, 'clock')
  }
  private async write(
    store: PackedStore,
    tx: PackedIdbTransaction,
    value: unknown,
    add: boolean,
    suppliedKey?: IDBValidKey,
    expectedKey?: IDBValidKey
  ): Promise<IDBValidKey> {
    return await this.guarded(
      tx,
      async () => {
        if (tx.mode !== 'readwrite' || suppliedKey !== undefined) packedIdbInvalid()
        const writer = requirePackedIdbWriter(tx),
          target = writer.objectStore(store.name)
        const row = await packIdbRow(writer, value, indexedFields(target))
        const key = packedIdbKey(await (add ? target.add(packedIdbRowValue(row)) : target.put(packedIdbRowValue(row))))
        if (expectedKey !== undefined && indexedDB.cmp(key, expectedKey) !== 0) packedIdbInvalid()
        nativeKeyFields(store, row.fields, key)
        await this.observe(writer, store.name, key, row)
        return key
      },
      true
    )
  }
  async writeStaged(
    storeName: string,
    fields: Readonly<Record<string, unknown>>,
    staged: Readonly<Record<string, PackedIdbStagedField>>,
    add: boolean,
    retained?: PackedIdbRetainedFields
  ): Promise<IDBValidKey> {
    retained = capturePackedIdbRetainedFields(retained)
    if (storeName.startsWith('_wallet_packed_')) packedIdbInvalid()
    const tx = this.rawTransaction([storeName], 'readwrite'),
      store = tx.objectStore(storeName)
    try {
      const key = await this.guarded(tx, async () => {
        const row = await attachPackedIdbStages(this, tx, fields, staged, indexedFields(store))
        if (retained !== undefined) {
          if (add) packedIdbInvalid()
          await this.retainCurrentFields(tx, store, row, retained)
        }
        const key = packedIdbKey(await (add ? store.add(packedIdbRowValue(row)) : store.put(packedIdbRowValue(row))))
        nativeKeyFields(store, row.fields, key)
        await this.observe(tx, storeName, key, row)
        return key
      })
      await tx.done
      this.assertOpen()
      return key
    } catch (error) {
      await this.abort(tx, error)
      throw error
    }
  }
  private async remove(store: PackedStore, tx: PackedIdbTransaction, query?: IDBValidKey | IDBKeyRange): Promise<void> {
    await this.guarded(
      tx,
      async () => {
        if (tx.mode !== 'readwrite') packedIdbInvalid()
        const writer = requirePackedIdbWriter(tx),
          target = writer.objectStore(store.name)
        const keys: IDBValidKey[] = []
        let cursor = await target.openKeyCursor(query)
        for (; cursor !== null; cursor = await cursor.continue()) {
          if (keys.length >= 256)
            throw new SnapshotResourceLimitError(
              'Packed IndexedDB deletion requires finite batches of at most 256 rows'
            )
          keys.push(packedIdbKey(cursor.primaryKey))
        }
        for (const key of keys) {
          await target.delete(key)
          await this.observe(writer, store.name, key)
        }
      },
      true
    )
  }
  async writeStagedRestore(
    tx: PackedIdbTransaction,
    storeName: string,
    fields: Readonly<Record<string, unknown>>,
    staged: Readonly<Record<string, PackedIdbStagedField>>,
    add: boolean
  ): Promise<IDBValidKey> {
    const effects = this.#restoreEffects.get(tx)
    if (
      effects === undefined ||
      transactions.get(tx) !== this ||
      effects.sealed ||
      !effects.stores.includes(storeName) ||
      effects.raw.mode !== 'readwrite'
    )
      packedIdbInvalid()
    const raw = effects.raw as PackedIdbTransaction<'readwrite'>,
      store = raw.objectStore(storeName)
    return await this.guarded(
      raw,
      async () => {
        const row = await attachPackedIdbStages(this, raw, fields, staged, indexedFields(store))
        const key = packedIdbKey(await (add ? store.add(packedIdbRowValue(row)) : store.put(packedIdbRowValue(row))))
        nativeKeyFields(store, row.fields, key)
        await this.observe(raw, storeName, key, row)
        return key
      },
      true
    )
  }
  /** Attach genuine prepared fields and observed wallet rows in the caller's
   * actual operational transaction, alongside its durable checkpoint. This
   * method opens no transaction and performs no source I/O. Unpublished
   * isolated candidates still require their enrolled restore-effect writer. */
  async writeStagedInTransaction(
    tx: PackedIdbTransaction,
    storeName: string,
    fields: Readonly<Record<string, unknown>>,
    staged: Readonly<Record<string, PackedIdbStagedField>>,
    add: boolean,
    retained?: PackedIdbRetainedFields
  ): Promise<IDBValidKey> {
    retained = capturePackedIdbRetainedFields(retained)
    if (this.#restoreEffects.has(tx)) {
      if (retained !== undefined) packedIdbInvalid()
      return await this.writeStagedRestore(tx, storeName, fields, staged, add)
    }
    const actual = this.#wrappedTransactions.get(tx)
    if (
      actual === undefined ||
      transactions.get(tx) !== this ||
      transactions.get(actual.raw) !== this ||
      actual.raw.mode !== 'readwrite' ||
      !actual.stores.includes(storeName) ||
      storeName.startsWith('_')
    )
      packedIdbInvalid()
    const raw = requirePackedIdbWriter(actual.raw),
      store = raw.objectStore(storeName)
    return await this.guarded(
      raw,
      async () => {
        await this.requireOperationalRestoreWrite(raw)
        const row = await attachPackedIdbStages(this, raw, fields, staged, indexedFields(store))
        if (retained !== undefined) {
          if (add) packedIdbInvalid()
          await this.retainCurrentFields(raw, store, row, retained)
        }
        const key = packedIdbKey(await (add ? store.add(packedIdbRowValue(row)) : store.put(packedIdbRowValue(row))))
        nativeKeyFields(store, row.fields, key)
        await this.observe(raw, storeName, key, row)
        return key
      },
      true
    )
  }
  private async retainCurrentFields(
    tx: PackedIdbTransaction<'readwrite'>,
    store: PackedStore,
    row: PackedIdbRow,
    retained: PackedIdbRetainedFields
  ): Promise<void> {
    if (
      !Number.isSafeInteger(retained.revision) ||
      retained.revision < 1 ||
      !Array.isArray(retained.names) ||
      retained.names.length < 1 ||
      retained.names.length > 128 ||
      new Set(retained.names).size !== retained.names.length
    )
      packedIdbInvalid()
    const indexes = indexedFields(store)
    for (const name of retained.names)
      if (
        typeof name !== 'string' ||
        name.length < 1 ||
        name.length > 128 ||
        ['__proto__', 'constructor', 'prototype', packedIdbMarker].includes(name) ||
        indexes.has(name) ||
        Object.hasOwn(row.fields, name) ||
        Object.hasOwn(row.extents, name)
      )
        packedIdbInvalid()
    const key = packedIdbKey(
        typeof store.keyPath === 'string'
          ? row.fields[store.keyPath]
          : Array.isArray(store.keyPath)
            ? store.keyPath.map(name => row.fields[name])
            : undefined
      ),
      value = await store.get(key),
      head = await tx.objectStore(packedIdbStores.heads).get([store.name, key])
    if (
      value === undefined ||
      head?.store !== store.name ||
      indexedDB.cmp(packedIdbKey(head.key), key) !== 0 ||
      head.revision !== retained.revision ||
      indexedDB.cmp(packedIdbKey(head.portableKey), packedIdbPortableKey(store.name, key)) !== 0 ||
      indexedDB.cmp(packedIdbKey(head.replicaKey), packedIdbReplicaKey(store.name, key)) !== 0
    )
      packedIdbInvalid()
    const current = metadata(value, store.name),
      version = await tx.objectStore(packedIdbStores.versions).get([store.name, key, retained.revision])
    if (
      version?.store !== store.name ||
      indexedDB.cmp(packedIdbKey(version.key), key) !== 0 ||
      version.revision !== retained.revision ||
      version.deleted !== false ||
      version.obsoleteAt !== undefined
    )
      packedIdbInvalid()
    const previous = unpackPackedIdbMetadata(version.value)
    verifyPackedIdbReferences(version.references, previous)
    if (
      JSON.stringify(Object.keys(current.fields).sort()) !== JSON.stringify(Object.keys(previous.fields).sort()) ||
      JSON.stringify(Object.keys(current.extents).sort()) !== JSON.stringify(Object.keys(previous.extents).sort())
    )
      packedIdbInvalid()
    for (const [name, actual] of Object.entries(current.fields)) {
      const expected = previous.fields[name]
      const timestamp = packedIdbDateTimestamp(actual)
      if (timestamp === undefined ? actual !== expected : timestamp !== packedIdbDateTimestamp(expected))
        packedIdbInvalid()
    }
    for (const [name, actual] of Object.entries(current.extents)) {
      const expected = previous.extents[name]
      if (
        actual.content !== expected.content ||
        actual.kind !== expected.kind ||
        actual.bytes !== expected.bytes ||
        actual.sha256 !== expected.sha256
      )
        packedIdbInvalid()
    }
    for (const name of retained.names) {
      const field = current.extents[name]
      if (field === undefined) packedIdbInvalid()
      const actual = await checkPackedIdbContent(tx, field)
      if (typeof actual.refs !== 'number' || actual.refs < 1 || actual.expiresAt !== undefined) packedIdbInvalid()
      row.extents[name] = { ...field }
    }
    if (packedIdbMetadataCharge(row.fields) + Object.keys(row.extents).length * 256 > 65536) packedIdbInvalid()
  }
  private store(target: PackedStore, tx: PackedIdbTransaction, wrapper: PackedIdbTransaction): PackedStore {
    return new Proxy(target, {
      get: (store, property) => {
        if (property === 'transaction') return wrapper
        if (property === 'iterate' || property === Symbol.asyncIterator)
          return () => {
            throw new Error('Packed IndexedDB iteration uses explicit bounded cursors')
          }
        if (property === 'index') return (name: string) => this.index(store.index(name), store, tx, wrapper)
        if (property === 'put' || property === 'add')
          return (value: unknown, key?: IDBValidKey) => this.write(store, tx, value, property === 'add', key)
        if (property === 'delete') return (query: IDBValidKey | IDBKeyRange) => this.remove(store, tx, query)
        if (property === 'clear') return () => this.remove(store, tx)
        if (property === 'get')
          return (query: IDBValidKey | IDBKeyRange) =>
            this.guarded(tx, async () => {
              const value = await store.get(query)
              return value === undefined ? undefined : await hydratePackedIdbRow(tx, metadata(value, store.name), true)
            })
        if (property === 'getAll')
          return (query?: IDBValidKey | IDBKeyRange | null, count?: number) => this.all(store, store, tx, query, count)
        if (property === 'getAllKeys')
          return (query?: IDBValidKey | IDBKeyRange | null, count?: number) => this.keys(store, tx, query, count)
        if (property === 'openKeyCursor')
          return (query?: IDBValidKey | IDBKeyRange | null, direction?: IDBCursorDirection) =>
            this.guarded(tx, async () =>
              this.keyCursor(await store.openKeyCursor(query, direction), store, tx, wrapper)
            )
        if (property === 'openCursor')
          return (query?: IDBValidKey | IDBKeyRange | null, direction?: IDBCursorDirection) =>
            this.guarded(tx, async () => this.cursor(await store.openCursor(query, direction), store, tx, wrapper))
        return boundMethod(store, property)
      }
    })
  }
  private index(
    target: PackedIndex,
    store: PackedStore,
    tx: PackedIdbTransaction,
    wrapper: PackedIdbTransaction
  ): PackedIndex {
    return new Proxy(target, {
      get: (index, property) => {
        if (property === 'objectStore') return this.store(store, tx, wrapper)
        if (property === 'iterate' || property === Symbol.asyncIterator)
          return () => {
            throw new Error('Packed IndexedDB iteration uses explicit bounded cursors')
          }
        if (property === 'get')
          return (query: IDBValidKey | IDBKeyRange) =>
            this.guarded(tx, async () => {
              const value = await index.get(query)
              return value === undefined ? undefined : await hydratePackedIdbRow(tx, metadata(value, store.name), true)
            })
        if (property === 'getAll')
          return (query?: IDBValidKey | IDBKeyRange | null, count?: number) => this.all(index, store, tx, query, count)
        if (property === 'getAllKeys')
          return (query?: IDBValidKey | IDBKeyRange | null, count?: number) => this.keys(index, tx, query, count)
        if (property === 'openKeyCursor')
          return (query?: IDBValidKey | IDBKeyRange | null, direction?: IDBCursorDirection) =>
            this.guarded(tx, async () =>
              this.keyCursor(await index.openKeyCursor(query, direction), store, tx, wrapper)
            )
        if (property === 'openCursor')
          return (query?: IDBValidKey | IDBKeyRange | null, direction?: IDBCursorDirection) =>
            this.guarded(tx, async () => this.cursor(await index.openCursor(query, direction), store, tx, wrapper))
        return boundMethod(index, property)
      }
    })
  }
  private async keys(
    source: PackedStore | PackedIndex,
    tx: PackedIdbTransaction,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number
  ): Promise<IDBValidKey[]> {
    return await this.guarded(tx, async () => {
      if (count !== undefined && (!Number.isSafeInteger(count) || count < 1 || count > 256)) packedIdbInvalid()
      const result: IDBValidKey[] = []
      let cursor = await source.openKeyCursor(query)
      while (cursor !== null && result.length < (count ?? 256)) {
        result.push(packedIdbKey(cursor.primaryKey))
        cursor = await cursor.continue()
      }
      if (count === undefined && cursor !== null)
        throw new SnapshotResourceLimitError('Packed IndexedDB key lists require bounded paging')
      return result
    })
  }
  private keyCursor(
    target: PackedKeyCursor | null,
    store: PackedStore,
    tx: PackedIdbTransaction,
    wrapper: PackedIdbTransaction
  ): PackedKeyCursor | null {
    if (target === null) return null
    return new Proxy(target, {
      get: (cursor, property) => {
        if (property === 'source')
          return 'objectStore' in cursor.source && 'unique' in cursor.source && 'multiEntry' in cursor.source
            ? this.index(cursor.source as unknown as PackedIndex, store, tx, wrapper)
            : this.store(store, tx, wrapper)
        if (property === 'delete') return () => this.remove(store, tx, cursor.primaryKey)
        if (property === 'continue')
          return (key?: IDBValidKey) =>
            this.guarded(tx, async () => this.keyCursor(await cursor.continue(key), store, tx, wrapper))
        if (property === 'advance')
          return (count: number) =>
            this.guarded(tx, async () => this.keyCursor(await cursor.advance(count), store, tx, wrapper))
        if (property === 'continuePrimaryKey')
          return (key: IDBValidKey, primaryKey: IDBValidKey) =>
            this.guarded(tx, async () =>
              this.keyCursor(await cursor.continuePrimaryKey(key, primaryKey), store, tx, wrapper)
            )
        return boundMethod(cursor, property)
      }
    })
  }
  private async all(
    source: PackedStore | PackedIndex,
    store: PackedStore,
    tx: PackedIdbTransaction,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number
  ): Promise<Array<Record<string, unknown>>> {
    return await this.guarded(tx, async () => {
      if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) packedIdbInvalid()
      const rows: PackedIdbRow[] = [],
        maximum = count ?? 256
      let cursor = await source.openCursor(query),
        allocation = 0
      while (cursor !== null && rows.length < maximum) {
        if (rows.length >= 256) throw new SnapshotResourceLimitError('Packed IndexedDB getAll requires bounded paging')
        const row = metadata(cursor.value, store.name)
        allocation += packedIdbRowAllocation(row, true)
        if (allocation > packedIdbAllocationBytes)
          throw new SnapshotResourceLimitError('Packed IndexedDB getAll allocation exceeded')
        rows.push(row)
        cursor = await cursor.continue()
      }
      if (count === undefined && cursor !== null)
        throw new SnapshotResourceLimitError('Packed IndexedDB getAll requires bounded paging')
      const result: Array<Record<string, unknown>> = []
      for (const row of rows) result.push(await hydratePackedIdbRow(tx, row, true))
      return result
    })
  }
  private async cursor(
    target: PackedCursor | null,
    store: PackedStore,
    tx: PackedIdbTransaction,
    wrapper: PackedIdbTransaction
  ): Promise<PackedCursor | null> {
    if (target === null) return null
    const value = await hydratePackedIdbRow(tx, metadata(target.value, store.name), true)
    return new Proxy(target, {
      get: (cursor, property) => {
        if (property === 'value') return value
        if (property === 'source')
          return 'objectStore' in cursor.source && 'unique' in cursor.source && 'multiEntry' in cursor.source
            ? this.index(cursor.source as unknown as PackedIndex, store, tx, wrapper)
            : this.store(store, tx, wrapper)
        if (property === 'update')
          return (row: unknown) => this.write(store, tx, row, false, undefined, cursor.primaryKey)
        if (property === 'delete') return () => this.remove(store, tx, cursor.primaryKey)
        if (property === 'continue')
          return (key?: IDBValidKey) =>
            this.guarded(tx, async () => this.cursor(await cursor.continue(key), store, tx, wrapper))
        if (property === 'advance')
          return (count: number) =>
            this.guarded(tx, async () => this.cursor(await cursor.advance(count), store, tx, wrapper))
        if (property === 'continuePrimaryKey')
          return (key: IDBValidKey, primaryKey: IDBValidKey) =>
            this.guarded(tx, async () =>
              this.cursor(await cursor.continuePrimaryKey(key, primaryKey), store, tx, wrapper)
            )
        return boundMethod(cursor, property)
      }
    })
  }
}
