import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { SnapshotJournalReconciliationSource } from './SnapshotJournalCapture'
import { encodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import {
  captureSnapshotJournalIdentities,
  sealSnapshotJournalCapturedFrame,
  requireSnapshotJournalCapturedFrame,
  type SnapshotJournalCapturedIdentityLimits
} from './SnapshotJournalCapturedIdentities'
import {
  stageSnapshotJournalDestinationPage,
  type SnapshotJournalDestinationStageLimits,
  type SnapshotJournalDestinationStageReceipt
} from './SnapshotJournalDestinationStage'
import {
  snapshotJournalDestinationStreams,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import { snapshotJournalReceiptBinding } from './SnapshotJournalReceipt'
import { applySnapshotJournalProvenancePage, type SnapshotJournalProvenanceLimits } from './SnapshotJournalProvenance'

export interface SnapshotJournalCapturedPageLimits
  extends
    SnapshotJournalDestinationStageLimits,
    SnapshotJournalCapturedIdentityLimits,
    SnapshotJournalProvenanceLimits {
  maximumRows: number
  maximumPayloadBytes: number
}

/** Internal source-owned flow. The source must come from authenticated provider
 * admission, and writer admission must resolve the current destination/profile
 * inside its foreground-aware queue. Neither argument is an activation token.
 * No writer admission spans source I/O: identity prefixes use short metadata
 * commits, and only a source-complete frame can share an atomic intake ACK.
 */
export async function stageSnapshotJournalCapturedPage(
  source: SnapshotJournalReconciliationSource,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  inputLimits: SnapshotJournalCapturedPageLimits,
  withWriter: <T>(apply: (trx: Knex) => Promise<T>) => Promise<T>,
  signal?: AbortSignal,
  recordProgress?: (
    trx: Knex,
    result: { checkpoint: SnapshotJournalDestinationCheckpoint; result: SnapshotJournalDestinationStageReceipt }
  ) => Promise<void>
): Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; result: SnapshotJournalDestinationStageReceipt }> {
  const binding = { ...input, source: { ...input.source }, receipt: { ...input.receipt } }
  const state = { ...expected, ...(expected.after === undefined ? {} : { after: { ...expected.after } }) }
  const limits = { ...inputLimits }
  signal?.throwIfAborted()
  if (
    state.phase !== 'intake' ||
    !source.isOpen ||
    typeof source.readDeltaPage !== 'function' ||
    typeof withWriter !== 'function' ||
    snapshotJournalReceiptBinding(source.receiptBinding) !== snapshotJournalReceiptBinding(binding.source) ||
    JSON.stringify(source.receipt) !== JSON.stringify(binding.receipt)
  )
    throw new WERR_INVALID_OPERATION('Journal source differs from admitted destination window')
  const stream = snapshotJournalDestinationStreams[state.streamIndex]
  if (stream === undefined) throw new WERR_INVALID_OPERATION('Invalid journal intake stream')
  const captured = await source.readDeltaPage(
    {
      ...(binding.bootstrap === true ? { bootstrap: true as const } : {}),
      ...stream,
      low: binding.low,
      after: state.after,
      maximumRows: limits.maximumRows,
      maximumBytes: limits.maximumPayloadBytes
    },
    async (frameDigest, changeIndex, identities) => {
      signal?.throwIfAborted()
      await withWriter(trx =>
        captureSnapshotJournalIdentities(trx, binding, state, frameDigest, changeIndex, identities, limits)
      )
    }
  )
  signal?.throwIfAborted()
  const frame = encodeSnapshotJournalDeltaFrame(captured.page, stream)
  if (!source.isOpen || createHash('sha256').update(frame).digest('hex') !== captured.frameDigest)
    throw new WERR_INVALID_OPERATION('Captured journal frame changed before intake')
  return await withWriter(async trx => {
    signal?.throwIfAborted()
    await sealSnapshotJournalCapturedFrame(trx, binding, state, captured.frameDigest, captured.page.changes.length)
    await requireSnapshotJournalCapturedFrame(trx, binding, state, captured.frameDigest, captured.page.changes.length)
    if (stream.tableId === 7) await applySnapshotJournalProvenancePage(trx, binding, state, captured.page, limits)
    const result = await stageSnapshotJournalDestinationPage(trx, binding, state, captured.page, limits)
    if (recordProgress !== undefined) await recordProgress(trx, result)
    signal?.throwIfAborted()
    return result
  })
}
