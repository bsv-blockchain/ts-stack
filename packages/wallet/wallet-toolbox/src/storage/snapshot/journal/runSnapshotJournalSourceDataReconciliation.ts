import { awaitVoidFromSync } from '../../../utility/promiseFromSync'
import { parseSnapshotJournalReceiptBindingData } from './SnapshotJournalReceiptData'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { SnapshotJournalReconciliationSource, SnapshotJournalDestinationLimits } from './SnapshotJournalProvider'
import type { SnapshotJournalDestinationCheckpoint } from './SnapshotJournalTypes'
import {
  parseSnapshotJournalArchiveBinding,
  snapshotJournalArchiveStreams,
  type SnapshotJournalArchiveBinding
} from './SnapshotJournalArchiveBinding'
import {
  encodeSnapshotJournalArchiveIdentities,
  encodeSnapshotJournalArchiveFrame,
  decodeSnapshotJournalArchivePacket
} from './SnapshotJournalArchivePacket'
import type { SnapshotJournalDataDestination } from './runSnapshotJournalArchiveReconciliation'
import {
  runSnapshotJournalReconciliation,
  type SnapshotJournalReconciliationOptions,
  type SnapshotJournalReconciliationProgress
} from './runSnapshotJournalReconciliation'

/** The original concrete retained SQL source remains owned locally. Its DATA
 * packets cross the endpoint; its SQL commit/current-data fences never do.
 * Only a retained read spans remote I/O. Actual target ACKs and source physical
 * cleanup retain the existing coordinator's cancellation/restart contracts. */
export async function* runSnapshotJournalSourceDataReconciliation(
  source: SnapshotJournalReconciliationSource,
  input: SnapshotJournalArchiveBinding,
  openDestination: () => Promise<SnapshotJournalDataDestination>,
  limits: SnapshotJournalDestinationLimits,
  options: SnapshotJournalReconciliationOptions = {}
): AsyncGenerator<SnapshotJournalReconciliationProgress, SnapshotJournalReconciliationProgress, void> {
  const binding = parseSnapshotJournalArchiveBinding(input)
  return yield* runSnapshotJournalReconciliation(
    source,
    async () => {
      await source.verifyLive()
      if (
        source.snapshotId !== binding.snapshotId ||
        JSON.stringify(parseSnapshotJournalReceiptBindingData(source.receiptBinding)) !==
          JSON.stringify(binding.journal.source) ||
        JSON.stringify(source.receipt) !== JSON.stringify(binding.journal.receipt)
      )
        throw new WERR_INVALID_OPERATION('Journal DATA differs from its actual retained local source')
      if (binding.journal.bootstrap) await source.validateClosure()
      const destination = await openDestination()
      return {
        status: () => destination.status(),
        intake: async (expected: SnapshotJournalDestinationCheckpoint) => {
          const stream = snapshotJournalArchiveStreams[expected.streamIndex]
          if (expected.phase !== 'intake' || stream === undefined)
            throw new WERR_INVALID_OPERATION('Invalid actual journal DATA intake stream')
          const context = { stream: stream.stream, tableId: stream.tableId }
          const captured = await (source.readArchiveDeltaPage?.bind(source) ?? source.readDeltaPage.bind(source))(
            {
              ...(binding.journal.bootstrap ? { bootstrap: true as const } : {}),
              ...context,
              low: binding.journal.low,
              ...(expected.after === undefined ? {} : { after: expected.after }),
              maximumRows: limits.maximumRows,
              maximumBytes: limits.maximumPayloadBytes
            },
            (digest, index, identities) =>
              awaitVoidFromSync(() =>
                destination.stagePacket(
                  expected,
                  encodeSnapshotJournalArchiveIdentities(
                    context,
                    digest,
                    index,
                    identities,
                    binding.journal.receipt.highWater
                  )
                )
              )
          )
          const bytes = encodeSnapshotJournalArchiveFrame(context, captured.page),
            verified = decodeSnapshotJournalArchivePacket(bytes, context, binding.journal.receipt.highWater)
          if (verified.kind !== 'frame' || verified.frameDigest !== captured.frameDigest)
            throw new WERR_INVALID_OPERATION('Actual local journal frame changed before DATA intake')
          await source.verifyLive()
          return await destination.stagePacket(expected, bytes)
        },
        promote: expected => destination.promote(expected)
      }
    },
    options
  )
}
