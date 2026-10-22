import { awaitFromSync, mapAwaitFromSync } from '../../utility/promiseFromSync'
import { getPackedIdbConnection, type PackedIdbConnection } from '../idbPackedConnection'
import {
  chargePackedIdb,
  readPackedIdbClock,
  retainPackedIdbFields,
  unpackPackedIdbMetadata,
  packedIdbRowMetadataEqual,
  packedIdbMarker,
  packedIdbStores,
  checkPackedIdbContent,
  readPackedIdbExtent,
  type PackedIdbField,
  type PackedIdbClock,
  type PackedIdbTransaction
} from '../idbPackedFields'
import {
  packedIdbKey,
  packedIdbReferences,
  packedIdbVersionCharge,
  packedIdbPortableKey,
  packedIdbReplicaKey,
  verifyPackedIdbReferences
} from '../idbPackedFields'
import { attachPackedIdbStages, type PackedIdbStagedField } from '../idbPackedStaging'
import { idbImportJournalStores, verifyIdbImportJournalSchema } from '../idbImportJournalSchema'
import { brc38StageTables, type Brc38StageTable } from './Brc38SemanticStage'
import {
  admissionCopy,
  boundedJson,
  decodeReceipt,
  digest,
  integer,
  invalid,
  isSha,
  mappingCapacity,
  read as readReceipt,
  stepCopy,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalReceipt,
  type Brc38ImportJournalStep,
  type StoredReceipt
} from './Brc38ImportJournalContract'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { brc38JsonBinaryField } from './Brc38JsonBinaryFields'
import { brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { brc38JsonTextField } from './Brc38JsonTextFields'
import { brc38Utf8ByteLength } from './Brc38Utf8Length'
import { brc38IdbRestoreStore } from './Brc38IdbRestoreMetadata'
import { collectPackedIdb } from '../idbPackedSnapshot'
import { readBrc38IdbRestorePublication, type Brc38IdbRestorePublication } from './Brc38IdbRestorePublication'

const walletStores = Object.freeze([
  'settings',
  'users',
  'proven_txs',
  'output_baskets',
  'output_tags',
  'tx_labels',
  'transactions',
  'outputs',
  'tx_labels_map',
  'output_tags_map',
  'certificates',
  'certificate_fields',
  'commissions',
  'proven_tx_reqs',
  'sync_states',
  'action_batches',
  'action_batch_outputs',
  'action_batch_blobs',
  'monitor_events'
])
const entities = Object.freeze([
  'provenTx',
  'outputBasket',
  'outputTag',
  'txLabel',
  'transaction',
  'output',
  'certificate',
  'commission',
  'provenTxReq',
  'txLabelMap',
  'outputTagMap',
  'certificateField'
] as const)
export type Brc38IdbImportEntity = (typeof entities)[number]
export interface Brc38IdbImportMappingRequest {
  readonly entity: Brc38IdbImportEntity
  readonly incomingId: number
  readonly required: boolean
}
export interface Brc38IdbImportMappingRead {
  /** A checksum of current checkpoint DATA, not an authentication grant. */
  readonly receiptSha256: string
  readonly mappings: readonly Readonly<{ entity: Brc38IdbImportEntity; incomingId: number; localId?: number }>[]
  /** Release the original allocation only after the caller drops these data. */
  close(): void
}
export interface Brc38IdbImportOriginalRead {
  readonly payload: string
  readonly bytes: number
  readonly sha256: string
  readonly fields: Readonly<Record<string, Readonly<PackedIdbField>>>
  /** Current native row coordinate DATA, recorded in the same writer. */
  readonly destinationKey?: IDBValidKey
  close(): void
}
export interface Brc38IdbImportDestinationRead {
  readonly key: IDBValidKey
  readonly fields: Readonly<Record<string, unknown>>
  readonly extents: Readonly<Record<string, Readonly<PackedIdbField>>>
  close(): void
}
export interface Brc38IdbPackedVersionRead {
  readonly position: IDBValidKey
  readonly store: string
  readonly key: IDBValidKey
  readonly revision: number
  readonly obsoleteAt?: number
  readonly deleted: boolean
  readonly charge: number
  readonly references: number
  close(): void
}
export interface Brc38IdbPackedContentRead {
  readonly field: Readonly<PackedIdbField>
  readonly references: number
  readonly chunks: number
  close(): void
}
export interface Brc38IdbRestoreCoordinates {
  readonly epoch: string
  readonly revision: number
  readonly logicalBytes: number
  readonly records: number
  readonly contents: number
  readonly chunks: number
  readonly versions: number
  readonly heads: number
}
export interface Brc38IdbImportProfile {
  readonly chain: 'main' | 'test'
  readonly identityKey: string
  readonly targetStorageIdentityKey: string
}
export interface Brc38IdbImportJournalOptions {
  readonly profile: Brc38IdbImportProfile
  /** Logical original-row budget, separately charged to the packed provider.
   * It is fixed before I/O and cannot grow when the journal is resumed. */
  readonly maximumOriginalLogicalBytes: number
  readonly maximumOriginalRowBytes: number
  readonly workingAllocation?: Brc38WorkingAllocation
  readonly signal?: AbortSignal
  /** Explicit completed-transition readback only. Ordinary import/expired
   * cleanup still requires inactivity; this never supplies authentication. */
  readonly allowActivatedProfile?: boolean
}
export interface Brc38IdbImportWriter {
  /** The genuine normal observed provider transaction. All row effects must
   * use this token, including staged-field attachments. */
  readonly transaction: PackedIdbTransaction<'readwrite'>
  lookup(entity: Brc38IdbImportEntity, incomingId: number): Promise<number | undefined>
  map(entity: Brc38IdbImportEntity, incomingId: number, localId: number): Promise<void>
  original(
    table: Brc38StageTable | 'header',
    index: number,
    payload: string,
    destinationKey?: IDBValidKey
  ): Promise<void>
  /** Small original metadata plus genuine large original content. References,
   * row effects, mappings and cursor share this actual native transaction.
   * The controller must independently authenticate and inventory provenance. */
  originalStreamed(
    table: Brc38StageTable,
    index: number,
    payload: string,
    fields: Readonly<Record<string, PackedIdbStagedField>>,
    destinationKey?: IDBValidKey
  ): Promise<void>
}
interface Entry extends StoredReceipt {
  epoch: string
  revision: number
  policyJson: string
  originalRows: number
  originalBytes: number
  publicationJson?: string
}
const issuer = Object.freeze({}),
  issued = new WeakSet<Brc38IdbImportJournal>()
function incoming(entity: string, id: number): string {
  if (!entities.some(value => value === entity) || !Number.isInteger(id)) invalid()
  const key = String(id)
  if (key.length > 32) invalid()
  return key
}
function utf8Bytes(value: string, maximum: number): number {
  if (typeof value !== 'string' || value.length > maximum) invalid()
  const bytes = new TextEncoder().encode(value).byteLength
  if (bytes > maximum) invalid()
  return bytes
}
function destinationJson(selected: IDBValidKey | undefined): string | undefined {
  if (selected === undefined) return undefined
  const json = JSON.stringify(packedIdbKey(selected))
  utf8Bytes(json, 1024)
  return json
}
function destinationKey(json: unknown): IDBValidKey {
  if (typeof json !== 'string') invalid()
  utf8Bytes(json, 1024)
  const key = packedIdbKey(JSON.parse(json))
  if (JSON.stringify(key) !== json) invalid()
  return key
}
function destinationCharge(json: unknown): number {
  if (json === undefined) return 0
  destinationKey(json)
  return 256 + brc38Utf8ByteLength(json as string)
}
function samePackedMetadata(first: unknown, second: unknown): void {
  if (!packedIdbRowMetadataEqual(unpackPackedIdbMetadata(first), unpackPackedIdbMetadata(second))) invalid()
}

/** Actual isolated IndexedDB checkpoint component. Prepared effects, mappings,
 * original rows and next cursor commit in ONE native provider transaction.
 * The factory enrolls only a genuine packed connection to the new restore
 * namespace; every operation independently checks current schema, profile,
 * epoch/revision, quota and original expiry. Checkpoints/hashes are DATA.
 * Source authentication, semantic replay, complete destination inventory and
 * manager activation remain separate mandatory owners; this is not a grant. */
export class Brc38IdbImportJournal {
  readonly #owner: PackedIdbConnection
  readonly admission: Readonly<Brc38ImportJournalAdmission>
  readonly #profile: Readonly<Brc38IdbImportProfile>
  readonly #policyJson: string
  readonly #maximumOriginalBytes: number
  readonly #maximumOriginalRowBytes: number
  readonly #working?: Brc38WorkingAllocation
  readonly #signal?: AbortSignal
  readonly #deadline: number
  readonly #allowActivatedProfile: boolean
  #open = true
  #busy = false
  #active: Promise<unknown> = Promise.resolve()
  #cleanup?: Brc38StagingCleanupError
  private constructor(
    token: object,
    owner: PackedIdbConnection,
    admission: Brc38ImportJournalAdmission,
    options: Brc38IdbImportJournalOptions
  ) {
    if (token !== issuer || getPackedIdbConnection(owner.database) !== owner) invalid()
    this.#owner = owner
    this.admission = admissionCopy(admission)
    const profile = Object.freeze({
      chain: options.profile.chain,
      identityKey: options.profile.identityKey,
      targetStorageIdentityKey: options.profile.targetStorageIdentityKey
    })
    if (!['main', 'test'].includes(profile.chain)) invalid()
    for (const text of [profile.identityKey, profile.targetStorageIdentityKey]) if (utf8Bytes(text, 256) < 1) invalid()
    integer(this.admission.scope.userId, 1, Number.MAX_SAFE_INTEGER)
    integer(options.maximumOriginalLogicalBytes, 4096, 17179869184)
    integer(options.maximumOriginalRowBytes, 1, Math.min(this.admission.maximumStepBytes, 1048576))
    this.#working = brc38WorkingAllocation(options.workingAllocation)
    const original: unknown = JSON.parse(this.admission.originalLimitsJson)
    if (
      !Array.isArray(original) ||
      (this.#working !== undefined && this.#working.maximum > Number(original[4])) ||
      options.maximumOriginalLogicalBytes > Number(original[1]) ||
      options.maximumOriginalRowBytes > Number(original[3])
    )
      invalid()
    this.#profile = profile
    this.#maximumOriginalBytes = options.maximumOriginalLogicalBytes
    this.#maximumOriginalRowBytes = options.maximumOriginalRowBytes
    this.#policyJson = boundedJson({
      profile,
      maximumOriginalLogicalBytes: this.#maximumOriginalBytes,
      maximumOriginalRowBytes: this.#maximumOriginalRowBytes
    })
    this.#signal = options.signal
    if (options.allowActivatedProfile !== undefined && typeof options.allowActivatedProfile !== 'boolean') invalid()
    this.#allowActivatedProfile = options.allowActivatedProfile === true
    this.#deadline = performance.now() + Math.max(0, this.admission.expiresAt - Date.now())
    issued.add(this)
  }
  static async open(
    owner: PackedIdbConnection,
    selected: Brc38ImportJournalAdmission,
    options: Brc38IdbImportJournalOptions
  ): Promise<Brc38IdbImportJournal> {
    // Capture every input before the first asynchronous boundary.
    const journal = new Brc38IdbImportJournal(issuer, owner, selected, options)
    await journal.#run('readonly', async (_wallet, tx, clock) => {
      const entry = await tx.objectStore(idbImportJournalStores.journal).get(1)
      if (entry !== undefined) await journal.#entry(tx, clock, entry)
      else if (
        (await tx.objectStore(idbImportJournalStores.journal).count()) !== 0 ||
        (await tx.objectStore(idbImportJournalStores.ids).count()) !== 0 ||
        (await tx.objectStore(idbImportJournalStores.originals).count()) !== 0
      )
        invalid()
    })
    return journal
  }
  /** Expired unfinished isolated imports only. This never admits a source,
   * renews a deadline or enables ordinary reads/writes/activation. COMPLETE
   * imports retain provenance and must use their separate profile lifecycle. */
  static async openExpiredCleanup(
    owner: PackedIdbConnection,
    selected: Brc38ImportJournalAdmission,
    options: Brc38IdbImportJournalOptions
  ): Promise<Brc38IdbImportJournal> {
    const journal = new Brc38IdbImportJournal(issuer, owner, selected, options)
    await journal.#run(
      'readonly',
      async (_wallet, tx, clock) => {
        const { receipt } = await journal.#load(tx, clock)
        if (receipt.state === 'COMPLETE' || receipt.nextRow >= journal.admission.totalRows) invalid()
      },
      true
    )
    return journal
  }
  #check(): void {
    if (!issued.has(this) || !this.#open || getPackedIdbConnection(this.#owner.database) !== this.#owner) invalid()
    this.#owner.assertOpen()
    this.#signal?.throwIfAborted()
    if (Date.now() >= this.admission.expiresAt || performance.now() >= this.#deadline)
      throw new SnapshotResourceLimitError('IndexedDB import original admission expired')
  }
  #cleanupCheck(): void {
    if (!issued.has(this) || !this.#open || getPackedIdbConnection(this.#owner.database) !== this.#owner) invalid()
    this.#owner.assertOpen()
    if (Date.now() < this.admission.expiresAt && performance.now() < this.#deadline)
      throw new Error('IndexedDB unfinished original cleanup requires actual original expiry')
  }
  async #current(wallet: PackedIdbTransaction, tx: PackedIdbTransaction, cleanupOnly = false): Promise<PackedIdbClock> {
    if (cleanupOnly) this.#cleanupCheck()
    else this.#check()
    verifyIdbImportJournalSchema(tx)
    if (!tx.db.name.startsWith(`wallet-toolbox-${this.#profile.chain}net-restore-v1-`)) invalid()
    const clock = await readPackedIdbClock(tx)
    if ((await wallet.objectStore('settings').count()) !== 1 || (await wallet.objectStore('users').count()) > 1)
      invalid()
    const settings = await wallet.objectStore('settings').openCursor(),
      user = await wallet.objectStore('users').openCursor()
    if (
      settings === null ||
      settings.value.chain !== this.#profile.chain ||
      settings.value.storageIdentityKey !== this.#profile.targetStorageIdentityKey ||
      (user !== null &&
        (user.value.userId !== this.admission.scope.userId || user.value.identityKey !== this.#profile.identityKey))
    )
      invalid()
    const entry = await tx.objectStore(idbImportJournalStores.journal).get(1),
      publication = entry === undefined ? undefined : this.#publication(entry as unknown as Entry, clock)
    if (
      publication !== undefined &&
      (user === null ||
        user.value.activeStorage !== (publication.state === 'ACTIVATED' ? this.#profile.targetStorageIdentityKey : ''))
    )
      invalid()
    if (
      user !== null &&
      user.value.activeStorage !== '' &&
      (cleanupOnly || !this.#allowActivatedProfile || publication?.state !== 'ACTIVATED')
    )
      invalid()
    if (cleanupOnly) this.#cleanupCheck()
    else this.#check()
    return clock
  }
  async #run<T, Mode extends 'readonly' | 'readwrite'>(
    mode: Mode,
    work: (
      wallet: PackedIdbTransaction<Mode>,
      journal: PackedIdbTransaction<Mode>,
      clock: PackedIdbClock
    ) => Promise<T>,
    cleanupOnly = false
  ): Promise<T> {
    if (cleanupOnly) this.#cleanupCheck()
    else this.#check()
    if (this.#busy) throw new Error('IndexedDB import already owns a checkpoint operation')
    // Includes bounded clone/hash/parse scratch for the fixed journal cell.
    // This models owned JS buffers; it is not a browser physical-memory proof.
    const scratch = this.#working?.claim(
      8192 + 16 * (utf8Bytes(boundedJson(this.admission), 4096) + 1024 + utf8Bytes(this.#policyJson, 4096))
    )
    this.#busy = true
    let retained = false
    const operation = (async () => {
      const { wallet, journal } = this.#owner.restoreTransaction(walletStores, mode)
      let completed = false,
        timer: ReturnType<typeof setTimeout> | undefined,
        rejectStop!: (cause: unknown) => void
      const stop = new Promise<never>((_resolve, reject) => {
          rejectStop = reject
        }),
        abort = () => {
          try {
            journal.abort()
          } catch {
            /* settled */
          }
          rejectStop(this.#signal?.reason ?? new SnapshotResourceLimitError('IndexedDB import operation stopped'))
        },
        workDone = Promise.resolve().then(
          async () => await work(wallet, journal, await this.#current(wallet, journal, cleanupOnly))
        )
      void workDone.then(
        () => {
          completed = true
        },
        () => {
          completed = true
        }
      )
      void workDone.catch(() => undefined)
      const premature = journal.done.then(
        () => {
          if (!completed) throw new Error('IndexedDB import writer settled before preparation completed')
          return workDone
        },
        cause => {
          throw cause
        }
      )
      // No asynchronous source/network/KDF callback may keep a short native
      // writer indefinitely. Late private work loses this actor immediately;
      // its original allocation stays held until that work actually drains.
      timer = setTimeout(
        abort,
        cleanupOnly
          ? 30000
          : Math.max(1, Math.min(30000, this.admission.expiresAt - Date.now(), this.#deadline - performance.now()))
      )
      if (!cleanupOnly) this.#signal?.addEventListener('abort', abort, { once: true })
      const drain = async () => {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            workDone.then(
              () => undefined,
              () => undefined
            ),
            new Promise<never>((_resolve, reject) => {
              cleanupTimer = setTimeout(
                () => reject(new Error('IndexedDB import private callback drain remains')),
                30000
              )
            })
          ])
          await journal.done.catch(() => undefined)
          scratch?.close()
          this.#busy = false
          this.#cleanup = undefined
        } finally {
          if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
        }
      }
      try {
        const value = await Promise.race([workDone, stop, premature])
        await this.#owner.sealRestoreEffects(wallet)
        if (cleanupOnly) this.#cleanupCheck()
        else this.#check()
        verifyIdbImportJournalSchema(journal)
        await journal.done
        if (cleanupOnly) this.#cleanupCheck()
        else this.#check()
        return value
      } catch (cause) {
        this.#owner.abandonRestoreEffects(wallet)
        try {
          journal.abort()
        } catch {
          /* already settled */
        }
        await journal.done.catch(() => undefined)
        if (!completed) {
          this.#open = false
          try {
            await drain()
          } catch (error_) {
            retained = true
            this.#cleanup = new Brc38StagingCleanupError(
              [cause, error_],
              'IndexedDB import retains its private callback and original allocation until drainage',
              drain
            )
            throw this.#cleanup
          }
        }
        throw cause
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        this.#signal?.removeEventListener('abort', abort)
      }
    })()
    this.#active = operation
    try {
      return await operation
    } finally {
      if (!retained) {
        this.#busy = false
        scratch?.close()
      }
    }
  }
  async #entry(
    tx: PackedIdbTransaction,
    clock: PackedIdbClock,
    value: Record<string, unknown>
  ): Promise<{ entry: Entry; receipt: Readonly<Brc38ImportJournalReceipt> }> {
    const entry = value as unknown as Entry
    boundedJson(entry)
    if (
      entry.epoch !== clock.epoch ||
      entry.revision !== clock.revision ||
      entry.policyJson !== this.#policyJson ||
      (await tx.objectStore(idbImportJournalStores.journal).count()) !== 1
    )
      invalid()
    integer(entry.originalRows, 0, this.admission.totalRows)
    integer(entry.originalBytes, 0, this.#maximumOriginalBytes)
    if (typeof entry.receiptJson !== 'string') invalid()
    utf8Bytes(entry.receiptJson, 1024)
    const receipt = readReceipt(entry, this.admission)
    const publication = this.#publication(entry, clock)
    if (
      publication !== undefined &&
      (receipt.state !== 'COMPLETE' ||
        receipt.nextRow !== this.admission.totalRows ||
        entry.originalRows !== receipt.nextRow)
    )
      invalid()
    if (
      (await tx.objectStore(idbImportJournalStores.ids).count()) !== receipt.mappedIds ||
      (await tx.objectStore(idbImportJournalStores.originals).count()) !== entry.originalRows
    )
      invalid()
    return { entry, receipt }
  }
  #publication(entry: Entry, clock: PackedIdbClock): Readonly<Brc38IdbRestorePublication> | undefined {
    if (entry.publicationJson === undefined) return undefined
    const value = readBrc38IdbRestorePublication(entry.publicationJson)
    if (
      value.databaseName !== this.#owner.database.name ||
      value.importId !== this.admission.scope.importId ||
      value.previewId !== this.admission.previewId ||
      value.bindingSha256 !== this.admission.scope.bindingSha256 ||
      value.archiveSha256 !== this.admission.scope.archiveSha256 ||
      value.identityKey !== this.#profile.identityKey ||
      value.chain !== this.#profile.chain ||
      value.targetStorageIdentityKey !== this.#profile.targetStorageIdentityKey ||
      value.epoch !== clock.epoch ||
      value.publishedAt >= this.admission.expiresAt ||
      (value.state === 'PUBLISHED' ? value.publishedRevision : value.activatedRevision) !== clock.revision ||
      (value.activatedAt !== undefined && value.activatedAt >= this.admission.expiresAt)
    )
      invalid()
    return value
  }
  async #load(tx: PackedIdbTransaction, clock: PackedIdbClock) {
    const value = await tx.objectStore(idbImportJournalStores.journal).get(1)
    if (value === undefined) invalid()
    return await this.#entry(tx, clock, value)
  }
  prepare(actualDestinationSha256: string): Promise<Readonly<Brc38ImportJournalReceipt>> {
    return awaitFromSync(() => {
      if (!isSha(actualDestinationSha256)) invalid()
      return this.#run('readwrite', async (wallet, tx, clock) => {
        const value = await tx.objectStore(idbImportJournalStores.journal).get(1)
        if (value !== undefined) {
          const { receipt } = await this.#entry(tx, clock, value)
          if (receipt.state === 'EXPIRED' || receipt.destinationSha256 !== actualDestinationSha256) invalid()
          return receipt
        }
        if (
          actualDestinationSha256 !== this.admission.initialDestinationSha256 ||
          (await tx.objectStore(idbImportJournalStores.journal).count()) !== 0 ||
          (await tx.objectStore(idbImportJournalStores.ids).count()) !== 0 ||
          (await tx.objectStore(idbImportJournalStores.originals).count()) !== 0
        )
          invalid()
        for (const store of walletStores)
          if (store !== 'settings' && (await wallet.objectStore(store).count()) !== 0) invalid()
        const receipt: Brc38ImportJournalReceipt = Object.freeze({
            protocol: 'brc38-destination-import/v1',
            state: this.admission.totalRows === 0 ? 'COMPLETE' : 'PREPARED',
            sequence: 0,
            nextRow: 0,
            mappedIds: 0,
            logicalBytes: 4096,
            destinationSha256: actualDestinationSha256,
            lastStep: null
          }),
          admissionJson = boundedJson(this.admission),
          receiptJson = boundedJson(receipt),
          entry: Entry = {
            bindingSha256: this.admission.scope.bindingSha256,
            archiveSha256: this.admission.scope.archiveSha256,
            userId: this.admission.scope.userId,
            mappedIds: 0,
            maximumMappedIds: mappingCapacity(this.admission),
            cleanupAllowed: 0,
            admissionJson,
            admissionSha256: digest(admissionJson),
            receiptJson,
            receiptSha256: digest(receiptJson),
            epoch: clock.epoch,
            revision: clock.revision,
            policyJson: this.#policyJson,
            originalRows: 0,
            originalBytes: 0
          }
        decodeReceipt(receiptJson, this.admission)
        boundedJson(entry)
        await chargePackedIdb(tx, 4096, 1)
        await tx.objectStore(idbImportJournalStores.journal).add(entry as unknown as Record<string, unknown>, 1)
        return receipt
      })
    })
  }
  read(): Promise<Readonly<Brc38ImportJournalReceipt>> {
    return awaitFromSync(() => {
      return this.#run('readonly', async (_wallet, tx, clock) => (await this.#load(tx, clock)).receipt)
    })
  }
  readExisting(): Promise<Readonly<Brc38ImportJournalReceipt> | undefined> {
    return awaitFromSync(() => {
      return this.#run('readonly', async (_wallet, tx, clock) => {
        const value = await tx.objectStore(idbImportJournalStores.journal).get(1)
        if (value !== undefined) return (await this.#entry(tx, clock, value)).receipt
        for (const store of Object.values(idbImportJournalStores))
          if ((await tx.objectStore(store).count()) !== 0) invalid()
        return undefined
      })
    })
  }
  readPublication(expectedReceiptSha256: string): Promise<Readonly<Brc38IdbRestorePublication> | undefined> {
    return awaitFromSync(() => {
      if (!isSha(expectedReceiptSha256)) invalid()
      return this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry } = await this.#load(tx, clock)
        if (entry.receiptSha256 !== expectedReceiptSha256) invalid()
        return this.#publication(entry, clock)
      })
    })
  }
  #coordinates(selected: Brc38IdbRestoreCoordinates): Readonly<Brc38IdbRestoreCoordinates> {
    const value = Object.freeze({
      epoch: selected.epoch,
      revision: selected.revision,
      logicalBytes: selected.logicalBytes,
      records: selected.records,
      contents: selected.contents,
      chunks: selected.chunks,
      versions: selected.versions,
      heads: selected.heads
    })
    if (typeof value.epoch !== 'string' || !/^[0-9a-f]{32}$/.test(value.epoch)) invalid()
    for (const name of ['revision', 'logicalBytes', 'records', 'contents', 'chunks', 'versions', 'heads'] as const)
      integer(value[name], name === 'revision' ? 1 : 0, Number.MAX_SAFE_INTEGER)
    return value
  }
  async #sameCoordinates(
    tx: PackedIdbTransaction,
    clock: PackedIdbClock,
    expected: Brc38IdbRestoreCoordinates
  ): Promise<void> {
    if (
      clock.epoch !== expected.epoch ||
      clock.revision !== expected.revision ||
      clock.bytes !== expected.logicalBytes ||
      clock.records !== expected.records ||
      expected.versions !== expected.heads
    )
      invalid()
    for (const name of ['contents', 'chunks', 'versions', 'heads'] as const)
      if ((await tx.objectStore(packedIdbStores[name]).count()) !== expected[name]) invalid()
    for (const name of ['leases', 'jsonStages', 'jsonMembers'] as const)
      if ((await tx.objectStore(packedIdbStores[name]).count()) !== 0) invalid()
    if (
      (await tx.objectStore(packedIdbStores.contents).index('retired').count(1)) !== 0 ||
      (await tx.objectStore(packedIdbStores.contents).index('expiresAt').count(IDBKeyRange.upperBound(Date.now()))) !==
        0 ||
      (await tx
        .objectStore(packedIdbStores.versions)
        .index('obsoleteAt')
        .count(IDBKeyRange.upperBound(clock.revision))) !== 0
    )
      invalid()
  }
  async #transitionAllocation<T>(work: () => Promise<T>): Promise<T> {
    this.#check()
    if (this.#working === undefined) invalid()
    const allowance = this.#working.claim(16384 + 32 * 65536)
    let retained = false
    try {
      return await work()
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'Browser publication retains actual native metadata through drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                allowance.close()
              }
            )
        )
      }
      throw cause
    } finally {
      if (!retained) allowance.close()
    }
  }
  /** Short durable publication only. Enclosing actual controller must freshly
   * authenticate the complete source and inspect proofs/all rows/references.
   * Coordinates are a compare-and-swap on current data, not that inspection. */
  publishCurrent(
    expectedReceiptSha256: string,
    selected: Brc38IdbRestoreCoordinates
  ): Promise<Readonly<Brc38IdbRestorePublication>> {
    return awaitFromSync(() => {
      const coordinates = this.#coordinates(selected)
      if (!isSha(expectedReceiptSha256)) invalid()
      return this.#transitionAllocation(
        async () =>
          await this.#run('readwrite', async (_wallet, tx, clock) => {
            const { entry, receipt } = await this.#load(tx, clock)
            if (receipt.state !== 'COMPLETE' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
            await this.#sameCoordinates(tx, clock, coordinates)
            const existing = this.#publication(entry, clock)
            if (existing !== undefined) return existing
            const publication: Brc38IdbRestorePublication = {
                protocol: 'brc38-idb-profile-publication/v1',
                state: 'PUBLISHED',
                databaseName: this.#owner.database.name,
                importId: this.admission.scope.importId,
                previewId: this.admission.previewId,
                bindingSha256: this.admission.scope.bindingSha256,
                archiveSha256: this.admission.scope.archiveSha256,
                identityKey: this.#profile.identityKey,
                chain: this.#profile.chain,
                targetStorageIdentityKey: this.#profile.targetStorageIdentityKey,
                epoch: clock.epoch,
                publishedRevision: clock.revision,
                publishedAt: Date.now()
              },
              publicationJson = boundedJson(publication),
              next = { ...entry, publicationJson }
            readBrc38IdbRestorePublication(publicationJson)
            boundedJson(next)
            await tx.objectStore(idbImportJournalStores.journal).put(next, 1)
            return this.#publication(next, clock)!
          })
      )
    })
  }
  /** Atomic local activation: actual observed user mutation and transition
   * record share one native writer. Source/proof/inventory work is excluded
   * from this writer. Lost acknowledgement is read back without rewriting. */
  activatePublished(
    expectedReceiptSha256: string,
    selected: Brc38IdbRestoreCoordinates
  ): Promise<Readonly<Brc38IdbRestorePublication>> {
    return awaitFromSync(() => {
      const coordinates = this.#coordinates(selected)
      if (!this.#allowActivatedProfile || !isSha(expectedReceiptSha256) || this.#working === undefined) invalid()
      return this.#transitionAllocation(
        async () =>
          await this.#run('readwrite', async (wallet, tx, clock) => {
            const { entry, receipt } = await this.#load(tx, clock),
              publication = this.#publication(entry, clock)
            if (
              receipt.state !== 'COMPLETE' ||
              entry.receiptSha256 !== expectedReceiptSha256 ||
              publication === undefined
            )
              invalid()
            await this.#sameCoordinates(tx, clock, coordinates)
            if (publication.state === 'ACTIVATED') return publication
            const raw = await tx.objectStore('users').get(this.admission.scope.userId)
            if (raw === undefined) invalid()
            const user = unpackPackedIdbMetadata(raw)
            // User identity/selection/timestamps are bounded metadata, never an
            // arbitrary full hydrated row or a large field inside the short writer.
            if (
              Object.keys(user.extents).length !== 0 ||
              user.fields.identityKey !== this.#profile.identityKey ||
              user.fields.activeStorage !== ''
            )
              invalid()
            if (
              (await wallet
                .objectStore('users')
                .put({ ...user.fields, activeStorage: this.#profile.targetStorageIdentityKey })) !==
              this.admission.scope.userId
            )
              invalid()
            await this.#owner.sealRestoreEffects(wallet)
            const current = await readPackedIdbClock(tx)
            if (current.epoch !== clock.epoch || current.revision !== clock.revision + 1) invalid()
            const publicationJson = boundedJson({
                ...publication,
                state: 'ACTIVATED',
                activatedRevision: current.revision,
                activatedAt: Date.now()
              }),
              next = { ...entry, revision: current.revision, publicationJson }
            readBrc38IdbRestorePublication(publicationJson)
            boundedJson(next)
            await tx.objectStore(idbImportJournalStores.journal).put(next, 1)
            await this.#current(wallet, tx)
            return this.#publication(next, current)!
          })
      )
    })
  }
  /** Current empty-profile fingerprint DATA for an authenticated controller.
   * Actual empty rows/profile/schema/budget are checked again by prepare().
   * The native epoch/revision prevents another profile sharing this checksum. */
  emptyDestinationSha256(): Promise<string> {
    return awaitFromSync(() => {
      return this.#run('readonly', async (wallet, tx, clock) => {
        for (const store of walletStores)
          if (store !== 'settings' && (await tx.objectStore(store).count()) !== 0) invalid()
        for (const store of Object.values(idbImportJournalStores))
          if ((await tx.objectStore(store).count()) !== 0) invalid()
        const settings = await wallet.objectStore('settings').openCursor()
        if (settings === null) invalid()
        return digest(
          JSON.stringify(['browser-empty-restore/v1', this.#profile, clock.epoch, clock.revision, settings.value])
        )
      })
    })
  }
  /** The original live resource counter; it conveys no source admission. */
  get workingAllocation(): Brc38WorkingAllocation | undefined {
    return this.#working
  }
  /** Bounded preparation outside the wallet writer. Every batch opens an
   * actual native read transaction and rechecks profile/schema/epoch/revision
   * and the complete current receipt. No earlier batch admits this one. The
   * returned values remain charged while retained, including between batches.
   * The eventual writer must independently admit its current checkpoint. */
  async readMappings(
    expectedReceiptSha256: string,
    selected: readonly Brc38IdbImportMappingRequest[]
  ): Promise<Readonly<Brc38IdbImportMappingRead>> {
    this.#check()
    if (!isSha(expectedReceiptSha256) || !Array.isArray(selected) || selected.length > 128) invalid()
    const allowance = this.#working?.claim(4096 + 1024 * selected.length)
    try {
      const requests = selected.map(value => {
        const entity = value.entity,
          incomingId = value.incomingId,
          required = value.required
        incoming(entity, incomingId)
        if (typeof required !== 'boolean') invalid()
        return Object.freeze({ entity, incomingId, required })
      })
      const mappings = await this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const store = tx.objectStore(idbImportJournalStores.ids),
          result: Brc38IdbImportMappingRead['mappings'][number][] = []
        for (const request of requests) {
          this.#check()
          const key = incoming(request.entity, request.incomingId),
            value = await store.get([request.entity, key])
          this.#check()
          if (value === undefined) {
            if (request.required) throw new Error('IndexedDB import parent mapping is not committed')
            result.push(Object.freeze({ entity: request.entity, incomingId: request.incomingId }))
          } else {
            if (value.entity !== request.entity || value.incomingId !== key) invalid()
            integer(value.localId as number, 1, Number.MAX_SAFE_INTEGER)
            result.push(
              Object.freeze({
                entity: request.entity,
                incomingId: request.incomingId,
                localId: value.localId as number
              })
            )
          }
        }
        return Object.freeze(result)
      })
      return Object.freeze({ receiptSha256: expectedReceiptSha256, mappings, close: () => allowance?.close() })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError)
        throw new Brc38StagingCleanupError(
          [cause],
          'IndexedDB mapping read retains its original allocation until actual callback drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                allowance?.close()
              }
            )
        )
      allowance?.close()
      throw cause
    }
  }
  async #original(
    tx: PackedIdbTransaction,
    table: Brc38StageTable | 'header',
    index: number,
    allowance: Brc38WorkingCharge,
    cleanupOnly = false
  ): Promise<Omit<Brc38IdbImportOriginalRead, 'close'>> {
    const value = await tx.objectStore(idbImportJournalStores.originals).get([table, index])
    if (cleanupOnly) this.#cleanupCheck()
    else this.#check()
    if (
      value === undefined ||
      value.table !== table ||
      value.index !== index ||
      typeof value.payload !== 'string' ||
      value.payload.length > this.#maximumOriginalRowBytes ||
      !isSha(value.sha256) ||
      (value.fieldsJson !== undefined && (typeof value.fieldsJson !== 'string' || value.fieldsJson.length > 4096))
    )
      invalid()
    const bytes = brc38Utf8ByteLength(value.payload)
    if (bytes > this.#maximumOriginalRowBytes || value.bytes !== bytes) invalid()
    // The native clone was admitted before get. Resize before actual hash/parse;
    // dense field descriptors never inherit the earlier payload checksum.
    allowance.resize(16384 + 4 * this.#maximumOriginalRowBytes + 16 * 4096 + Math.max(4096 + 16 * bytes, 65536))
    if (digest(value.payload) !== value.sha256) invalid()
    let key: IDBValidKey | undefined
    if (value.destinationKeyJson !== undefined) {
      key = destinationKey(value.destinationKeyJson)
      if (
        (table === 'header' && key !== this.admission.scope.userId) ||
        (await tx.objectStore(brc38IdbRestoreStore(table)).getKey(key)) === undefined
      )
        invalid()
    }
    const fields: Record<string, Readonly<PackedIdbField>> = Object.create(null)
    if (value.fieldsJson !== undefined) {
      if (table === 'header') invalid()
      const decoded: unknown = JSON.parse(value.fieldsJson),
        row = unpackPackedIdbMetadata({ [packedIdbMarker]: decoded }),
        names = Object.keys(row.extents)
      if (names.length < 1 || names.length > 13) invalid()
      let extentBytes = 0
      for (const name of names) {
        const field = row.extents[name]
        if (
          !(
            brc38JsonBinaryField(table, name) ||
            brc38JsonStructuredField(table, name) ||
            brc38JsonTextField(table, name)
          ) ||
          ((brc38JsonStructuredField(table, name) || brc38JsonTextField(table, name)) && field.kind !== 'utf16') ||
          (brc38JsonBinaryField(table, name) && !['array', 'typed'].includes(field.kind))
        )
          invalid()
        const actual = await checkPackedIdbContent(tx, field)
        if (
          Number(actual.refs) < 1 ||
          actual.expiresAt !== undefined ||
          (await tx.objectStore(packedIdbStores.chunks).index('content').count(field.content)) !==
            Math.ceil(field.bytes / 65536)
        )
          invalid()
        if (cleanupOnly) this.#cleanupCheck()
        else this.#check()
        extentBytes += field.bytes
        fields[name] = Object.freeze({ ...field })
      }
      if (!Number.isSafeInteger(extentBytes) || value.extentBytes !== extentBytes) invalid()
    } else if (value.extentBytes !== undefined) invalid()
    verifyPackedIdbReferences(value.references, { extents: fields as Record<string, PackedIdbField> })
    return Object.freeze({
      payload: value.payload,
      bytes,
      sha256: value.sha256 as string,
      fields: Object.freeze(fields),
      ...(key === undefined ? {} : { destinationKey: key })
    })
  }
  async #head(
    tx: PackedIdbTransaction,
    store: string,
    key: IDBValidKey,
    actual: unknown,
    clock: PackedIdbClock
  ): Promise<void> {
    const head = await tx.objectStore(packedIdbStores.heads).get([store, key])
    if (
      head === undefined ||
      head.store !== store ||
      JSON.stringify(head.key) !== JSON.stringify(key) ||
      JSON.stringify(head.portableKey) !== JSON.stringify(packedIdbPortableKey(store, key)) ||
      JSON.stringify(head.replicaKey) !== JSON.stringify(packedIdbReplicaKey(store, key))
    )
      invalid()
    integer(head.revision as number, 1, clock.revision)
    const version = await tx.objectStore(packedIdbStores.versions).get([store, key, head.revision as number])
    if (
      version === undefined ||
      version.store !== store ||
      JSON.stringify(version.key) !== JSON.stringify(key) ||
      version.revision !== head.revision ||
      version.deleted !== false ||
      version.obsoleteAt !== undefined ||
      version.deletedAt !== undefined
    )
      invalid()
    const row = unpackPackedIdbMetadata(version.value)
    if (version.charge !== packedIdbVersionCharge(row)) invalid()
    verifyPackedIdbReferences(version.references, row)
    samePackedMetadata(actual, version.value)
    this.#check()
  }
  /** Bounded current provenance DATA for independent inventory. No semantic or
   * source authentication grant. Every call freshly checks actual journal,
   * originals, native content/ref state and field cardinality in one read. */
  async readOriginal(
    expectedReceiptSha256: string,
    table: Brc38StageTable | 'header',
    index: number
  ): Promise<Readonly<Brc38IdbImportOriginalRead>> {
    this.#check()
    if (
      !isSha(expectedReceiptSha256) ||
      (table !== 'header' && !brc38StageTables.includes(table)) ||
      this.#working === undefined
    )
      invalid()
    integer(index, 0, this.admission.totalRows)
    const allowance = this.#working.claim(16384 + 4 * this.#maximumOriginalRowBytes + 16 * 4096)
    try {
      const original = await this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        return await this.#original(tx, table, index, allowance)
      })
      allowance.resize(4096 + 4 * original.payload.length + 1024 * Object.keys(original.fields).length)
      return Object.freeze({ ...original, close: () => allowance.close() })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError)
        throw new Brc38StagingCleanupError(
          [cause],
          'IndexedDB original read retains its original allocation until actual callback drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                allowance.close()
              }
            )
        )
      allowance.close()
      throw cause
    }
  }
  /** Fresh native extent read by original coordinate. Supplied descriptors are
   * not accepted as admission; the current original record is loaded again.
   * The independent inventory must read/hash the complete field to EOF. */
  async readOriginalExtent(
    expectedReceiptSha256: string,
    table: Brc38StageTable,
    index: number,
    field: string,
    offset: number,
    length: number
  ): Promise<Uint8Array> {
    this.#check()
    if (
      !isSha(expectedReceiptSha256) ||
      !brc38StageTables.includes(table) ||
      this.#working === undefined ||
      !(
        brc38JsonBinaryField(table, field) ||
        brc38JsonStructuredField(table, field) ||
        brc38JsonTextField(table, field)
      )
    )
      invalid()
    integer(index, 0, this.admission.totalRows)
    integer(offset, 0, 1000000000)
    integer(length, 0, 65536)
    const metadata = this.#working.claim(16384 + 4 * this.#maximumOriginalRowBytes + 16 * 4096)
    let window: Brc38WorkingCharge | undefined
    let result: Uint8Array | undefined,
      retained = false
    try {
      window = this.#working.claim(8192 + 12 * 65536)
      return await this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const original = await this.#original(tx, table, index, metadata),
          descriptor = original.fields[field]
        if (descriptor === undefined || offset + length > descriptor.bytes) invalid()
        result = await readPackedIdbExtent(tx, descriptor, offset, length)
        this.#check()
        return result
      })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'IndexedDB original extent retains its native window and metadata until actual drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                result?.fill(0)
                window?.close()
                metadata.close()
              }
            )
        )
      }
      result?.fill(0)
      throw cause
    } finally {
      if (!retained) {
        window?.close()
        metadata.close()
      }
    }
  }
  /** The source coordinate resolves through CURRENT same-writer provenance;
   * no caller-provided destination key/descriptor or previous verdict is used.
   * Large fields remain native bounded extents, never hydrated here. */
  async readDestination(
    expectedReceiptSha256: string,
    table: Brc38StageTable | 'header',
    index: number
  ): Promise<Readonly<Brc38IdbImportDestinationRead>> {
    this.#check()
    if (
      !isSha(expectedReceiptSha256) ||
      (table !== 'header' && !brc38StageTables.includes(table)) ||
      this.#working === undefined
    )
      invalid()
    integer(index, 0, this.admission.totalRows)
    const metadata = this.#working.claim(16384 + 4 * this.#maximumOriginalRowBytes + 16 * 4096)
    let rowAllowance: Brc38WorkingCharge | undefined,
      retained = false,
      transferred = false
    try {
      rowAllowance = this.#working.claim(16384 + 32 * 65536)
      const result = await this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const original = await this.#original(tx, table, index, metadata),
          key = original.destinationKey
        if (key === undefined) throw new Error('IndexedDB original has no current same-writer destination coordinate')
        const value = await tx.objectStore(brc38IdbRestoreStore(table)).get(key)
        this.#check()
        if (value === undefined) invalid()
        await this.#head(tx, brc38IdbRestoreStore(table), key, value, clock)
        const row = unpackPackedIdbMetadata(value)
        for (const field of Object.values(row.extents)) {
          const actual = await checkPackedIdbContent(tx, field)
          if (
            Number(actual.refs) < 1 ||
            actual.expiresAt !== undefined ||
            (await tx.objectStore(packedIdbStores.chunks).index('content').count(field.content)) !==
              Math.ceil(field.bytes / 65536)
          )
            invalid()
          this.#check()
        }
        return Object.freeze({ key, fields: Object.freeze(row.fields), extents: Object.freeze(row.extents) })
      })
      metadata.close()
      // Scalar metadata is at most 64KiB, with <=128 admitted descriptors.
      rowAllowance.resize(8192 + 4 * 65536 + 1024 * Object.keys(result.extents).length)
      transferred = true
      return Object.freeze({ ...result, close: () => rowAllowance?.close() })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'IndexedDB destination inspection retains native metadata until actual drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                rowAllowance?.close()
                metadata.close()
              }
            )
        )
      }
      throw cause
    } finally {
      if (!retained) {
        metadata.close()
        if (!transferred) rowAllowance?.close()
      }
    }
  }
  /** Every range independently resolves its current original/native row and
   * content. The inventory owner must additionally hash the entire field EOF. */
  async readDestinationExtent(
    expectedReceiptSha256: string,
    table: Brc38StageTable | 'header',
    index: number,
    field: string,
    offset: number,
    length: number
  ): Promise<Uint8Array> {
    this.#check()
    if (
      !isSha(expectedReceiptSha256) ||
      (table !== 'header' && !brc38StageTables.includes(table)) ||
      this.#working === undefined ||
      typeof field !== 'string' ||
      field.length < 1 ||
      field.length > 128
    )
      invalid()
    integer(index, 0, this.admission.totalRows)
    integer(offset, 0, 1000000000)
    integer(length, 0, 65536)
    const metadata = this.#working.claim(16384 + 4 * this.#maximumOriginalRowBytes + 16 * 4096)
    let window: Brc38WorkingCharge | undefined,
      result: Uint8Array | undefined,
      retained = false
    try {
      window = this.#working.claim(16384 + 32 * 65536)
      return await this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const original = await this.#original(tx, table, index, metadata)
        if (original.destinationKey === undefined) invalid()
        const value = await tx.objectStore(brc38IdbRestoreStore(table)).get(original.destinationKey)
        if (value === undefined) invalid()
        await this.#head(tx, brc38IdbRestoreStore(table), original.destinationKey, value, clock)
        const descriptor = unpackPackedIdbMetadata(value).extents[field]
        if (descriptor === undefined || offset + length > descriptor.bytes) invalid()
        const actual = await checkPackedIdbContent(tx, descriptor)
        if (
          Number(actual.refs) < 1 ||
          actual.expiresAt !== undefined ||
          (await tx.objectStore(packedIdbStores.chunks).index('content').count(descriptor.content)) !==
            Math.ceil(descriptor.bytes / 65536)
        )
          invalid()
        result = await readPackedIdbExtent(tx, descriptor, offset, length)
        this.#check()
        return result
      })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'IndexedDB destination extent retains its current window until actual drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                result?.fill(0)
                window?.close()
                metadata.close()
              }
            )
        )
      }
      result?.fill(0)
      throw cause
    } finally {
      if (!retained) {
        window?.close()
        metadata.close()
      }
    }
  }
  readDestinationCounts(expectedReceiptSha256: string): Promise<
    Readonly<{
      counts: Readonly<Record<Brc38StageTable, number>>
      users: number
      originals: number
      originalBytes: number
      mappings: number
    }>
  > {
    return awaitFromSync(() => {
      if (!isSha(expectedReceiptSha256)) invalid()
      return this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const counts = {} as Record<Brc38StageTable, number>
        for (const table of brc38StageTables) counts[table] = await tx.objectStore(brc38IdbRestoreStore(table)).count()
        for (const store of ['action_batches', 'action_batch_outputs', 'action_batch_blobs', 'monitor_events'])
          if ((await tx.objectStore(store).count()) !== 0) invalid()
        return Object.freeze({
          counts: Object.freeze(counts),
          users: await tx.objectStore('users').count(),
          originals: entry.originalRows,
          originalBytes: entry.originalBytes,
          mappings: receipt.mappedIds
        })
      })
    })
  }
  /** One actual bounded version record per transaction. Positions/counts are
   * DATA; the full audit must walk/count every record and current content.
   * Fresh version-reference keys are compared with actual native metadata,
   * including same-record duplicate content multiplicity. Current heads/rows
   * and obsolete bounds are checked in this SAME native readonly transaction. */
  async readPackedVersion(
    expectedReceiptSha256: string,
    selectedAfter?: IDBValidKey
  ): Promise<Readonly<Brc38IdbPackedVersionRead> | undefined> {
    this.#check()
    if (!isSha(expectedReceiptSha256) || this.#working === undefined) invalid()
    const allowance = this.#working.claim(16384 + 32 * 65536)
    let transferred = false,
      retained = false
    try {
      let after: IDBValidKey | undefined
      if (selectedAfter !== undefined) {
        if (
          !Array.isArray(selectedAfter) ||
          selectedAfter.length !== 3 ||
          typeof selectedAfter[0] !== 'string' ||
          !walletStores.includes(selectedAfter[0]) ||
          typeof selectedAfter[2] !== 'number'
        )
          invalid()
        integer(selectedAfter[2], 1, Number.MAX_SAFE_INTEGER)
        after = [selectedAfter[0], packedIdbKey(selectedAfter[1]), selectedAfter[2]]
      }
      const result = await this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const cursor = await tx
          .objectStore(packedIdbStores.versions)
          .openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true))
        this.#check()
        if (cursor === null) return undefined
        const value = cursor.value,
          store = value.store
        if (typeof store !== 'string' || !walletStores.includes(store) || typeof value.deleted !== 'boolean') invalid()
        const key = packedIdbKey(value.key),
          revision = value.revision as number
        integer(revision, 1, clock.revision)
        if (JSON.stringify(cursor.primaryKey) !== JSON.stringify([store, key, revision])) invalid()
        const row = value.deleted ? undefined : unpackPackedIdbMetadata(value.value)
        if (
          value.charge !== packedIdbVersionCharge(row) ||
          (value.deleted && value.value !== undefined) ||
          (value.deleted && value.deletedAt !== revision) ||
          (!value.deleted && value.deletedAt !== undefined)
        )
          invalid()
        verifyPackedIdbReferences(value.references, row ?? { extents: {} })
        const head = await tx.objectStore(packedIdbStores.heads).get([store, key])
        if (
          head === undefined ||
          head.store !== store ||
          JSON.stringify(head.key) !== JSON.stringify(key) ||
          JSON.stringify(head.portableKey) !== JSON.stringify(packedIdbPortableKey(store, key)) ||
          JSON.stringify(head.replicaKey) !== JSON.stringify(packedIdbReplicaKey(store, key))
        )
          invalid()
        integer(head.revision as number, revision, clock.revision)
        let obsoleteAt: number | undefined
        if (value.obsoleteAt !== undefined) {
          obsoleteAt = value.obsoleteAt as number
          integer(obsoleteAt, revision + 1, head.revision as number)
        } else {
          if (head.revision !== revision) invalid()
          const current = await tx.objectStore(store).get(key)
          if (value.deleted) {
            if (current !== undefined) invalid()
          } else {
            if (current === undefined) invalid()
            samePackedMetadata(current, value.value)
          }
        }
        this.#check()
        return Object.freeze({
          position: [store, key, revision] as IDBValidKey,
          store,
          key,
          revision,
          ...(obsoleteAt === undefined ? {} : { obsoleteAt }),
          deleted: value.deleted,
          charge: value.charge as number,
          references: row === undefined ? 0 : Object.keys(row.extents).length
        })
      })
      if (result === undefined) return undefined
      allowance.resize(65536)
      transferred = true
      return Object.freeze({ ...result, close: () => allowance.close() })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'Packed version inventory retains current native allocations through actual drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                allowance.close()
              }
            )
        )
      }
      throw cause
    } finally {
      if (!transferred && !retained) allowance.close()
    }
  }
  readPackedInventoryCounts(expectedReceiptSha256: string): Promise<
    Readonly<{
      epoch: string
      revision: number
      contents: number
      chunks: number
      versions: number
      heads: number
      leases: number
      jsonStages: number
      jsonMembers: number
      retired: number
      expired: number
      obsolete: number
      logicalBytes: number
      records: number
    }>
  > {
    return awaitFromSync(() => {
      if (!isSha(expectedReceiptSha256)) invalid()
      return this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        if (
          tx.db.objectStoreNames.length !==
            walletStores.length +
              Object.values(packedIdbStores).length +
              Object.values(idbImportJournalStores).length ||
          (await tx.objectStore(packedIdbStores.clock).count()) !== 1
        )
          invalid()
        const counts = { contents: 0, chunks: 0, versions: 0, heads: 0, leases: 0, jsonStages: 0, jsonMembers: 0 }
        for (const name of Object.keys(counts) as Array<keyof typeof counts>)
          counts[name] = await tx.objectStore(packedIdbStores[name]).count()
        return Object.freeze({
          epoch: clock.epoch,
          revision: clock.revision,
          ...counts,
          retired: await tx.objectStore(packedIdbStores.contents).index('retired').count(1),
          expired: await tx
            .objectStore(packedIdbStores.contents)
            .index('expiresAt')
            .count(IDBKeyRange.upperBound(Date.now())),
          obsolete: await tx
            .objectStore(packedIdbStores.versions)
            .index('obsoleteAt')
            .count(IDBKeyRange.upperBound(clock.revision)),
          logicalBytes: clock.bytes,
          records: clock.records
        })
      })
    })
  }
  /** Finite maintenance on THIS actual journal connection only. No externally
   * supplied provider can redirect collection to another wallet. Current
   * receipt/profile/schema checked before/after; normal reference rules apply. */
  async collectPackedGarbage(expectedReceiptSha256: string): Promise<void> {
    this.#check()
    if (!isSha(expectedReceiptSha256) || this.#working === undefined) invalid()
    const allowance = this.#working.claim(16384 + 32 * 65536)
    let retained = false
    try {
      const before = await this.readMappings(expectedReceiptSha256, [])
      before.close()
      this.#check()
      if (this.#busy) throw new Error('IndexedDB import already owns a checkpoint operation')
      this.#busy = true
      const operation = collectPackedIdb(this.#owner.database, 128, 256)
      this.#active = operation
      try {
        await operation
      } finally {
        this.#busy = false
      }
      this.#check()
      const after = await this.readMappings(expectedReceiptSha256, [])
      after.close()
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'Packed garbage collection retains native windows through actual drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                allowance.close()
              }
            )
        )
      }
      throw cause
    } finally {
      if (!retained) allowance.close()
    }
  }
  async readPackedOriginalCharge(
    expectedReceiptSha256: string,
    selectedAfter?: readonly [Brc38StageTable | 'header', number]
  ): Promise<
    | Readonly<{
        position: readonly [Brc38StageTable | 'header', number]
        metadataBytes: number
        originalBytes: number
        references: number
      }>
    | undefined
  > {
    this.#check()
    if (!isSha(expectedReceiptSha256) || this.#working === undefined) invalid()
    const allowance = this.#working.claim(16384 + 4 * this.#maximumOriginalRowBytes + 16 * 4096)
    let retained = false
    try {
      let after: [Brc38StageTable | 'header', number] | undefined
      if (selectedAfter !== undefined) {
        const table = selectedAfter[0],
          index = selectedAfter[1]
        if (
          !Array.isArray(selectedAfter) ||
          selectedAfter.length !== 2 ||
          (table !== 'header' && !brc38StageTables.includes(table))
        )
          invalid()
        integer(index, 0, this.admission.totalRows)
        after = [table, index]
      }
      return await this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const cursor = await tx
          .objectStore(idbImportJournalStores.originals)
          .openKeyCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true))
        if (cursor === null) return undefined
        const coordinate = cursor.primaryKey
        if (
          !Array.isArray(coordinate) ||
          coordinate.length !== 2 ||
          typeof coordinate[0] !== 'string' ||
          typeof coordinate[1] !== 'number' ||
          (coordinate[0] !== 'header' && !brc38StageTables.includes(coordinate[0] as Brc38StageTable))
        )
          invalid()
        const table = coordinate[0] as Brc38StageTable | 'header',
          index = coordinate[1]
        integer(index, 0, this.admission.totalRows)
        const original = await this.#original(tx, table, index, allowance),
          references = Object.keys(original.fields).length,
          metadataBytes =
            256 + original.bytes + 384 * references + destinationCharge(destinationJson(original.destinationKey)),
          extentBytes = Object.values(original.fields).reduce((sum, field) => sum + field.bytes, 0)
        return Object.freeze({
          position: Object.freeze([table, index] as [Brc38StageTable | 'header', number]),
          metadataBytes,
          originalBytes: metadataBytes + extentBytes,
          references
        })
      })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'Packed original inventory retains current native metadata through actual drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                allowance.close()
              }
            )
        )
      }
      throw cause
    } finally {
      if (!retained) allowance.close()
    }
  }
  async #content(
    tx: PackedIdbTransaction,
    selectedContent: string
  ): Promise<{ field: Readonly<PackedIdbField>; references: number; chunks: number }> {
    const value = await tx.objectStore(packedIdbStores.contents).get(selectedContent)
    if (value === undefined || value.id !== selectedContent) invalid()
    const field = Object.freeze({
        content: selectedContent,
        kind: value.kind as PackedIdbField['kind'],
        bytes: value.bytes as number,
        sha256: value.sha256 as string
      }),
      actual = await checkPackedIdbContent(tx, field)
    if (actual.refs === 0 || actual.retired !== 0 || actual.expiresAt !== undefined) invalid()
    const range = IDBKeyRange.bound([selectedContent, 0], [selectedContent, 127]),
      references =
        (await tx.objectStore(packedIdbStores.versions).index('references').count(range)) +
        (await tx.objectStore(idbImportJournalStores.originals).index('references').count(range)),
      chunks = await tx.objectStore(packedIdbStores.chunks).index('content').count(selectedContent)
    if (references !== actual.refs || chunks !== Math.ceil(field.bytes / 65536)) invalid()
    this.#check()
    return { field, references, chunks }
  }
  /** Current live content plus actual indexed reference cardinalities. All
   * version/original reference entries must separately be inventoried first;
   * a descriptor/previous count never permits an extent read. */
  async readPackedContent(
    expectedReceiptSha256: string,
    selectedAfter?: string
  ): Promise<Readonly<Brc38IdbPackedContentRead> | undefined> {
    this.#check()
    if (
      !isSha(expectedReceiptSha256) ||
      this.#working === undefined ||
      (selectedAfter !== undefined && !/^[0-9a-f]{32}$/.test(selectedAfter))
    )
      invalid()
    const allowance = this.#working.claim(65536)
    let transferred = false,
      retained = false
    try {
      const result = await this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const cursor = await tx
          .objectStore(packedIdbStores.contents)
          .openKeyCursor(selectedAfter === undefined ? undefined : IDBKeyRange.lowerBound(selectedAfter, true))
        if (cursor === null) return undefined
        if (typeof cursor.primaryKey !== 'string' || !/^[0-9a-f]{32}$/.test(cursor.primaryKey)) invalid()
        return await this.#content(tx, cursor.primaryKey)
      })
      if (result === undefined) return undefined
      allowance.resize(4096)
      transferred = true
      return Object.freeze({ ...result, close: () => allowance.close() })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'Packed content inventory retains current native metadata through actual drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                allowance.close()
              }
            )
        )
      }
      throw cause
    } finally {
      if (!transferred && !retained) allowance.close()
    }
  }
  async readPackedContentExtent(
    expectedReceiptSha256: string,
    content: string,
    offset: number,
    length: number
  ): Promise<Uint8Array> {
    this.#check()
    if (!isSha(expectedReceiptSha256) || !/^[0-9a-f]{32}$/.test(content) || this.#working === undefined) invalid()
    integer(offset, 0, 1000000000)
    integer(length, 0, 65536)
    const allowance = this.#working.claim(8192 + 12 * 65536)
    let result: Uint8Array | undefined,
      retained = false
    try {
      return await this.#run('readonly', async (_wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (receipt.state === 'EXPIRED' || entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const current = await this.#content(tx, content)
        if (offset + length > current.field.bytes) invalid()
        result = await readPackedIdbExtent(tx, current.field, offset, length)
        this.#check()
        return result
      })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'Packed content range retains current native window through actual drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                result?.fill(0)
                allowance.close()
              }
            )
        )
      }
      result?.fill(0)
      throw cause
    } finally {
      if (!retained) allowance.close()
    }
  }
  /** Finite retirement of original references for an expired UNFINISHED,
   * inactive profile. The EXPIRED receipt and each reference removal are one
   * native transaction. Counts persist across lost ACK/reopen; mapped IDs and
   * partial wallet rows remain, and referenced content is never force-deleted.
   * Physical chunks use the provider's separately bounded garbage collector. */
  async retireExpiredOriginals(maximumRows = 16): Promise<Readonly<{ retired: number; remaining: number }>> {
    this.#cleanupCheck()
    integer(maximumRows, 1, 16)
    if (this.#working === undefined) invalid()
    const allowance = this.#working.claim(16384 + 4 * this.#maximumOriginalRowBytes + 16 * 4096)
    let retained = false
    try {
      return await this.#run(
        'readwrite',
        async (_wallet, tx, clock) => {
          const { entry, receipt } = await this.#load(tx, clock)
          if (receipt.state === 'COMPLETE' || receipt.nextRow >= this.admission.totalRows) invalid()
          const originals = tx.objectStore(idbImportJournalStores.originals)
          let cursor = await originals.openKeyCursor(),
            retired = 0,
            originalBytes = entry.originalBytes
          while (cursor !== null && retired < maximumRows) {
            const key = cursor.primaryKey
            if (
              !Array.isArray(key) ||
              key.length !== 2 ||
              typeof key[0] !== 'string' ||
              typeof key[1] !== 'number' ||
              (key[0] !== 'header' && !brc38StageTables.includes(key[0] as Brc38StageTable))
            )
              invalid()
            integer(key[1], 0, this.admission.totalRows)
            const original = await this.#original(tx, key[0] as Brc38StageTable | 'header', key[1], allowance, true),
              row = { fields: Object.create(null) as Record<string, unknown>, extents: { ...original.fields } },
              names = Object.keys(original.fields),
              metadataCharge =
                256 +
                original.bytes +
                384 * names.length +
                destinationCharge(
                  original.destinationKey === undefined ? undefined : destinationJson(original.destinationKey)
                ),
              charge = metadataCharge + Object.values(original.fields).reduce((sum, field) => sum + field.bytes, 0)
            if (!Number.isSafeInteger(charge) || charge > originalBytes) invalid()
            await retainPackedIdbFields(tx as PackedIdbTransaction<'readwrite'>, row, -1)
            await originals.delete(key)
            await chargePackedIdb(tx, -metadataCharge, -1)
            originalBytes -= charge
            retired++
            this.#cleanupCheck()
            cursor = await cursor.continue()
          }
          const remaining = entry.originalRows - retired
          if (remaining < 0 || (await originals.count()) !== remaining || (remaining === 0 && originalBytes !== 0))
            invalid()
          const expired: Brc38ImportJournalReceipt = Object.freeze({ ...receipt, state: 'EXPIRED' }),
            receiptJson = boundedJson(expired)
          decodeReceipt(receiptJson, this.admission)
          await tx
            .objectStore(idbImportJournalStores.journal)
            .put(
              { ...entry, originalRows: remaining, originalBytes, receiptJson, receiptSha256: digest(receiptJson) },
              1
            )
          return Object.freeze({ retired, remaining })
        },
        true
      )
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) {
        retained = true
        throw new Brc38StagingCleanupError(
          [cause],
          'Expired original retirement retains its current metadata allowance until drainage',
          () =>
            mapAwaitFromSync(
              () => cause.retryCleanup(),
              () => {
                allowance.close()
              }
            )
        )
      }
      throw cause
    } finally {
      if (!retained) allowance.close()
    }
  }
  commit(
    proposed: Brc38ImportJournalStep,
    actualDestinationSha256: string,
    applyPrepared: (writer: Readonly<Brc38IdbImportWriter>) => Promise<string>,
    expectedReceiptSha256?: string
  ): Promise<Readonly<Brc38ImportJournalReceipt>> {
    return awaitFromSync(() => {
      const step = stepCopy(proposed, this.admission)
      if (
        !isSha(actualDestinationSha256) ||
        typeof applyPrepared !== 'function' ||
        (expectedReceiptSha256 !== undefined && !isSha(expectedReceiptSha256))
      )
        invalid()
      return this.#run('readwrite', async (wallet, tx, clock) => {
        const { entry, receipt } = await this.#load(tx, clock)
        if (
          receipt.state === 'EXPIRED' ||
          entry.publicationJson !== undefined ||
          receipt.destinationSha256 !== actualDestinationSha256
        )
          invalid()
        if (step.fromRow < receipt.nextRow) {
          if (JSON.stringify(step) !== JSON.stringify(receipt.lastStep)) invalid()
          return receipt
        }
        if (receipt.state === 'COMPLETE' || step.fromRow !== receipt.nextRow) invalid()
        if (expectedReceiptSha256 !== undefined && entry.receiptSha256 !== expectedReceiptSha256) invalid()
        const mappedIds = receipt.mappedIds + step.mappedIds
        if (mappedIds > mappingCapacity(this.admission))
          throw new SnapshotResourceLimitError('IndexedDB import original mapping quota reached')
        let active = true,
          additions = 0,
          originalRows = entry.originalRows,
          originalBytes = entry.originalBytes,
          pending: Promise<unknown> | undefined
        const own = <T>(work: () => Promise<T>): Promise<T> => {
          check()
          if (pending !== undefined) throw new Error('IndexedDB import writer requires serial awaited effects')
          const current = Promise.resolve().then(work)
          const result: Promise<T> = current.finally(() => {
            if (pending === result) pending = undefined
          })
          pending = result
          void result.catch(() => undefined)
          return result
        }
        const check = () => {
            if (!active) invalid()
            this.#check()
          },
          ids = tx.objectStore(idbImportJournalStores.ids),
          originals = tx.objectStore(idbImportJournalStores.originals),
          writer: Brc38IdbImportWriter = {
            transaction: wallet as PackedIdbTransaction<'readwrite'>,
            lookup: (entity, incomingId) =>
              own(async () => {
                check()
                const key = incoming(entity, incomingId),
                  row = await ids.get([entity, key])
                check()
                if (row === undefined) return undefined
                if (row.entity !== entity || row.incomingId !== key) invalid()
                integer(row.localId as number, 1, Number.MAX_SAFE_INTEGER)
                return row.localId as number
              }),
            map: (entity, incomingId, localId) =>
              own(async () => {
                check()
                const key = incoming(entity, incomingId)
                integer(localId, 1, Number.MAX_SAFE_INTEGER)
                const old = await ids.get([entity, key])
                check()
                if (old !== undefined) {
                  if (old.entity !== entity || old.incomingId !== key || old.localId !== localId) invalid()
                  return
                }
                if (++additions > step.mappedIds) invalid()
                await chargePackedIdb(tx, 512, 1)
                check()
                await ids.add({ entity, incomingId: key, localId })
                check()
              }),
            original: (table, index, payload, selectedKey) => {
              const keyJson = destinationJson(selectedKey)
              return own(async () => {
                check()
                if (table !== 'header' && !brc38StageTables.includes(table)) invalid()
                integer(index, 0, this.admission.totalRows)
                const bytes = utf8Bytes(payload, this.#maximumOriginalRowBytes),
                  allowance = this.#working?.claim(1024 + 16 * bytes)
                try {
                  const sha256 = digest(payload),
                    old = await originals.get([table, index])
                  check()
                  if (
                    keyJson !== undefined &&
                    ((table === 'header' && destinationKey(keyJson) !== this.admission.scope.userId) ||
                      (await wallet.objectStore(brc38IdbRestoreStore(table)).getKey(destinationKey(keyJson))) ===
                        undefined)
                  )
                    invalid()
                  if (old !== undefined) {
                    if (
                      old.table !== table ||
                      old.index !== index ||
                      old.payload !== payload ||
                      old.sha256 !== sha256 ||
                      old.bytes !== bytes ||
                      old.destinationKeyJson !== keyJson
                    )
                      invalid()
                    return
                  }
                  const charge = 256 + bytes + destinationCharge(keyJson)
                  if (originalRows >= this.admission.totalRows || charge > this.#maximumOriginalBytes - originalBytes)
                    throw new SnapshotResourceLimitError('IndexedDB import original provenance quota reached')
                  await chargePackedIdb(tx, charge, 1)
                  check()
                  await originals.add({
                    table,
                    index,
                    payload,
                    sha256,
                    bytes,
                    references: [],
                    ...(keyJson === undefined ? {} : { destinationKeyJson: keyJson })
                  })
                  check()
                  originalRows++
                  originalBytes += charge
                } finally {
                  allowance?.close()
                }
              })
            },
            originalStreamed: (table, index, payload, selected, selectedKey) => {
              const keyJson = destinationJson(selectedKey)
              // Capture exact stage identities and data properties BEFORE the
              // first asynchronous boundary. Copies/descriptor markers cannot
              // replace an actual current owner-issued packed stage.
              if (
                !brc38StageTables.includes(table) ||
                selected === null ||
                typeof selected !== 'object' ||
                Array.isArray(selected)
              )
                invalid()
              const names = Object.keys(selected).sort((a, b) => Number(a > b) - Number(a < b)),
                fields: Record<string, PackedIdbStagedField> = Object.create(null)
              if (names.length < 1 || names.length > 13) invalid()
              for (const name of names) {
                const property = Object.getOwnPropertyDescriptor(selected, name)
                if (
                  property === undefined ||
                  !Object.hasOwn(property, 'value') ||
                  !property.enumerable ||
                  !(
                    brc38JsonBinaryField(table, name) ||
                    brc38JsonStructuredField(table, name) ||
                    brc38JsonTextField(table, name)
                  )
                )
                  invalid()
                fields[name] = property.value as PackedIdbStagedField
              }
              return own(async () => {
                check()
                integer(index, 0, this.admission.totalRows)
                const bytes = utf8Bytes(payload, this.#maximumOriginalRowBytes),
                  allowance = this.#working?.claim(262144 + 16 * bytes + 4096 * names.length)
                try {
                  const sha256 = digest(payload),
                    old = await originals.get([table, index])
                  check()
                  if (
                    keyJson !== undefined &&
                    (await wallet.objectStore(brc38IdbRestoreStore(table)).getKey(destinationKey(keyJson))) ===
                      undefined
                  )
                    invalid()
                  const row = await attachPackedIdbStages(
                    this.#owner,
                    tx as PackedIdbTransaction<'readwrite'>,
                    Object.create(null),
                    fields,
                    new Set<string>()
                  )
                  check()
                  let extentBytes = 0
                  for (const name of names) {
                    const descriptor = row.extents[name]
                    if (
                      descriptor === undefined ||
                      ((brc38JsonStructuredField(table, name) || brc38JsonTextField(table, name)) &&
                        descriptor.kind !== 'utf16') ||
                      (brc38JsonBinaryField(table, name) && !['array', 'typed'].includes(descriptor.kind))
                    )
                      invalid()
                    extentBytes += descriptor.bytes
                    if (!Number.isSafeInteger(extentBytes)) invalid()
                  }
                  // This strict replay accepts the same actual content identities;
                  // a checksum-equivalent new stage is not a replacement grant.
                  const fieldsJson = JSON.stringify(row.extents)
                  if (old !== undefined) {
                    if (
                      old.table !== table ||
                      old.index !== index ||
                      old.payload !== payload ||
                      old.sha256 !== sha256 ||
                      old.bytes !== bytes ||
                      old.fieldsJson !== fieldsJson ||
                      old.extentBytes !== extentBytes ||
                      old.destinationKeyJson !== keyJson
                    )
                      invalid()
                    verifyPackedIdbReferences(old.references, row)
                    return
                  }
                  const metadataCharge = 256 + bytes + 384 * names.length + destinationCharge(keyJson),
                    originalCharge = metadataCharge + extentBytes
                  if (
                    !Number.isSafeInteger(originalCharge) ||
                    originalRows >= this.admission.totalRows ||
                    originalCharge > this.#maximumOriginalBytes - originalBytes
                  )
                    throw new SnapshotResourceLimitError('IndexedDB streamed original provenance quota reached')
                  // Content was prepared outside this writer. Charge its new
                  // metadata here; existing packed content/chunk charges remain.
                  // The original-provenance ceiling counts both metadata and
                  // referenced extents without billing content a second time.
                  await chargePackedIdb(tx, metadataCharge, 1)
                  await retainPackedIdbFields(tx as PackedIdbTransaction<'readwrite'>, row, 1)
                  check()
                  await originals.add({
                    table,
                    index,
                    payload,
                    sha256,
                    bytes,
                    fieldsJson,
                    extentBytes,
                    references: packedIdbReferences(row),
                    ...(keyJson === undefined ? {} : { destinationKeyJson: keyJson })
                  })
                  check()
                  originalRows++
                  originalBytes += originalCharge
                } finally {
                  allowance?.close()
                }
              })
            }
          }
        let outcome: { value: string } | { cause: unknown }
        try {
          outcome = { value: await applyPrepared(Object.freeze(writer)) }
        } catch (cause) {
          outcome = { cause }
        }
        active = false
        if (pending !== undefined) {
          try {
            tx.abort()
          } catch {
            /* settled */
          }
          await pending.catch(() => undefined)
          throw new Error(
            'IndexedDB import preparation returned with an unawaited effect',
            'cause' in outcome ? { cause: outcome.cause } : {}
          )
        }
        if ('cause' in outcome) throw outcome.cause
        const destinationSha256 = outcome.value
        this.#check()
        await this.#owner.sealRestoreEffects(wallet)
        if (
          !isSha(destinationSha256) ||
          additions !== step.mappedIds ||
          originalRows - entry.originalRows !== step.rows ||
          (await ids.count()) !== mappedIds ||
          (await originals.count()) !== originalRows
        )
          invalid()
        const nextRow = receipt.nextRow + step.rows,
          next: Brc38ImportJournalReceipt = Object.freeze({
            protocol: receipt.protocol,
            state: nextRow === this.admission.totalRows ? 'COMPLETE' : 'COMMITTED',
            sequence: receipt.sequence + 1,
            nextRow,
            mappedIds,
            logicalBytes: 4096 + mappedIds * 512,
            destinationSha256,
            lastStep: step
          }),
          receiptJson = boundedJson(next)
        utf8Bytes(receiptJson, 1024)
        decodeReceipt(receiptJson, this.admission)
        // Journal changes do not observe themselves as wallet rows. Normal row
        // effects already advanced the provider clock atomically in this view.
        const current = await this.#current(wallet, tx)
        if (current.epoch !== entry.epoch || current.revision - entry.revision !== step.rows)
          throw new Error('IndexedDB import row effects differ from the prepared bounded step')
        const nextEntry = {
          ...entry,
          mappedIds,
          originalRows,
          originalBytes,
          revision: current.revision,
          receiptJson,
          receiptSha256: digest(receiptJson)
        }
        boundedJson(nextEntry)
        await tx.objectStore(idbImportJournalStores.journal).put(nextEntry, 1)
        return next
      })
    })
  }
  async close(): Promise<void> {
    this.#open = false
    await this.#active.catch(() => undefined)
    if (this.#cleanup !== undefined) await this.#cleanup.retryCleanup()
  }
}
