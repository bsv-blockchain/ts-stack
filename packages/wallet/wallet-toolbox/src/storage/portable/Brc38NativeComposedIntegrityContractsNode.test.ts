import type { Knex } from 'knex'
import { withBrc38NativeCandidateContractFixture } from './Brc38NativeCandidateContractFixture'
import { nativeMergeExpectedFixture } from './Brc38NativeMergeExpectedFixture'
import { captureComposedSemanticFixture } from './Brc38ComposedSemanticFixture'
import {
  wipeIndependentNativeInventory,
  type IndependentNativeInventory
} from './Brc38IndependentNativeInventoryFixture'
import { reserveBrc38NativeIncomingIds } from './Brc38NativeIncomingIdReservationNode'
import { runBrc38PrivateNativeMerge } from './Brc38PrivateNativeMergeRunnerNode'
import { Brc38PrivateNativeMergeNode } from './Brc38PrivateNativeMergeNode'
import { writeBrc38NativePackedBytes } from './Brc38NativePackedFieldsNode'
import { writeBrc38NativePackedTextBytes } from './Brc38NativePackedTextFieldsNode'
import type {
  Brc38NativePackedBinaryCoordinate,
  Brc38NativePackedTextCoordinate
} from './Brc38NativeLocalPackedCoordinate'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'

// Admit the existing 180-second fixture owner plus 30 seconds of cleanup.
const nativeFixtureCaseTimeoutMs = 180000 + 30000

type WithoutRow<T> = T extends unknown ? Omit<T, 'rowId'> : never
type Damage =
  | Readonly<{
      kind: 'metadata'
      table: keyof IndependentNativeInventory
      field: string
      change: 'append' | 'increment' | 'toggle'
    }>
  | Readonly<{
      kind: 'binary'
      table: keyof IndependentNativeInventory
      coordinate: WithoutRow<Brc38NativePackedBinaryCoordinate>
    }>
  | Readonly<{
      kind: 'text'
      table: keyof IndependentNativeInventory
      coordinate: WithoutRow<Brc38NativePackedTextCoordinate>
    }>
const damages: readonly Damage[] = [
  { kind: 'metadata', table: 'users', field: 'activeStorage', change: 'append' },
  { kind: 'metadata', table: 'settings', field: 'storageName', change: 'append' },
  { kind: 'metadata', table: 'proven_txs', field: 'height', change: 'increment' },
  { kind: 'metadata', table: 'proven_tx_reqs', field: 'attempts', change: 'increment' },
  { kind: 'metadata', table: 'output_baskets', field: 'numberOfDesiredUTXOs', change: 'increment' },
  { kind: 'metadata', table: 'output_tags', field: 'isDeleted', change: 'toggle' },
  { kind: 'metadata', table: 'tx_labels', field: 'label', change: 'append' },
  { kind: 'metadata', table: 'transactions', field: 'satoshis', change: 'increment' },
  { kind: 'metadata', table: 'outputs', field: 'satoshis', change: 'increment' },
  { kind: 'metadata', table: 'commissions', field: 'isRedeemed', change: 'toggle' },
  { kind: 'metadata', table: 'tx_labels_map', field: 'isDeleted', change: 'toggle' },
  { kind: 'metadata', table: 'output_tags_map', field: 'isDeleted', change: 'toggle' },
  { kind: 'metadata', table: 'certificates', field: 'isDeleted', change: 'toggle' },
  { kind: 'metadata', table: 'monitor_events', field: 'event', change: 'append' },
  { kind: 'metadata', table: 'prepared_beef_metadata', field: 'proofEpoch', change: 'increment' },
  { kind: 'metadata', table: 'auth_sessions', field: 'lastUpdate', change: 'increment' },
  { kind: 'metadata', table: 'auth_message_nonces', field: 'expiresAt', change: 'increment' },
  { kind: 'metadata', table: 'snapshot_sync_sessions', field: 'sequence', change: 'increment' },
  { kind: 'metadata', table: 'snapshot_sync_ids', field: 'localId', change: 'increment' },
  { kind: 'metadata', table: 'snapshot_sync_primary_epochs', field: 'epoch', change: 'increment' },
  { kind: 'metadata', table: 'snapshot_reconciliation_window_progress', field: 'commits', change: 'increment' },
  { kind: 'binary', table: 'proven_txs', coordinate: { table: 'provenTxs', field: 'rawTx' } },
  { kind: 'binary', table: 'proven_txs', coordinate: { table: 'provenTxs', field: 'merklePath' } },
  { kind: 'binary', table: 'outputs', coordinate: { table: 'outputs', field: 'lockingScript' } },
  { kind: 'binary', table: 'prepared_beefs', coordinate: { table: 'prepared_beefs', field: 'beef' } },
  { kind: 'binary', table: 'action_batch_blobs', coordinate: { table: 'action_batch_blobs', field: 'bytes' } },
  { kind: 'binary', table: 'sync_transfer_parts', coordinate: { table: 'sync_transfer_parts', field: 'bytes' } },
  {
    kind: 'binary',
    table: 'snapshot_reconciliation_stage_pages',
    coordinate: { table: 'snapshot_reconciliation_stage_pages', field: 'payload' }
  },
  {
    kind: 'binary',
    table: 'snapshot_reconciliation_provenance',
    coordinate: { table: 'snapshot_reconciliation_provenance', field: 'payload' }
  },
  { kind: 'text', table: 'transactions', coordinate: { table: 'transactions', field: 'description' } },
  { kind: 'text', table: 'certificate_fields', coordinate: { table: 'certificateFields', field: 'fieldValue' } },
  { kind: 'text', table: 'certificates', coordinate: { table: 'certificates', field: 'subject' } },
  { kind: 'text', table: 'commissions', coordinate: { table: 'commissions', field: 'keyOffset' } },
  { kind: 'text', table: 'proven_tx_reqs', coordinate: { table: 'provenTxReqs', field: 'history' } },
  { kind: 'text', table: 'proven_tx_reqs', coordinate: { table: 'provenTxReqs', field: 'notify' } },
  { kind: 'text', table: 'sync_states', coordinate: { table: 'syncStates', field: 'syncMap' } },
  { kind: 'text', table: 'monitor_events', coordinate: { table: 'monitor_events', field: 'details' } },
  { kind: 'text', table: 'action_batches', coordinate: { table: 'action_batches', field: 'uploadDigests' } },
  { kind: 'text', table: 'sync_transfers', coordinate: { table: 'sync_transfers', field: 'result' } }
]

/** These source-only cases exercise the enclosing fresh comparison itself.
 * Each isolated actual native candidate first completes its original program,
 * matches a separately declared all47 oracle, commits one real wrong postimage,
 * rejects it, restores that fixture cell and passes the full comparison again.
 * No copied producer, schema weakening or receipt-as-authority is involved. */
test.each(damages)(
  'complete current comparison rejects $kind mutation in $table',
  async damage => {
    await withBrc38NativeCandidateContractFixture(async fixture => {
      const expected = nativeMergeExpectedFixture(
          fixture.initial,
          await captureComposedSemanticFixture(fixture.source.manager),
          fixture.source.incomingData
        ),
        inspect = async () =>
          await fixture.withSource(
            async source =>
              await Brc38PrivateNativeMergeNode.with(
                fixture.store,
                source,
                fixture.options,
                async merge => await merge.inspectComposedRows()
              )
          )
      try {
        await reserveBrc38NativeIncomingIds(
          fixture.source.storage,
          fixture.selection,
          previewReceiptPolicy,
          fixture.store,
          { workingAllocation: fixture.options.workingAllocation }
        )
        const iterator = runBrc38PrivateNativeMerge(
          fixture.store,
          fixture.source.storage,
          fixture.selection,
          fixture.options,
          4096
        )
        let complete = false
        try {
          for (let operation = 0; !complete && operation < 4097; operation++) {
            fixture.check()
            complete = (await iterator.next()).done === true
          }
        } finally {
          await iterator.return(undefined as never)
        }
        expect(complete).toBe(true)
        const before = await fixture.readCandidate()
        try {
          expect(before).toEqual(expected)
        } finally {
          wipeIndependentNativeInventory(before)
        }
        const row = expected[damage.table][0]
        if (row === undefined) throw new Error('Independent full comparison fault omitted its original row')
        let restore: (trx: Knex.Transaction) => Promise<void>
        if (damage.kind === 'metadata') {
          const original = row.metadata[damage.field]
          let changed: string | number | bigint
          if (damage.change === 'append' && typeof original === 'string') changed = original + ' independent fault'
          else if (damage.change === 'increment' && typeof original === 'bigint') changed = original + 1n
          else if (damage.change === 'increment' && typeof original === 'number' && Number.isSafeInteger(original))
            changed = original + 1
          else if (
            damage.change === 'toggle' &&
            (original === 0 || original === 1 || original === 0n || original === 1n)
          )
            changed = typeof original === 'bigint' ? 1n - original : 1 - original
          else throw new Error('Independent full comparison fault has a different original cell type')
          await fixture.withWriter(async trx => {
            expect(
              await trx(damage.table)
                .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(row.rowId).toString()])
                .update({ [damage.field]: changed })
            ).toBe(1)
          })
          restore = async trx => {
            expect(
              await trx(damage.table)
                .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(row.rowId).toString()])
                .update({ [damage.field]: original })
            ).toBe(1)
          }
        } else {
          const original = row.fields[damage.coordinate.field]
          if (original === null || original === undefined || original.length < 1 || original.length > 131072)
            throw new Error('Independent packed fault omitted its bounded complete original bytes')
          const changed = Uint8Array.from(original)
          // Exact length is retained; neither a descriptor nor a producer hash
          // can make changed logical content equal the original source.
          changed[0] ^= 1
          try {
            await fixture.withWriter(async trx => {
              if (damage.kind === 'binary')
                await writeBrc38NativePackedBytes(trx, { ...damage.coordinate, rowId: row.rowId }, changed)
              else await writeBrc38NativePackedTextBytes(trx, { ...damage.coordinate, rowId: row.rowId }, changed)
            })
          } finally {
            changed.fill(0)
          }
          restore = async trx => {
            if (damage.kind === 'binary')
              await writeBrc38NativePackedBytes(trx, { ...damage.coordinate, rowId: row.rowId }, original)
            else await writeBrc38NativePackedTextBytes(trx, { ...damage.coordinate, rowId: row.rowId }, original)
          }
        }
        try {
          fixture.check()
          await expect(inspect()).rejects.toThrow()
          fixture.check()
        } finally {
          await fixture.withWriter(restore)
        }
        const after = await fixture.readCandidate()
        try {
          expect(after).toEqual(expected)
        } finally {
          wipeIndependentNativeInventory(after)
        }
        expect((await inspect()).rows).toBe(Object.values(expected).reduce((sum, rows) => sum + rows.length, 0))
      } finally {
        wipeIndependentNativeInventory(expected)
      }
    })
  },
  nativeFixtureCaseTimeoutMs
)
