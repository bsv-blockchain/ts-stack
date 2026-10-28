import type { SnapshotArchiveRequestOwner } from '../archive/SnapshotArchiveRequest'
import type { Knex } from 'knex'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { SnapshotJournalDelta } from './SnapshotJournalTypes'
import { SnapshotJournalPreparedEntityMerge } from './SnapshotJournalEntityMerge'
import { promoteSnapshotJournalChanges } from './KnexSnapshotJournalDestination'
import { promoteSnapshotJournalDestinationFieldBatch } from './SnapshotJournalDestinationPromotion'
import { readSnapshotJournalDestinationFieldPromotionPage } from './SnapshotJournalDestinationStage'
import { verifySnapshotJournalCapturedIdentityPrefix } from './SnapshotJournalCapturedIdentities'
import type { SnapshotJournalHashedFieldDelta } from './SnapshotJournalFieldTypes'
import {
  prepareSnapshotJournalNativeActionMerge,
  prepareSnapshotJournalNativeRequestMerge,
  prepareSnapshotJournalNativeSimpleMerge,
  prepareSnapshotJournalNativeProofMerge
} from './SnapshotJournalNativeActionMerge'
import { createHash } from 'node:crypto'
import type { StorageKnex } from '../../StorageKnex'
import { WERR_INVALID_OPERATION, WERR_UNAUTHORIZED } from '../../../sdk/WERR_errors'
import type { SnapshotJournalDestinationLimits, SnapshotJournalWriterAdmission } from './SnapshotJournalProvider'
import type { SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'
import {
  parseSnapshotJournalFieldArchiveBinding,
  type SnapshotJournalFieldArchiveBinding
} from './SnapshotJournalArchiveBinding'
import { snapshotJournalReceiptBinding } from './SnapshotJournalReceipt'
import { KnexSnapshotJournalWindowDestination } from './KnexSnapshotJournalWindowDestination'
import { KnexSnapshotJournalDataContentReceipts } from './KnexSnapshotJournalDataContentReceipts'
import {
  withSnapshotJournalDestinationWindowFence,
  snapshotJournalDestinationStreams
} from './SnapshotJournalDestinationWindow'
import {
  captureSnapshotJournalIdentities,
  sealSnapshotJournalCapturedFrame,
  requireSnapshotJournalCapturedFrame
} from './SnapshotJournalCapturedIdentities'
import { stageSnapshotJournalDestinationFieldPage } from './SnapshotJournalDestinationStage'
import { advanceSnapshotJournalProgress } from './SnapshotJournalProgress'
import { encodeSnapshotJournalFieldFrame } from './SnapshotJournalDeltaFrame'
import { PreparedSnapshotJournalFieldProvenance } from './SnapshotJournalProvenance'
import {
  assertRemoteSnapshotJournalFieldArchive,
  assertRemoteSnapshotJournalFieldFrame,
  type RemoteSnapshotJournalFieldArchive
} from './openRemoteSnapshotJournalFieldArchive'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal field destination differs from its actual admitted artifact/window')
}

/** Version-4 intake owns the actual authenticated archive and target writer.
 * Staged metadata is not a financial completion/primary-selection ACK. This
 * class deliberately does not inherit the version-3 row staging/promoter. */
export class KnexSnapshotJournalFieldDestination extends KnexSnapshotJournalWindowDestination {
  declare readonly close?: () => Promise<void>

  static async begin(
    storage: StorageKnex,
    identityKey: string,
    input: SnapshotJournalFieldArchiveBinding,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal,
    uploadOwner?: Readonly<SnapshotArchiveRequestOwner>
  ): Promise<{ destination: KnexSnapshotJournalFieldDestination; checkpoint: SnapshotJournalDestinationCheckpoint }> {
    const source = parseSnapshotJournalFieldArchiveBinding(input)
    return await this.beginWindow(
      storage,
      identityKey,
      source,
      limits,
      admission,
      (binding, ownedLimits, root) =>
        new KnexSnapshotJournalFieldDestination(storage, binding, ownedLimits, admission, signal, root, uploadOwner),
      signal,
      uploadOwner
    )
  }
  static async resume(
    storage: StorageKnex,
    identityKey: string,
    sourceStorageIdentity: string,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal,
    allowPreviousRowForFieldNegotiation?: true,
    uploadOwner?: Readonly<SnapshotArchiveRequestOwner>
  ): Promise<KnexSnapshotJournalFieldDestination | undefined> {
    return await this.resumeWindow(
      storage,
      identityKey,
      sourceStorageIdentity,
      limits,
      admission,
      'wallet-journal-fields/1',
      (binding, ownedLimits, root) =>
        new KnexSnapshotJournalFieldDestination(storage, binding, ownedLimits, admission, signal, root, uploadOwner),
      allowPreviousRowForFieldNegotiation
    )
  }

  async stageArchiveFrame(
    expected: SnapshotJournalDestinationCheckpoint,
    archive: RemoteSnapshotJournalFieldArchive
  ): Promise<SnapshotJournalDestinationCheckpoint> {
    expected = { ...expected, ...(expected.after === undefined ? {} : { after: { ...expected.after } }) }
    return await this.exclusive(async () => {
      this.signal?.throwIfAborted()
      if (!archive.isOpen) invalid()
      assertRemoteSnapshotJournalFieldArchive(archive)
      const stream = snapshotJournalDestinationStreams[expected.streamIndex],
        source = parseSnapshotJournalFieldArchiveBinding(archive.manifest.binding)
      if (source.user.identityKey !== this.binding.source.identityKey)
        throw new WERR_UNAUTHORIZED('Journal field artifact belongs to a different authenticated profile')
      if (
        !archive.isOpen ||
        expected.phase !== 'intake' ||
        stream === undefined ||
        this.binding.fieldEncoding !== 'wallet-journal-fields/1' ||
        snapshotJournalReceiptBinding(source.journal.source) !== snapshotJournalReceiptBinding(this.binding.source) ||
        JSON.stringify(source.journal.receipt) !== JSON.stringify(this.binding.receipt) ||
        source.journal.low !== this.binding.low ||
        source.journal.bootstrap !== (this.binding.bootstrap === true)
      )
        invalid()
      await this.verifyCurrent()
      // Network reads occur outside target writer admission. Each independently
      // bounded identity prefix is fenced in the genuine physical transaction.
      const frame = await archive.readFrame(expected.sequence, async (digest, index, identities) => {
        this.signal?.throwIfAborted()
        await this.writer(
          async trx =>
            await withSnapshotJournalDestinationWindowFence(
              trx,
              this.binding,
              expected,
              async fenced =>
                await captureSnapshotJournalIdentities(
                  fenced,
                  this.binding,
                  expected,
                  digest,
                  index,
                  identities,
                  this.limits
                )
            )
        )
      })
      assertRemoteSnapshotJournalFieldFrame(archive, frame)
      const bytes = encodeSnapshotJournalFieldFrame(frame.page, stream)
      if (
        frame.ordinal !== expected.sequence ||
        frame.stream !== stream.stream ||
        frame.tableId !== stream.tableId ||
        createHash('sha256').update(bytes).digest('hex') !== frame.frameDigest
      )
        invalid()
      for (const change of frame.page.changes) {
        if (change.present && Object.hasOwn(change.row, 'userId') && change.row.userId !== this.binding.source.userId)
          throw new WERR_UNAUTHORIZED('Journal field row belongs to a different source profile')
      }
      // Prepare actual bytes outside the final writer. Partial custody can
      // resume, while metadata links and the intake cursor commit together.
      const provenance =
        stream.tableId === 7
          ? await PreparedSnapshotJournalFieldProvenance.prepare(
              this.storage,
              this.binding,
              expected,
              archive,
              frame,
              this.limits,
              this.admission,
              this.signal
            )
          : undefined
      try {
        await this.verifyCurrent()
        return await this.writer(async trx => {
          this.signal?.throwIfAborted()
          assertRemoteSnapshotJournalFieldFrame(archive, frame)
          // A resumed controller must agree with the actual artifact's pending
          // content record; copied JSON cannot restamp a different session.
          await new KnexSnapshotJournalDataContentReceipts(this.storage, this.root).pending(
            trx as import('knex').Knex.Transaction,
            this.binding,
            expected,
            source.snapshotId,
            source.journal.contentRevision
          )
          await sealSnapshotJournalCapturedFrame(
            trx,
            this.binding,
            expected,
            frame.frameDigest,
            frame.page.changes.length
          )
          await requireSnapshotJournalCapturedFrame(
            trx,
            this.binding,
            expected,
            frame.frameDigest,
            frame.page.changes.length
          )
          if (provenance !== undefined) await provenance.apply(trx)
          const committed = await stageSnapshotJournalDestinationFieldPage(
            trx,
            this.binding,
            expected,
            frame.page,
            this.limits
          )
          await advanceSnapshotJournalProgress(trx, this.binding, expected, committed.checkpoint, {
            pages: 1,
            examined: committed.result.examined,
            payloadBytes: committed.result.bytes
          })
          return committed.checkpoint
        })
      } finally {
        provenance?.close()
      }
    })
  }

  async promote(expected: SnapshotJournalDestinationCheckpoint, archive: RemoteSnapshotJournalFieldArchive) {
    expected = { ...expected, ...(expected.after === undefined ? {} : { after: { ...expected.after } }) }
    return await this.exclusive(async () => {
      assertRemoteSnapshotJournalFieldArchive(archive)
      const source = parseSnapshotJournalFieldArchiveBinding(archive.manifest.binding),
        expiresAt = Math.min(archive.expiresAt, this.binding.receipt.expiresAt),
        deadline = performance.now() + expiresAt - Date.now()
      const verify = async (): Promise<void> => {
        this.signal?.throwIfAborted()
        assertRemoteSnapshotJournalFieldArchive(archive)
        if (
          expected.phase !== 'promoting' ||
          Date.now() >= expiresAt ||
          performance.now() >= deadline ||
          source.user.identityKey !== this.binding.source.identityKey ||
          snapshotJournalReceiptBinding(source.journal.source) !== snapshotJournalReceiptBinding(this.binding.source) ||
          JSON.stringify(source.journal.receipt) !== JSON.stringify(this.binding.receipt) ||
          source.journal.low !== this.binding.low ||
          source.journal.bootstrap !== (this.binding.bootstrap === true)
        )
          invalid()
        await this.verifyCurrent()
      }
      return await promoteSnapshotJournalChanges<SnapshotJournalHashedFieldDelta>(
        this.binding,
        expected,
        isOwnedNativeSqlite(this.root) ? this.limits : { ...this.limits, maximumChanges: 1 },
        async apply => await this.writer(apply),
        verify,
        {
          readPage: readSnapshotJournalDestinationFieldPromotionPage,
          batch: promoteSnapshotJournalDestinationFieldBatch,
          prepare: async (change, receipt, index) => {
            await verify()
            const frame = await archive.readFrame(
              receipt.sequence - 1,
              async (digest, changeIndex, identities) =>
                await this.writer(
                  async trx =>
                    await verifySnapshotJournalCapturedIdentityPrefix(
                      trx,
                      this.binding,
                      expected,
                      digest,
                      changeIndex,
                      identities
                    )
                )
            )
            assertRemoteSnapshotJournalFieldFrame(archive, frame)
            const encoded = encodeSnapshotJournalFieldFrame(frame.page, {
              stream: frame.stream,
              tableId: frame.tableId
            })
            if (
              receipt.digest !== frame.frameDigest ||
              receipt.tableId !== frame.tableId ||
              encoded.length !== receipt.bytes ||
              createHash('sha256').update(encoded).digest('hex') !== receipt.digest ||
              index >= frame.page.changes.length ||
              JSON.stringify(frame.page.changes[index]) !== JSON.stringify(change)
            )
              invalid()
            if (!change.present) invalid()
            if (Object.keys(change.fields).length === 0) {
              const complete: SnapshotJournalDelta = {
                  metadata: change.metadata,
                  present: true,
                  row: { ...change.row }
                },
                effect = await SnapshotJournalPreparedEntityMerge.prepare(
                  this.storage,
                  this.binding,
                  complete,
                  receipt,
                  index,
                  this.limits.maximumAllocationBytes,
                  this.signal
                )
              return {
                apply: async (trx, binding, state, actualChange, actualReceipt, actualIndex) => {
                  if (!actualChange.present || Object.keys(actualChange.fields).length !== 0) invalid()
                  const actualComplete: SnapshotJournalDelta = {
                    metadata: actualChange.metadata,
                    present: true,
                    row: { ...actualChange.row }
                  }
                  return await effect.apply(
                    trx,
                    binding,
                    state,
                    actualComplete,
                    actualReceipt,
                    actualIndex,
                    this.limits
                  )
                }
              }
            }
            if (!isOwnedNativeSqlite(this.root))
              return await SnapshotJournalPreparedEntityMerge.prepareArchiveFields(
                this.storage,
                this.binding,
                expected,
                receipt,
                index,
                archive,
                frame,
                this.limits,
                this.admission,
                this.signal
              )
            if ([0, 1].includes(receipt.tableId))
              return await prepareSnapshotJournalNativeActionMerge(
                this.storage,
                this.binding,
                expected,
                receipt,
                index,
                archive,
                frame,
                this.limits,
                this.admission,
                this.signal
              )
            if (receipt.tableId === 8)
              return await prepareSnapshotJournalNativeProofMerge(
                this.storage,
                this.binding,
                expected,
                receipt,
                index,
                archive,
                frame,
                this.limits,
                this.admission,
                this.signal
              )
            if (receipt.tableId === 9)
              return await prepareSnapshotJournalNativeRequestMerge(
                this.storage,
                this.binding,
                expected,
                receipt,
                index,
                archive,
                frame,
                this.limits,
                this.admission,
                this.signal
              )
            if ([2, 6, 12].includes(receipt.tableId))
              return await prepareSnapshotJournalNativeSimpleMerge(
                this.storage,
                this.binding,
                expected,
                receipt,
                index,
                archive,
                frame,
                this.limits,
                this.admission,
                this.signal
              )
            throw new WERR_INVALID_OPERATION(
              'Journal field semantic component is not yet completely implemented for this entity'
            )
          }
        },
        this.signal,
        async (trx, checkpoint) =>
          await new KnexSnapshotJournalDataContentReceipts(this.storage, this.root).complete(
            trx as Knex.Transaction,
            this.binding,
            checkpoint
          )
      )
    })
  }
}
