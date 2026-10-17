import type { StorageIdb } from '../StorageIdb'
import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'
import type { TableProvenTx } from '../schema/tables'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { sameSyncProof } from '../methods/validateSyncProof'
import { mergeSyncChunkEntities } from '../schema/entities/mergeSyncChunkEntities'
import { detachSnapshotSyncFieldPage } from './SnapshotSyncFieldRows'
import { snapshotSyncScalarChunk, snapshotSyncScalarPage } from './SnapshotSyncScalarFields'
import { detachSnapshotSyncPage } from './SnapshotSyncRowData'
import {
  snapshotSyncTables,
  type SnapshotSyncCheckpoint,
  type SnapshotSyncCommit,
  type SnapshotSyncSource
} from './SnapshotSync'
import type { WalletReadSnapshot, WalletSnapshotFieldMetadataPage, WalletSnapshotPage } from './WalletReadSnapshot'
import { prepareIdbSnapshotSyncCommissions } from './IdbSnapshotSyncCommissions'
import { prepareIdbSnapshotSyncActions } from './IdbSnapshotSyncActions'
import { prepareIdbSnapshotSyncProvenTxs } from './IdbSnapshotSyncProvenTxs'
import { prepareIdbSnapshotSyncProvenTxReqs } from './IdbSnapshotSyncProvenTxReqs'
import { prepareIdbSnapshotSyncCertificates } from './IdbSnapshotSyncCertificates'
import { prepareIdbSnapshotSyncCertificateFields } from './IdbSnapshotSyncCertificateFields'
import type { SnapshotSyncFieldPreparation } from './SnapshotSync'
import { IdbSnapshotSyncJournal, captureIdbSnapshotSyncCheckpoint } from './IdbSnapshotSyncJournal'

/** Bounded full-row and independently negotiated field replica paths. Proof I/O and caller-data detachment finish
 * before manager write admission. Occupied destination rows, existing entity
 * policies, dependency mappings, primary fences and durable checkpoint share
 * the actual same-owner native transaction. Field I/O/staging finishes before
 * the final writer; all twelve table policies have explicit dispatch. */
export class IdbSnapshotSyncDestination {
  constructor(
    private readonly storage: StorageIdb,
    private readonly prepareProofs: (chunk: SyncChunk) => Promise<Map<string, TableProvenTx>>
  ) {}
  async supportsDestination(): Promise<boolean> {
    // Genuine layout/owner/lifecycle, freshly checked. A failed operational
    // probe gives no permission to mutate an unpublished restore candidate.
    try {
      await IdbSnapshotSyncJournal.open(this.storage)
      return true
    } catch {
      return false
    }
  }
  async begin(source: SnapshotSyncSource, activeStorage: string | undefined): Promise<SnapshotSyncCheckpoint> {
    // Journal captures input before its first await; do not postpone that
    // capture behind asynchronous provider admission.
    const captured: SnapshotSyncSource = {
      version: source.version,
      snapshotId: source.snapshotId,
      expiresAt: source.expiresAt,
      user: {
        ...source.user,
        created_at: new Date(source.user.created_at),
        updated_at: new Date(source.user.updated_at)
      },
      sourceStorage: { ...source.sourceStorage }
    }
    return await (await IdbSnapshotSyncJournal.open(this.storage)).begin(captured, activeStorage)
  }
  async checkpoint(identityKey: string, sourceIdentity: string): Promise<SnapshotSyncCheckpoint | undefined> {
    return await (await IdbSnapshotSyncJournal.open(this.storage)).checkpoint(identityKey, sourceIdentity)
  }
  /** These are original aggregate admission ceilings, not extra permission or
   * an increase in the caller's limits. Existing current metadata and issued
   * stages remain charged simultaneously through final drainage. */
  readonly fieldPageLimits = Object.freeze({ maxRows: 128, maxBytes: 262144 })
  async prepareFields(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<(typeof snapshotSyncTables)[number]>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    const expected = captureIdbSnapshotSyncCheckpoint(input)
    const rows = Object.getOwnPropertyDescriptor(page, 'rows'),
      bytes = Object.getOwnPropertyDescriptor(page, 'payloadBytes'),
      length =
        rows === undefined || !Object.hasOwn(rows, 'value') || !Array.isArray(rows.value)
          ? undefined
          : Object.getOwnPropertyDescriptor(rows.value, 'length')?.value
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > this.fieldPageLimits.maxRows ||
      bytes === undefined ||
      !Object.hasOwn(bytes, 'value') ||
      !Number.isSafeInteger(bytes.value) ||
      bytes.value < 0 ||
      bytes.value > this.fieldPageLimits.maxBytes
    )
      throw new WERR_INVALID_OPERATION('Snapshot field page exceeds its original destination admission')
    // Each component independently detaches the complete metadata envelope and
    // validates actual cursor/table/source bindings before its first I/O.
    switch (snapshotSyncTables[expected.tableIndex]) {
      // These narrow the metadata contract only. Each component's detached
      // parser rechecks the actual table, source position and complete scalar/
      // descriptor form; no complete wallet DTO is fabricated by a cast.
      case 'provenTxs':
        return await this.prepareProvenTxs(
          expected,
          page as WalletSnapshotFieldMetadataPage<'provenTxs'>,
          source,
          signal
        )
      case 'transactions':
        return await this.prepareTransactions(
          expected,
          page as WalletSnapshotFieldMetadataPage<'transactions'>,
          source,
          signal
        )
      case 'outputs':
        return await this.prepareOutputs(expected, page as WalletSnapshotFieldMetadataPage<'outputs'>, source, signal)
      case 'certificates':
        return await this.prepareCertificates(
          expected,
          page as WalletSnapshotFieldMetadataPage<'certificates'>,
          source,
          signal
        )
      case 'certificateFields':
        return await this.prepareCertificateFields(
          expected,
          page as WalletSnapshotFieldMetadataPage<'certificateFields'>,
          source,
          signal
        )
      case 'commissions':
        return await this.prepareCommissions(
          expected,
          page as WalletSnapshotFieldMetadataPage<'commissions'>,
          source,
          signal
        )
      case 'provenTxReqs':
        return await this.prepareProvenTxReqs(
          expected,
          page as WalletSnapshotFieldMetadataPage<'provenTxReqs'>,
          source,
          signal
        )
      case 'outputBaskets':
      case 'outputTags':
      case 'txLabels':
      case 'txLabelMaps':
      case 'outputTagMaps':
        return await this.prepareScalarFields(expected, page, source, signal)
      default:
        throw new WERR_INVALID_OPERATION('Snapshot sync is already complete')
    }
  }
  /** Actual complete certificate-field component. */
  async prepareCertificateFields(
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'certificateFields'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareIdbSnapshotSyncCertificateFields(this.storage, checkpoint, page, source, signal)
  }
  async prepareCertificates(
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'certificates'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareIdbSnapshotSyncCertificates(this.storage, checkpoint, page, source, signal)
  }
  async prepareCommissions(
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'commissions'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareIdbSnapshotSyncCommissions(this.storage, checkpoint, page, source, signal)
  }
  async prepareTransactions(
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'transactions'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareIdbSnapshotSyncActions(this.storage, checkpoint, page, source, signal)
  }
  async prepareProvenTxs(
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'provenTxs'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareIdbSnapshotSyncProvenTxs(this.storage, checkpoint, page, source, signal)
  }
  async prepareOutputs(
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'outputs'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareIdbSnapshotSyncActions(this.storage, checkpoint, page, source, signal)
  }
  async prepareProvenTxReqs(
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<'provenTxReqs'>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    return await prepareIdbSnapshotSyncProvenTxReqs(this.storage, checkpoint, page, source, signal)
  }
  /** Five complete scalar-table components, using actual existing entity
   * methods and the operational journal. */
  async prepareScalarFields(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<(typeof snapshotSyncTables)[number]>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ): Promise<SnapshotSyncFieldPreparation> {
    const expected = captureIdbSnapshotSyncCheckpoint(input),
      detached = detachSnapshotSyncFieldPage(expected, page),
      chunk = snapshotSyncScalarChunk(expected, detached.rows),
      binding = Object.freeze({
        snapshotId: source.snapshotId,
        identityKey: source.user.identityKey,
        sourceUserId: source.user.userId,
        sourceStorage: source.sourceStorage.storageIdentityKey,
        chain: source.sourceStorage.chain,
        expiresAt: source.expiresAt
      }),
      deadline = performance.now() + binding.expiresAt - Date.now()
    let closed = false,
      consumed = false,
      applying: Promise<SnapshotSyncCommit> | undefined
    const check = (): void => {
      signal?.throwIfAborted()
      if (
        closed ||
        !source.isOpen ||
        source.fieldReader === undefined ||
        binding.snapshotId !== expected.snapshotId ||
        source.snapshotId !== binding.snapshotId ||
        source.expiresAt !== binding.expiresAt ||
        binding.identityKey !== expected.identityKey ||
        source.user.identityKey !== binding.identityKey ||
        source.user.userId !== binding.sourceUserId ||
        binding.sourceStorage !== expected.sourceStorageIdentityKey ||
        source.sourceStorage.storageIdentityKey !== binding.sourceStorage ||
        source.sourceStorage.chain !== binding.chain ||
        binding.chain !== this.storage.chain ||
        Date.now() >= binding.expiresAt ||
        performance.now() >= deadline
      )
        throw new WERR_INVALID_OPERATION('Scalar field source/checkpoint/resource admission ended')
    }
    check()
    const journal = await IdbSnapshotSyncJournal.open(this.storage)
    await journal.inspect(expected, async read => {
      if (read.sourceUserId !== binding.sourceUserId)
        throw new WERR_INVALID_OPERATION('Scalar field source profile differs')
      await read.loadFieldMappings(
        snapshotSyncTables[expected.tableIndex],
        detached.rows.map(row => row.fields)
      )
    })
    check()
    const operation = await this.prepare(
      expected,
      snapshotSyncScalarPage(
        expected,
        chunk,
        detached.allocationBytes,
        detached.nextTable !== expected.tableIndex,
        detached.rows.length === 0 ? expected.cursor : detached.rows[detached.rows.length - 1].cursor
      ),
      signal
    )
    check()
    return Object.freeze({
      apply: async () => {
        check()
        if (consumed)
          throw new WERR_INVALID_OPERATION('Scalar field preparation already consumed; read its durable checkpoint')
        consumed = true
        applying = operation()
        try {
          const outcome = await applying
          check()
          return outcome
        } finally {
          applying = undefined
        }
      },
      close: async () => {
        closed = true
        if (applying !== undefined)
          try {
            await applying
          } catch {
            /* Actual apply owns its original outcome. */
          }
      }
    })
  }
  async prepare(
    input: SnapshotSyncCheckpoint,
    page: WalletSnapshotPage<(typeof snapshotSyncTables)[number]>,
    signal?: AbortSignal
  ): Promise<() => Promise<SnapshotSyncCommit>> {
    const expected = captureIdbSnapshotSyncCheckpoint(input),
      detached = detachSnapshotSyncPage(expected, page),
      proofs = await this.prepareProofs(detached.chunk),
      journal = await IdbSnapshotSyncJournal.open(this.storage)
    signal?.throwIfAborted()
    let consumed = false
    return async () => {
      signal?.throwIfAborted()
      if (consumed)
        throw new WERR_INVALID_OPERATION('Prepared packed snapshot page already consumed; read its durable checkpoint')
      consumed = true
      return await journal.commit(expected, detached.nextTable, detached.nextCursor, async writer => {
        signal?.throwIfAborted()
        // Proofs are current-row DATA, not cached validation authority. Existing
        // proof policy performs its original marker/active-chain requirements.
        for (const previous of [...proofs.values()].sort((a, b) => a.txid.localeCompare(b.txid))) {
          const rows = await this.storage.findProvenTxs({ partial: { txid: previous.txid }, trx: writer.transaction })
          if (rows.length !== 1 || !sameSyncProof(rows[0], previous))
            throw new WERR_INVALID_OPERATION(
              'Proof changed during packed snapshot preparation; resume its durable checkpoint'
            )
        }
        const mappings = await writer.loadMappings(snapshotSyncTables[expected.tableIndex], detached.chunk)
        if (expected.sequence === 0) detached.chunk.user = { ...writer.sourceUser }
        const result = await mergeSyncChunkEntities(
          this.storage,
          writer.user.userId,
          undefined,
          detached.chunk,
          mappings.map,
          writer.transaction
        )
        await mappings.persist()
        signal?.throwIfAborted()
        return { inserts: result.inserts, updates: result.updates }
      })
    }
  }
}
