import { KnexSnapshotJournalDataContentReceipts } from './KnexSnapshotJournalDataContentReceipts'
import { validateSyncProofs } from '../../remoting/validateRpcSyncProofs'
import type { TableProvenTx } from '../../schema/tables'
import type { StorageKnex } from '../../StorageKnex'
import { WERR_INVALID_OPERATION, WERR_UNAUTHORIZED } from '../../../sdk/WERR_errors'
import type { SnapshotJournalDestinationLimits, SnapshotJournalWriterAdmission } from './SnapshotJournalProvider'
import type { SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'
import { parseSnapshotJournalArchiveBinding, type SnapshotJournalArchiveBinding } from './SnapshotJournalArchiveBinding'
import { decodeSnapshotJournalArchivePacket } from './SnapshotJournalArchivePacket'
import {
  withSnapshotJournalDestinationWindowFence,
  snapshotJournalDestinationStreams
} from './SnapshotJournalDestinationWindow'
import {
  captureSnapshotJournalIdentities,
  sealSnapshotJournalCapturedFrame,
  requireSnapshotJournalCapturedFrame
} from './SnapshotJournalCapturedIdentities'
import { stageSnapshotJournalDestinationPage } from './SnapshotJournalDestinationStage'
import { applySnapshotJournalProvenancePage } from './SnapshotJournalProvenance'
import { advanceSnapshotJournalProgress } from './SnapshotJournalProgress'
import { promoteSnapshotJournalData } from './KnexSnapshotJournalDestination'
import { KnexSnapshotJournalWindowDestination } from './KnexSnapshotJournalWindowDestination'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal DATA destination differs from its actual admitted window')
}

/** Version-3 row receiver. Field windows remain owned by their separate receiver. */
export class KnexSnapshotJournalDataDestination extends KnexSnapshotJournalWindowDestination {
  static async begin(
    storage: StorageKnex,
    identityKey: string,
    input: SnapshotJournalArchiveBinding,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal
  ): Promise<{ destination: KnexSnapshotJournalDataDestination; checkpoint: SnapshotJournalDestinationCheckpoint }> {
    const source = parseSnapshotJournalArchiveBinding(input)
    return await this.beginWindow(
      storage,
      identityKey,
      source,
      limits,
      admission,
      (binding, ownedLimits, root) =>
        new KnexSnapshotJournalDataDestination(storage, binding, ownedLimits, admission, signal, root),
      signal
    )
  }
  static async resume(
    storage: StorageKnex,
    identityKey: string,
    sourceStorageIdentity: string,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal
  ): Promise<KnexSnapshotJournalDataDestination | undefined> {
    return await this.resumeWindow(
      storage,
      identityKey,
      sourceStorageIdentity,
      limits,
      admission,
      undefined,
      (binding, ownedLimits, root) =>
        new KnexSnapshotJournalDataDestination(storage, binding, ownedLimits, admission, signal, root)
    )
  }
  /** Bounded DATA prefixes may replay without advancing the durable intake ACK.
   * A complete verified frame seals them and stages provenance plus ACK atomically. */
  async stagePacket(
    expected: SnapshotJournalDestinationCheckpoint,
    input: Uint8Array
  ): Promise<SnapshotJournalDestinationCheckpoint> {
    expected = { ...expected, ...(expected.after === undefined ? {} : { after: { ...expected.after } }) }
    return await this.exclusive(async () => {
      this.signal?.throwIfAborted()
      const stream = snapshotJournalDestinationStreams[expected.streamIndex]
      if (expected.phase !== 'intake' || stream === undefined) invalid()
      const packet = decodeSnapshotJournalArchivePacket(input, stream, this.binding.receipt.highWater)
      await this.verifyCurrent()
      if (packet.kind !== 'frame') {
        const groups = packet.kind === 'identities' ? [packet] : packet.groups
        await this.writer(
          async trx =>
            await withSnapshotJournalDestinationWindowFence(trx, this.binding, expected, async fenced => {
              for (const group of groups)
                await captureSnapshotJournalIdentities(
                  fenced,
                  this.binding,
                  expected,
                  packet.frameDigest,
                  group.changeIndex,
                  group.identities,
                  this.limits
                )
            })
        )
        return { ...expected, ...(expected.after === undefined ? {} : { after: { ...expected.after } }) }
      }
      for (const change of packet.page.changes) {
        if (change.present && Object.hasOwn(change.row, 'userId') && change.row.userId !== this.binding.source.userId)
          throw new WERR_UNAUTHORIZED('Journal DATA row belongs to a different source profile')
      }
      if (stream.tableId === 8) {
        const proofs = packet.page.changes.flatMap(change =>
          change.present ? [change.row as unknown as TableProvenTx] : []
        )
        if (proofs.length) await validateSyncProofs(this.storage, proofs)
        // Refresh policy may validate a replacement proof, but never rewrites the
        // integrity-bound original frame or grants its candidate a cached verdict.
        await this.verifyCurrent()
      }
      const result = await this.writer(async trx => {
        this.signal?.throwIfAborted()
        await sealSnapshotJournalCapturedFrame(
          trx,
          this.binding,
          expected,
          packet.frameDigest,
          packet.page.changes.length
        )
        await requireSnapshotJournalCapturedFrame(
          trx,
          this.binding,
          expected,
          packet.frameDigest,
          packet.page.changes.length
        )
        if (stream.tableId === 7)
          await applySnapshotJournalProvenancePage(trx, this.binding, expected, packet.page, this.limits)
        const committed = await stageSnapshotJournalDestinationPage(
          trx,
          this.binding,
          expected,
          packet.page,
          this.limits
        )
        await advanceSnapshotJournalProgress(trx, this.binding, expected, committed.checkpoint, {
          pages: 1,
          examined: committed.result.examined,
          payloadBytes: committed.result.bytes
        })
        return committed
      })
      return result.checkpoint
    })
  }
  async promote(expected: SnapshotJournalDestinationCheckpoint) {
    return await this.exclusive(
      async () =>
        await promoteSnapshotJournalData(
          this.storage,
          this.binding,
          expected,
          this.limits,
          async apply => await this.writer(apply),
          async () => await this.verifyCurrent(),
          this.signal,
          async (trx, checkpoint) =>
            await new KnexSnapshotJournalDataContentReceipts(this.storage, this.root).complete(
              trx,
              this.binding,
              checkpoint
            )
        )
    )
  }
}
