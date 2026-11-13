import { readGenerationIndexState } from '../../schema/snapshotSqliteIndexState'
import { readSnapshotGlobalIndexState } from '../../schema/snapshotGlobalIndexMigration'
import { readSnapshotCertificateIndexState } from '../../schema/snapshotCertificateIndexMigration'
import { readSnapshotRelationIndexState } from '../../schema/snapshotRelationIndexMigration'
import { readSnapshotProfileIndexState } from '../../schema/snapshotProfileIndexMigration'
import { Random, Utils } from '@bsv/sdk'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import type { StorageKnex } from '../../StorageKnex'
import {
  createKnexWalletSnapshotPageReader,
  createKnexWalletSnapshotBinaryReader,
  createKnexWalletSnapshotFieldReader
} from '../KnexWalletReadSnapshot'
import { isBrc38NativeBinaryReadTransaction } from '../../portable/Brc38NativeBinaryReadNode'
import type { WalletReadSnapshot, WalletReadSnapshotOptions, WalletSnapshotBinaryReader } from '../WalletReadSnapshot'
import { assertKnexSnapshotArchiveClosure } from './KnexSnapshotArchiveClosure'
import type { RetainedReadSnapshot } from '../RetainedReadSnapshot'

/** Internal ownership failure; no caller may release its admission as cleaned up. */
export class SnapshotArchiveSourceCleanupError extends Error {
  private cleaned = false
  private cleaning?: Promise<void>
  constructor(
    override readonly cause: unknown,
    private readonly cleanup?: () => Promise<void>
  ) {
    super('Snapshot archive source cleanup failed')
    this.name = 'SnapshotArchiveSourceCleanupError'
  }
  async retryCleanup(): Promise<void> {
    if (this.cleanup === undefined) throw this
    if (this.cleaned) return
    if (this.cleaning === undefined) {
      const attempt = Promise.resolve()
        .then(this.cleanup)
        .then(() => {
          this.cleaned = true
        })
      this.cleaning = attempt
      void attempt.catch(() => {
        if (this.cleaning === attempt) this.cleaning = undefined
      })
    }
    await this.cleaning
  }
  /** Completion of this concrete retained cleanup only; never source admission. */
  get cleanupCompleted(): boolean {
    return this.cleaned
  }
}

export interface SnapshotArchiveSource extends WalletReadSnapshot {
  readonly sourceSchema: string
  /** Verify profile relations using the same read view as the header and pages. */
  validateClosure: () => Promise<void>
  /** Optional local native metadata/extent path. No RPC capability follows. */
  binaryReader?: WalletSnapshotBinaryReader
}

export async function readSnapshotArchiveSourceSchema(storage: StorageKnex, k: Knex): Promise<string> {
  return await readKnexSnapshotSourceSchema(k, storage.knex.client.config.migrations)
}
/** Source version DATA from this actual retained view, without constructing or
 * enrolling a StorageProvider for a readonly historical recovery database. */
export async function readKnexSnapshotSourceSchema(k: Knex, config?: Knex.MigratorConfig): Promise<string> {
  const query = k(config?.tableName ?? 'knex_migrations')
    .select('name')
    .orderBy('id', 'desc')
  if (config?.schemaName !== undefined) void query.withSchema(config.schemaName)
  const row: { name?: unknown } | undefined = await query.first()
  if (typeof row?.name !== 'string' || row.name.length < 1 || row.name.length > 256) {
    throw new WERR_INVALID_OPERATION('Snapshot source schema version is unavailable')
  }
  return row.name
}

/** Metadata DATA only. This does not establish index or journal ownership. */
export async function readKnexSnapshotArchiveMetadata(storage: StorageKnex, identityKey: string, k: Knex) {
  const sourceStorage = await storage.readSettings(k)
  const user = await storage.findUserByIdentityKey(identityKey, k)
  if (user === undefined) throw new WERR_INVALID_PARAMETER('identityKey', 'an existing wallet profile')
  return { sourceStorage, user, sourceSchema: await readSnapshotArchiveSourceSchema(storage, k) }
}

/** Read source metadata and index ownership in the caller's already pinned view. */
export async function readKnexSnapshotArchiveHeader(storage: StorageKnex, identityKey: string, k: Knex) {
  const generation = await readGenerationIndexState(k, storage.knex.client.config.migrations)
  return {
    // This records the actual producer of THIS retained view. Every field
    // operation still checks its live native transaction before reading.
    nativeFields: isBrc38NativeBinaryReadTransaction(k),
    header: await readKnexSnapshotArchiveMetadata(storage, identityKey, k),
    profileIndexes: generation ?? (await readSnapshotProfileIndexState(k, storage.knex.client.config.migrations)),
    relationIndexes: generation ?? (await readSnapshotRelationIndexState(k, storage.knex.client.config.migrations)),
    globalIndexes: generation ?? (await readSnapshotGlobalIndexState(k, storage.knex.client.config.migrations)),
    certificateIndexes:
      generation ?? (await readSnapshotCertificateIndexState(k, storage.knex.client.config.migrations))
  }
}

export type KnexSnapshotArchiveHeader = Awaited<ReturnType<typeof readKnexSnapshotArchiveHeader>>

/** Construct a handle only after its caller has proved capture publication. */
export function createKnexSnapshotArchiveSource(
  storage: StorageKnex,
  view: RetainedReadSnapshot,
  {
    header,
    profileIndexes,
    relationIndexes,
    certificateIndexes,
    globalIndexes,
    nativeFields
  }: KnexSnapshotArchiveHeader
): SnapshotArchiveSource {
  const userId = header.user.userId
  const snapshotId = Utils.toHex(Random(32))
  const copyDates = <T extends { created_at: Date; updated_at: Date }>(value: T): T => ({
    ...value,
    created_at: new Date(value.created_at),
    updated_at: new Date(value.updated_at)
  })
  const sourceStorage = copyDates(header.sourceStorage),
    user = copyDates(header.user)
  return {
    version: 1,
    snapshotId,
    ...header,
    // Public metadata is DATA. A consumer's edits to its copy must not alter
    // the actual view header used by a later copy or content receipt.
    get sourceStorage() {
      return copyDates(sourceStorage)
    },
    get user() {
      return copyDates(user)
    },
    expiresAt: view.expiresAt,
    get isOpen() {
      return view.isOpen
    },
    closed: view.closed,
    close: view.close,
    binaryReader: createKnexWalletSnapshotBinaryReader(
      storage,
      userId,
      snapshotId,
      view,
      profileIndexes,
      relationIndexes,
      certificateIndexes,
      globalIndexes
    ),
    ...(nativeFields
      ? {
          fieldReader: createKnexWalletSnapshotFieldReader(
            storage,
            userId,
            snapshotId,
            view,
            profileIndexes,
            relationIndexes,
            certificateIndexes,
            globalIndexes
          )
        }
      : {}),
    readPage: createKnexWalletSnapshotPageReader(
      storage,
      userId,
      snapshotId,
      view,
      profileIndexes,
      relationIndexes,
      certificateIndexes,
      globalIndexes
    ),
    validateClosure: async () => {
      await view.read(trx =>
        assertKnexSnapshotArchiveClosure(
          storage.toDb(trx),
          userId,
          profileIndexes,
          relationIndexes,
          certificateIndexes,
          globalIndexes
        )
      )
    }
  }
}

/**
 * Internal SQL capture source. The caller supplies a dedicated reader provider,
 * separate from the staging writer, and awaits close before releasing it.
 * No capability is advertised by constructing this local source.
 */
export async function openKnexSnapshotArchiveSource(
  storage: StorageKnex,
  identityKey: string,
  options: WalletReadSnapshotOptions = {},
  openView: () => Promise<RetainedReadSnapshot> = () => storage.openReadSnapshot(options)
): Promise<SnapshotArchiveSource> {
  if (typeof identityKey !== 'string' || !/^(02|03)[0-9a-fA-F]{64}$/.test(identityKey)) {
    throw new WERR_INVALID_PARAMETER('identityKey', 'a compressed public identity key')
  }
  const view = await openView()
  try {
    const header = await view.read(trx => readKnexSnapshotArchiveHeader(storage, identityKey, storage.toDb(trx)))
    return createKnexSnapshotArchiveSource(storage, view, header)
  } catch (error) {
    try {
      await view.close()
      await view.closed
    } catch (error_) {
      // A failed read remains its original error after physical closure.
      if (error_ === error) throw error
      throw new SnapshotArchiveSourceCleanupError(
        new AggregateError([error, error_], 'Snapshot archive opening failed with retained source cleanup', {
          cause: error
        }),
        () => view.close()
      )
    }
    throw error
  }
}
