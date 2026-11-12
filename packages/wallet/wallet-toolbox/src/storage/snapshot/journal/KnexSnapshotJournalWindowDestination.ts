import { KnexSnapshotArchiveRequestStore } from '../archive/KnexSnapshotArchiveRequestStore'
import type { SnapshotArchiveRequestOwner } from '../archive/SnapshotArchiveRequest'
import { KnexSnapshotJournalDataContentReceipts } from './KnexSnapshotJournalDataContentReceipts'
import type { SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import { SnapshotJournalDataBootstrapRequiredError } from './SnapshotJournalDataBootstrapRequiredError'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../../StorageKnex'
import { WERR_INVALID_OPERATION, WERR_UNAUTHORIZED } from '../../../sdk/WERR_errors'
import type { SnapshotJournalDestinationLimits, SnapshotJournalWriterAdmission } from './SnapshotJournalProvider'
import type { SnapshotJournalDestinationBinding, SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'
import type { SnapshotJournalArchiveBinding, SnapshotJournalFieldArchiveBinding } from './SnapshotJournalArchiveBinding'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { readSnapshotJournalCaptureConfiguration } from './SnapshotJournalLifecycle'
import { verifySnapshotJournalDestinationSchema } from './SnapshotJournalDestinationSchema'
import {
  beginSnapshotJournalDestinationWindow,
  readSnapshotJournalDestinationWindow,
  readSnapshotJournalStoredWindow,
  retireSnapshotJournalDestinationWindow,
  replaceSnapshotJournalDestinationWindow,
  succeedSnapshotJournalDestinationWindow
} from './SnapshotJournalDestinationWindow'
import { snapshotJournalLineage, snapshotJournalAssociationGeneration } from './SnapshotJournalLineage'
import { beginSnapshotJournalProgress, readSnapshotJournalProgress } from './SnapshotJournalProgress'
import {
  cleanupSnapshotJournalAcknowledgedWindow,
  cleanupSnapshotJournalWindowCustody,
  requireSnapshotJournalWindowClean
} from './SnapshotJournalWindowCleanup'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal DATA destination differs from its actual admitted window')
}

function ownLimits(input: SnapshotJournalDestinationLimits): SnapshotJournalDestinationLimits {
  const limits = { ...input }
  if (
    !Number.isSafeInteger(limits.maximumChanges) ||
    limits.maximumChanges < 1 ||
    limits.maximumChanges > 32 ||
    !Number.isSafeInteger(limits.maximumAllocationBytes) ||
    limits.maximumAllocationBytes < 1 ||
    limits.maximumAllocationBytes > 16777216
  )
    invalid()
  return limits
}

/** Shared actual target-window lifecycle only. Separate concrete row/field
 * receivers own their encodings and financial promotion entry points. A source
 * binding remains DATA; every operation uses the genuine current target writer. */
export abstract class KnexSnapshotJournalWindowDestination {
  private busy = false
  protected readonly root: Knex
  protected constructor(
    protected readonly storage: StorageKnex,
    readonly binding: Readonly<SnapshotJournalDestinationBinding>,
    protected readonly limits: SnapshotJournalDestinationLimits,
    protected readonly admission: SnapshotJournalWriterAdmission,
    protected readonly signal: AbortSignal | undefined,
    originalRoot: Knex,
    private readonly uploadOwner?: Readonly<SnapshotArchiveRequestOwner>
  ) {
    this.root = originalRoot
    if (uploadOwner !== undefined) this.uploadOwner = Object.freeze({ ...uploadOwner })
  }

  protected static async beginWindow<T extends KnexSnapshotJournalWindowDestination>(
    storage: StorageKnex,
    identityKey: string,
    source: SnapshotJournalArchiveBinding | SnapshotJournalFieldArchiveBinding,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    create: (binding: SnapshotJournalDestinationBinding, limits: SnapshotJournalDestinationLimits, root: Knex) => T,
    signal?: AbortSignal,
    uploadOwner?: Readonly<SnapshotArchiveRequestOwner>
  ): Promise<{ destination: T; checkpoint: SnapshotJournalDestinationCheckpoint }> {
    limits = ownLimits(limits)
    const root = storage.knex
    if (source.user.identityKey !== identityKey)
      throw new WERR_UNAUTHORIZED('Journal DATA profile must match authentication')
    if (source.sourceStorage.chain !== storage.chain || typeof admission !== 'function') invalid()
    signal?.throwIfAborted()
    const begin = await admission(
      async () =>
        await storage.runSnapshotJournalWriter(
          async (trx, backend) => {
            await storage.assertFinancialDataWriteAdmission(identityKey, source.sourceStorage.storageIdentityKey, trx)
            const uploads = uploadOwner === undefined ? undefined : new KnexSnapshotArchiveRequestStore(trx)
            if (uploadOwner !== undefined) await uploads!.verifyJournalFieldUploadWriter(uploadOwner, source.journal)
            try {
              if (storage.knex !== root || backend === source.journal.source.backend) invalid()
              await verifySnapshotJournalDestinationSchema(trx)
              await readSnapshotJournalCaptureConfiguration(trx)
              const users: Array<{ userId: unknown; activeStorage: unknown; identityKey: unknown }> = await trx('users')
                .where('identityKey', identityKey)
                .select(
                  'userId',
                  trx.raw('substr(identityKey,1,131) AS identityKey'),
                  trx.raw('substr(activeStorage,1,257) AS activeStorage')
                )
                .limit(2)
              const settings: Array<{ storageIdentityKey: unknown; chain: unknown }> = await trx('settings')
                .select(
                  trx.raw('substr(storageIdentityKey,1,257) AS storageIdentityKey'),
                  trx.raw('substr(chain,1,9) AS chain')
                )
                .limit(2)
              if (
                users.length !== 1 ||
                settings.length !== 1 ||
                users[0].identityKey !== identityKey ||
                !Number.isSafeInteger(Number(users[0].userId)) ||
                Number(users[0].userId) < 1 ||
                typeof settings[0].storageIdentityKey !== 'string' ||
                settings[0].chain !== source.journal.source.chain ||
                !(users[0].activeStorage === null || typeof users[0].activeStorage === 'string')
              )
                invalid()
              const userId = Number(users[0].userId),
                mysql = ['mysql', 'mysql2'].includes(String(trx.client.config.client)),
                epochs: Array<{ epoch: unknown }> = await trx('snapshot_sync_primary_epochs')
                  .where('userId', userId)
                  .select(trx.raw(mysql ? 'CAST(epoch AS CHAR) AS epoch' : 'CAST(epoch AS TEXT) AS epoch'))
                  .limit(2)
              if (epochs.length > 1) invalid()
              const binding: SnapshotJournalDestinationBinding = {
                ...(source.version === 4 ? { fieldEncoding: 'wallet-journal-fields/1' as const } : {}),
                lineageVersion: 2,
                ...(source.journal.bootstrap ? { bootstrap: true as const } : {}),
                source: { ...source.journal.source },
                receipt: { ...source.journal.receipt },
                low: source.journal.low,
                destinationBackend: backend,
                destinationStorageIdentity: settings[0].storageIdentityKey,
                destinationUserId: userId,
                primaryEpoch: snapshotJournalRevision(epochs[0]?.epoch ?? '0'),
                activeStorage: users[0].activeStorage
              }
              const previous = await readSnapshotJournalStoredWindow(trx, binding)
              // Field windows require their separate complete-field receiver;
              // the old row controller must not retire or promote their metadata.
              if (source.version === 3 && previous?.binding.fieldEncoding !== undefined) invalid()
              if (
                previous !== undefined &&
                !previous.retired &&
                previous.checkpoint.phase === 'acknowledged' &&
                !source.journal.bootstrap &&
                (await new KnexSnapshotJournalDataContentReceipts(storage, root).destinationMatches(
                  trx as Knex.Transaction,
                  previous.binding,
                  previous.checkpoint
                )) === false
              )
                throw new SnapshotJournalDataBootstrapRequiredError()
              if (
                previous !== undefined &&
                !previous.retired &&
                JSON.stringify(previous.binding) === JSON.stringify(binding)
              ) {
                const checkpoint = await readSnapshotJournalDestinationWindow(trx, binding)
                if (checkpoint === undefined) invalid()
                await new KnexSnapshotJournalDataContentReceipts(storage, root).pending(
                  trx as Knex.Transaction,
                  binding,
                  checkpoint,
                  source.snapshotId,
                  source.journal.contentRevision,
                  { sourceStorage: source.sourceStorage, user: source.user, primary: source.journal.primary }
                )
                return { binding, checkpoint, previous: undefined, incremental: false }
              }
              if (previous !== undefined) {
                if (
                  previous.binding.lineageVersion !== 2 ||
                  snapshotJournalLineage(previous.binding) !== snapshotJournalLineage(binding)
                )
                  invalid()
                const incremental =
                  !source.journal.bootstrap &&
                  !previous.retired &&
                  previous.checkpoint.phase === 'acknowledged' &&
                  snapshotJournalAssociationGeneration(previous.binding) ===
                    snapshotJournalAssociationGeneration(binding) &&
                  previous.binding.receipt.highWater === binding.low
                if (!source.journal.bootstrap && !incremental) throw new SnapshotJournalDataBootstrapRequiredError()
                return { binding, checkpoint: undefined, previous, incremental }
              }
              if (!source.journal.bootstrap) throw new SnapshotJournalDataBootstrapRequiredError()
              const scopes = await trx('snapshot_reconciliation_windows')
                .where('userId', userId)
                .select('sourceStorageIdentity')
                .limit(9)
              if (scopes.length >= 8) throw new SnapshotResourceLimitError('Journal DATA source-scope quota reached')
              const checkpoint = await beginSnapshotJournalDestinationWindow(
                trx,
                binding,
                randomBytes(32).toString('hex')
              )
              await beginSnapshotJournalProgress(trx, binding, checkpoint)
              await new KnexSnapshotJournalDataContentReceipts(storage, root).pending(
                trx as Knex.Transaction,
                binding,
                checkpoint,
                source.snapshotId,
                source.journal.contentRevision,
                { sourceStorage: source.sourceStorage, user: source.user, primary: source.journal.primary }
              )
              return { binding, checkpoint, previous: undefined, incremental: false }
            } finally {
              if (uploadOwner !== undefined) await uploads!.verifyJournalFieldUploadWriter(uploadOwner, source.journal)
            }
          },
          undefined,
          signal
        )
    )
    if (storage.knex !== root) invalid()
    const destination = create(
      Object.freeze({
        ...begin.binding,
        source: Object.freeze({ ...begin.binding.source }),
        receipt: Object.freeze({ ...begin.binding.receipt })
      }),
      Object.freeze({ ...limits }),
      root
    )
    let checkpoint = begin.checkpoint
    if (begin.previous !== undefined) {
      const previous = begin.previous
      if (!begin.incremental)
        await destination.writer(
          async trx => await retireSnapshotJournalDestinationWindow(trx, previous.binding, previous.checkpoint)
        )
      let clean = false
      while (!clean) {
        signal?.throwIfAborted()
        clean = (
          await destination.writer(async trx =>
            begin.incremental
              ? await cleanupSnapshotJournalAcknowledgedWindow(trx, previous.binding, previous.checkpoint)
              : await cleanupSnapshotJournalWindowCustody(trx, previous.binding, previous.checkpoint)
          )
        ).complete
      }
      checkpoint = await destination.writer(async trx => {
        const requireClean = async (fenced: Knex) =>
          await requireSnapshotJournalWindowClean(fenced, previous.binding, previous.checkpoint)
        const next = begin.incremental
          ? await succeedSnapshotJournalDestinationWindow(
              trx,
              previous.binding,
              previous.checkpoint,
              begin.binding,
              randomBytes(32).toString('hex'),
              requireClean
            )
          : await replaceSnapshotJournalDestinationWindow(
              trx,
              previous.binding,
              previous.checkpoint,
              begin.binding,
              randomBytes(32).toString('hex'),
              requireClean
            )
        await beginSnapshotJournalProgress(trx, begin.binding, next)
        await new KnexSnapshotJournalDataContentReceipts(storage, root).pending(
          trx as Knex.Transaction,
          begin.binding,
          next,
          source.snapshotId,
          source.journal.contentRevision,
          { sourceStorage: source.sourceStorage, user: source.user, primary: source.journal.primary }
        )
        return next
      })
    }
    if (checkpoint === undefined) invalid()
    await destination.verifyCurrent()
    return { destination, checkpoint }
  }

  protected static async resumeWindow<T extends KnexSnapshotJournalWindowDestination>(
    storage: StorageKnex,
    identityKey: string,
    sourceStorageIdentity: string,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    fieldEncoding: 'wallet-journal-fields/1' | undefined,
    create: (binding: SnapshotJournalDestinationBinding, limits: SnapshotJournalDestinationLimits, root: Knex) => T,
    allowPreviousRowForFieldNegotiation?: true
  ): Promise<T | undefined> {
    if (typeof admission !== 'function') invalid()
    const root = storage.knex,
      ownedLimits = ownLimits(limits)
    const binding = await admission(
      async () =>
        await storage.runSnapshotJournalWriter(async (trx, backend) => {
          if (storage.knex !== root) invalid()
          await verifySnapshotJournalDestinationSchema(trx)
          await readSnapshotJournalCaptureConfiguration(trx)
          const users: Array<{ userId: number }> = await trx('users')
            .where('identityKey', identityKey)
            .select('userId')
            .limit(2)
          if (users.length !== 1) throw new WERR_UNAUTHORIZED('Journal DATA current profile is unavailable')
          const rows: Array<{ bindingJson: unknown }> = await trx('snapshot_reconciliation_windows')
            .where({ userId: users[0].userId, sourceStorageIdentity })
            .select(trx.raw('substr(bindingJson,1,4097) AS bindingJson'))
            .limit(2)
          if (rows.length === 0) return undefined
          if (
            rows.length !== 1 ||
            typeof rows[0].bindingJson !== 'string' ||
            Buffer.byteLength(rows[0].bindingJson) > 4096
          )
            invalid()
          const value = JSON.parse(rows[0].bindingJson) as SnapshotJournalDestinationBinding
          if (
            value.fieldEncoding !== fieldEncoding &&
            !(
              allowPreviousRowForFieldNegotiation === true &&
              fieldEncoding === 'wallet-journal-fields/1' &&
              value.fieldEncoding === undefined
            )
          )
            invalid()
          if (
            value.source.identityKey !== identityKey ||
            value.source.storageIdentity !== sourceStorageIdentity ||
            value.source.chain !== storage.chain ||
            value.destinationBackend !== backend
          )
            invalid()
          const actual = await readSnapshotJournalStoredWindow(trx, value)
          if (actual === undefined || actual.retired) invalid()
          // An actual verified row window is not a field receipt. Negotiation
          // may request a fresh full field artifact; row controllers stay strict.
          if (value.fieldEncoding !== fieldEncoding) return undefined
          return actual.binding
        }),
      'observe'
    )
    if (storage.knex !== root) invalid()
    return binding === undefined
      ? undefined
      : create(
          Object.freeze({
            ...binding,
            source: Object.freeze({ ...binding.source }),
            receipt: Object.freeze({ ...binding.receipt })
          }),
          Object.freeze(ownedLimits),
          root
        )
  }

  protected current(): void {
    if (this.storage.knex !== this.root || this.storage.chain !== this.binding.source.chain) invalid()
  }
  protected async verifyCurrent(): Promise<void> {
    this.current()
    if (!(await this.storage.supportsSnapshotJournalSync())) invalid()
    this.current()
  }
  protected async writer<T>(apply: (trx: Knex) => Promise<T>, observe = false): Promise<T> {
    this.current()
    return await this.admission(
      async () =>
        await this.storage.runSnapshotJournalWriter(
          async (trx, backend) => {
            this.current()
            if (!observe)
              await this.storage.assertFinancialDataWriteAdmission(
                this.binding.source.identityKey,
                this.binding.source.storageIdentity,
                trx
              )
            const uploads = this.uploadOwner === undefined ? undefined : new KnexSnapshotArchiveRequestStore(trx)
            if (this.uploadOwner !== undefined)
              await uploads!.verifyJournalFieldUploadWriter(this.uploadOwner, this.binding)
            if (backend !== this.binding.destinationBackend) invalid()
            await verifySnapshotJournalDestinationSchema(trx)
            await readSnapshotJournalCaptureConfiguration(trx)
            this.current()
            const result = await apply(trx)
            this.current()
            if (this.uploadOwner !== undefined)
              await uploads!.verifyJournalFieldUploadWriter(this.uploadOwner, this.binding)
            return result
          },
          this.binding.destinationBackend,
          observe ? undefined : this.signal
        ),
      observe ? 'observe' : undefined
    )
  }
  protected async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) invalid()
    this.busy = true
    try {
      return await operation()
    } finally {
      this.busy = false
    }
  }
  async status() {
    return await this.exclusive(
      async () =>
        await this.writer(async trx => {
          const checkpoint = await readSnapshotJournalDestinationWindow(trx, this.binding)
          if (checkpoint === undefined) invalid()
          return { checkpoint, progress: await readSnapshotJournalProgress(trx, this.binding, checkpoint) }
        }, true)
    )
  }
  async previousContentReceipt() {
    return await this.exclusive(
      async () =>
        await this.writer(async trx => {
          const checkpoint = await readSnapshotJournalDestinationWindow(trx, this.binding)
          return checkpoint === undefined
            ? undefined
            : await new KnexSnapshotJournalDataContentReceipts(this.storage, this.root).previous(
                trx as Knex.Transaction,
                this.binding,
                checkpoint
              )
        }, true)
    )
  }
  async confirmContentReceipt(revision: SnapshotSyncContentRevision, expectedActiveStorage?: string | null) {
    return await this.exclusive(
      async () =>
        await this.writer(async trx => {
          const checkpoint = await readSnapshotJournalDestinationWindow(trx, this.binding)
          return checkpoint === undefined
            ? undefined
            : await new KnexSnapshotJournalDataContentReceipts(this.storage, this.root).confirm(
                trx as Knex.Transaction,
                this.binding,
                checkpoint,
                revision,
                expectedActiveStorage
              )
        }, true)
    )
  }
  async cleanup(expected: SnapshotJournalDestinationCheckpoint) {
    return await this.exclusive(
      async () =>
        await this.writer(
          async trx => await cleanupSnapshotJournalAcknowledgedWindow(trx, this.binding, expected),
          true
        )
    )
  }
}
