import { readGenerationIndexState } from '../../schema/snapshotSqliteIndexState'
import { readSnapshotGlobalIndexState } from '../../schema/snapshotGlobalIndexMigration'
import { readSnapshotCertificateIndexState } from '../../schema/snapshotCertificateIndexMigration'
import { readSnapshotRelationIndexState } from '../../schema/snapshotRelationIndexMigration'
import { readSnapshotProfileIndexState } from '../../schema/snapshotProfileIndexMigration'
import { Random, Utils } from '@bsv/sdk'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import type { StorageKnex } from '../../StorageKnex'
import { createKnexWalletSnapshotPageReader } from '../KnexWalletReadSnapshot'
import type { WalletReadSnapshot, WalletReadSnapshotOptions } from '../WalletReadSnapshot'
import { assertKnexSnapshotArchiveClosure } from './KnexSnapshotArchiveClosure'
import type { RetainedReadSnapshot } from '../RetainedReadSnapshot'

/** Internal ownership failure; no caller may release its admission as cleaned up. */
export class SnapshotArchiveSourceCleanupError extends Error {
  constructor(override readonly cause: unknown) {
    super('Snapshot archive source cleanup failed')
    this.name = 'SnapshotArchiveSourceCleanupError'
  }
}

export interface SnapshotArchiveSource extends WalletReadSnapshot {
  readonly sourceSchema: string
  /** Verify profile relations using the same read view as the header and pages. */
  validateClosure: () => Promise<void>
}

export async function readSnapshotArchiveSourceSchema(storage: StorageKnex, k: Knex): Promise<string> {
  const config = storage.knex.client.config.migrations
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

/** Read source metadata and index ownership in the caller's already pinned view. */
export async function readKnexSnapshotArchiveHeader(storage: StorageKnex, identityKey: string, k: Knex) {
  const generation = await readGenerationIndexState(k, storage.knex.client.config.migrations)
  const sourceStorage = await storage.readSettings(k)
  const user = await storage.findUserByIdentityKey(identityKey, k)
  if (user === undefined) throw new WERR_INVALID_PARAMETER('identityKey', 'an existing wallet profile')
  return {
    header: {
      sourceStorage,
      user,
      sourceSchema: await readSnapshotArchiveSourceSchema(storage, k)
    },
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
  { header, profileIndexes, relationIndexes, certificateIndexes, globalIndexes }: KnexSnapshotArchiveHeader
): SnapshotArchiveSource {
  const userId = header.user.userId
  const snapshotId = Utils.toHex(Random(32))
  return {
    version: 1,
    snapshotId,
    ...header,
    expiresAt: view.expiresAt,
    get isOpen() {
      return view.isOpen
    },
    closed: view.closed,
    close: view.close,
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
    await view.close().catch(() => undefined)
    throw error
  }
}
