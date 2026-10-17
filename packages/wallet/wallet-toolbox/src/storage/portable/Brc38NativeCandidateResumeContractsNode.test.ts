import {
  hasBrc38PrivatePriorImportSchema,
  brc38PrivatePriorImportRows,
  brc38PrivatePriorImportBudget
} from './Brc38PrivatePriorImportSchemaNode'
import { Brc38PrivateLocalCandidate } from './Brc38PrivateLocalCandidateNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import {
  brc38PrivateLocalCandidateStateTable,
  brc38PrivateLocalCandidatePointTable,
  hasBrc38PrivateLocalCandidateJournal
} from './Brc38PrivateLocalCandidateJournalNode'
import { runInSeries } from '../../utility/runInSeries'
import type { Knex } from 'knex'
import {
  withBrc38NativeCandidateContractFixture,
  type Brc38NativeCandidateContractFixture
} from './Brc38NativeCandidateContractFixture'
import {
  verifyBrc38PrivateLocalCandidateResume,
  verifyBrc38PrivateLocalCandidateUniqueRebuild,
  type IndependentLocalCandidateRow
} from './Brc38PrivateLocalCandidateNode.case'
import {
  copyIndependentNativeInventory,
  wipeIndependentNativeInventory
} from './Brc38IndependentNativeInventoryFixture'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'

// This scenario owns initial COPY, resumed changes and full postimage reads.
// Give those two complete phases one fixed envelope; never renew it.
const nativeCandidateFixtureLifetimeMs = 2 * 300000
const nativeCandidateCaseTimeoutMs = nativeCandidateFixtureLifetimeMs + 30000
// UNIQUE recovery completes an initial COPY, drains it, then completes a fresh
// COPY. Admit two existing copy windows under the same finite fixture owner.
const nativeCandidateRebuildFixtureLifetimeMs = 2 * nativeCandidateFixtureLifetimeMs
const nativeCandidateRebuildCaseTimeoutMs = nativeCandidateRebuildFixtureLifetimeMs + 30000

const one = (rows: readonly IndependentLocalCandidateRow[]): IndependentLocalCandidateRow => {
    if (rows.length !== 1) throw new Error('Independent resume fixture requires one original row')
    return rows[0]
  },
  integer = (original: unknown, value: number): number | bigint =>
    typeof original === 'bigint' ? BigInt(value) : value,
  writeSource = async (
    fixture: Brc38NativeCandidateContractFixture,
    operation: (writer: Knex.Transaction) => Promise<void>
  ): Promise<void> => {
    await fixture.source.manager.runAsStorageProvider(async active => {
      if (active !== fixture.source.storage) throw new Error('Candidate resume fixture selected another source')
      await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(fixture.source.storage, async writer => {
        expect(await writer('snapshot_journal_clock').first('enabled', 'reason')).toEqual({ enabled: 1, reason: null })
        await operation(writer)
        expect(await writer('snapshot_journal_clock').first('enabled', 'reason')).toEqual({ enabled: 1, reason: null })
      })
    })
  }

// Expected complete postimages are declared from the separate source
// preimage before changing the real source. FK checks remain on; SQLite's
// transaction-local deferral checks the final graph at the actual commit.
test(
  'actual local candidate resumes all47 copying and catches parent removal, signed reuse and recovery fields',
  async () => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        const changed = copyIndependentNativeInventory(fixture.initial),
          basket = one(changed.output_baskets),
          output = one(changed.outputs),
          session = one(changed.snapshot_sync_sessions),
          mapping = one(changed.snapshot_sync_ids),
          replacement = Uint8Array.from([1, 254, 127, 2, 1]),
          text = Buffer.from('independent replacement \u0000雪😀'),
          reusedMonitor = {
            rowId: -105,
            metadata: {
              ...one(changed.monitor_events).metadata,
              id: integer(one(changed.monitor_events).metadata.id, -105),
              event: 'independent signed replacement'
            },
            fields: { details: text }
          }
        changed.output_baskets = [
          {
            ...basket,
            rowId: 101,
            metadata: {
              ...basket.metadata,
              basketId: integer(basket.metadata.basketId, 101),
              name: 'independent replacement basket'
            }
          }
        ]
        changed.outputs = [
          { ...output, metadata: { ...output.metadata, basketId: integer(output.metadata.basketId, 101) } }
        ]
        changed.monitor_events = [reusedMonitor]
        changed.action_batch_blobs = changed.action_batch_blobs.map(row => ({ ...row, fields: { bytes: replacement } }))
        changed.action_batches = changed.action_batches.map(row => ({
          ...row,
          fields: { ...row.fields, manifest: null }
        }))
        changed.snapshot_sync_sessions = [
          {
            ...session,
            metadata: {
              ...session.metadata,
              sequence: integer(session.metadata.sequence, 1),
              cursor: 'independent checkpoint'
            }
          }
        ]
        changed.snapshot_sync_ids = [
          { ...mapping, metadata: { ...mapping.metadata, incomingId: integer(mapping.metadata.incomingId, 116) } }
        ]
        try {
          await verifyBrc38PrivateLocalCandidateResume(
            {
              ...fixture,
              mutateSource: async () =>
                await writeSource(fixture, async writer => {
                  await writer.raw('PRAGMA defer_foreign_keys=ON')
                  // Delete the old parent before its surviving child's later update.
                  expect(
                    await writer('output_baskets')
                      .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(basket.rowId).toString()])
                      .delete()
                  ).toBe(1)
                  await writer('output_baskets').insert(changed.output_baskets[0].metadata)
                  expect(
                    await writer('outputs')
                      .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(output.rowId).toString()])
                      .update({ basketId: 101 })
                  ).toBe(1)
                  expect(await writer('monitor_events').where({ id: 400 }).delete()).toBe(1)
                  await writer('monitor_events').insert({ ...reusedMonitor.metadata, details: text.toString('utf8') })
                  // This genuine published source has ordinary auxiliary fields. Its
                  // private candidate packs them; source mutation retains that actual
                  // source layout instead of sending it a private marker-only writer.
                  expect(
                    await writer('action_batch_blobs')
                      .where({ actionBatchBlobId: 403 })
                      .update({ bytes: Buffer.from(replacement) })
                  ).toBe(1)
                  expect(await writer('action_batches').where({ actionBatchId: 402 }).update({ manifest: null })).toBe(
                    1
                  )
                  expect(
                    await writer('snapshot_sync_sessions')
                      .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(session.rowId).toString()])
                      .update({ sequence: 1, cursor: 'independent checkpoint' })
                  ).toBe(1)
                  expect(
                    await writer('snapshot_sync_ids')
                      .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(mapping.rowId).toString()])
                      .update({ incomingId: 116 })
                  ).toBe(1)
                })
            },
            fixture.initial,
            changed
          )
        } finally {
          wipeIndependentNativeInventory(changed)
          replacement.fill(0)
          text.fill(0)
        }
      },
      { lifetimeMs: nativeCandidateFixtureLifetimeMs, maximumNativeReadBytes: 16384 }
    )
  },
  nativeCandidateCaseTimeoutMs
)

test(
  'actual local candidate drains a UNIQUE rebuild and resumes after natural-key reuse and a key swap',
  async () => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        const changed = copyIndependentNativeInventory(fixture.initial),
          basket = one(changed.output_baskets),
          output = one(changed.outputs),
          labels = changed.tx_labels
        if (labels.length !== 2 || labels[0].metadata.label === labels[1].metadata.label)
          throw new Error('Independent unique rebuild requires two distinct original labels')
        const originalKeys = labels.map(row => row.metadata.label)
        changed.output_baskets = [
          { ...basket, rowId: 101, metadata: { ...basket.metadata, basketId: integer(basket.metadata.basketId, 101) } }
        ]
        changed.outputs = [
          { ...output, metadata: { ...output.metadata, basketId: integer(output.metadata.basketId, 101) } }
        ]
        changed.tx_labels = labels.map((row, index) => ({
          ...row,
          metadata: { ...row.metadata, label: originalKeys[1 - index] }
        }))
        try {
          await verifyBrc38PrivateLocalCandidateUniqueRebuild(
            {
              ...fixture,
              mutateSource: async () =>
                await writeSource(fixture, async writer => {
                  await writer.raw('PRAGMA defer_foreign_keys=ON')
                  expect(
                    await writer('output_baskets')
                      .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(basket.rowId).toString()])
                      .delete()
                  ).toBe(1)
                  await writer('output_baskets').insert(changed.output_baskets[0].metadata)
                  expect(
                    await writer('outputs')
                      .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(output.rowId).toString()])
                      .update({ basketId: 101 })
                  ).toBe(1)
                  expect(
                    await writer('tx_labels')
                      .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(labels[0].rowId).toString()])
                      .update({ label: 'independent temporary swap key' })
                  ).toBe(1)
                  expect(
                    await writer('tx_labels')
                      .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(labels[1].rowId).toString()])
                      .update({ label: originalKeys[0] })
                  ).toBe(1)
                  expect(
                    await writer('tx_labels')
                      .whereRaw('rowid=CAST(? AS INTEGER)', [BigInt(labels[0].rowId).toString()])
                      .update({ label: originalKeys[1] })
                  ).toBe(1)
                })
            },
            fixture.initial,
            changed
          )
        } finally {
          wipeIndependentNativeInventory(changed)
        }
      },
      {
        lifetimeMs: nativeCandidateRebuildFixtureLifetimeMs,
        maximumNativeReadBytes: 16384,
        prepareSource: async source => {
          await source.manager.runAsStorageProvider(async active => {
            if (active !== source.storage) throw new Error('Independent key-swap fixture selected another source')
            await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(source.storage, async writer => {
              const rows = await writer('tx_labels').select('*').limit(2)
              if (rows.length !== 1) throw new Error('Independent key-swap fixture requires one original label')
              expect(await writer('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
                enabled: 1,
                reason: null
              })
              await writer('tx_labels').insert({
                ...rows[0],
                txLabelId: 106,
                label: 'independent second original label'
              })
              expect(await writer('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
                enabled: 1,
                reason: null
              })
            })
          })
        }
      }
    )
  },
  nativeCandidateRebuildCaseTimeoutMs
)

test('native COPY uses its admitted batch budget and resumes the exact stored checkpoint', async () => {
  await withBrc38NativeCandidateContractFixture(
    async fixture => {
      const maximumStepRows = 4,
        options = { ...fixture.options, maximumStepRows },
        expectedLabels = fixture.initial.tx_labels.length
      expect(
        fixture.initial.tx_labels.filter(row => String(row.metadata.label).startsWith('batch-budget-'))
      ).toHaveLength(19)
      let done = false,
        priorLabels = 0,
        observedLabelBatch = false
      const advance = async (): Promise<void> => {
        const progress = await fixture.withSource(
          async source =>
            await Brc38PrivateLocalCandidate.with(
              fixture.store,
              source,
              options,
              async candidate => await candidate.step()
            )
        )
        expect(progress.copiedRows).toBeGreaterThanOrEqual(0)
        expect(progress.copiedRows).toBeLessThanOrEqual(maximumStepRows)
        const labels = await fixture.withRead(async trx => await trx('tx_labels').select('txLabelId', 'label'))
        const added = labels.length - priorLabels
        expect(added).toBeGreaterThanOrEqual(0)
        expect(added).toBeLessThanOrEqual(maximumStepRows)
        observedLabelBatch ||= added > 1
        priorLabels = labels.length
        // Independent scalar source rows have no unresolved parent dependency.
        // Their actual postimages must demonstrate batching, not only a report.
        if (labels.length === expectedLabels) expect(observedLabelBatch).toBe(true)
        done = progress.recoveryRequired && progress.garbageComplete
        fixture.check()
      }
      await advance()
      const checkpoint = async () =>
        await fixture.withRead(async trx => {
          const rows = await trx(brc38PrivateLocalCandidateStateTable)
            .where({ slot: 1 })
            .select('phase', 'copyTable', 'afterRowId', 'records')
            .limit(2)
          expect(rows).toHaveLength(1)
          return rows[0]
        })
      const before = await checkpoint(),
        binding = fixture.store.binding?.digest
      expect(before.phase).toBe('COPY')
      await fixture.reopen()
      expect(fixture.store.binding?.digest).toBe(binding)
      expect(await checkpoint()).toEqual(before)
      await runInSeries(Array(256).keys(), async () => {
        if (!done) await advance()
      })
      expect(done).toBe(true)
      expect(observedLabelBatch).toBe(true)
      const actual = await fixture.readCandidate()
      try {
        expect(actual).toEqual(fixture.initial)
      } finally {
        wipeIndependentNativeInventory(actual)
      }
    },
    {
      lifetimeMs: 600000,
      prepareSource: async source => {
        await source.manager.runAsStorageProvider(async active => {
          expect(active).toBe(source.storage)
          await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(source.storage, async writer => {
            const when = new Date('2026-10-08T00:00:00.000Z'),
              userId = source.manager.getActiveUser().userId
            await runInSeries(Array(19).keys(), async index => {
              const txLabelId = 2000 + index
              expect(
                await source.storage.insertTxLabel(
                  {
                    txLabelId,
                    userId,
                    created_at: when,
                    updated_at: when,
                    label: `batch-budget-${String(index).padStart(2, '0')}`,
                    isDeleted: index % 3 === 0
                  },
                  writer
                )
              ).toBe(txLabelId)
            })
          })
        })
      }
    }
  )
}, 630000)

// Genuine prior-custody schema, actual native query packets and independent
// DDL mutations. No prior match is retained as authority for a later read.
test('native prior custody uses admitted batches and bounded fresh schema packets', async () => {
  const native = (
    require('../../../test/utils/nativeProfileMeasurement.cjs') as {
      observeNativeProfileMeasurement(): {
        beginPhase(): void
        report(): { nativeSqlQueries: number }
        close(): void
      }
    }
  ).observeNativeProfileMeasurement()
  let failed = false,
    failure: unknown
  try {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        let escaped: Brc38NativeLocalBaselineSource | undefined
        await fixture.withSource(async source => {
          escaped = source
          native.beginPhase()
          const before = await Brc38NativeLocalBaselineSource.facts(source)
          expect(await Brc38NativeLocalBaselineSource.facts(source)).toEqual(before)
          // Observe genuine native pipes while the actual private query-only
          // view is retained. Two operations need two fresh clock reads.
          expect(native.report().nativeSqlQueries).toBe(2)
        })
        if (escaped === undefined) throw new Error('Actual source read facade was not issued')
        await expect(Brc38NativeLocalBaselineSource.facts(escaped)).rejects.toThrow()
        const options = { ...fixture.options, maximumStepRows: 16 }
        let complete = false
        await runInSeries(Array(256).keys(), async () => {
          if (!complete)
            await fixture.withSource(
              async source =>
                await Brc38PrivateLocalCandidate.with(fixture.store, source, options, async candidate => {
                  const progress = await candidate.step()
                  complete = progress.recoveryRequired && progress.garbageComplete
                })
            )
        })
        expect(complete).toBe(true)
        // Observe actual current native queries, not a query/constructor mock.
        const journalPackets: number[] = []
        await fixture.withRead(async trx => {
          const query = (value: { sql: string; bindings: unknown[] }): void => {
            if (!value.sql.includes('sqlite_schema')) return
            expect(value.bindings.every(item => typeof item === 'string' || Number.isSafeInteger(item))).toBe(true)
            journalPackets.push(
              16 +
                Buffer.byteLength(value.sql) +
                value.bindings.reduce<number>(
                  (sum, item) => sum + (typeof item === 'string' ? 5 + Buffer.byteLength(item) : 9),
                  0
                )
            )
          }
          trx.on('query', query)
          try {
            expect(await hasBrc38PrivateLocalCandidateJournal(trx)).toBe(true)
          } finally {
            trx.off('query', query)
          }
        })
        expect(journalPackets).toHaveLength(3)
        expect(journalPackets.every(bytes => bytes <= 65537)).toBe(true)
        await fixture.withWriter(async trx => {
          const trigger = brc38PrivateLocalCandidateStateTable + '_update'
          const original = await trx('sqlite_schema').where({ type: 'trigger', name: trigger }).select('sql').limit(2)
          expect(original).toHaveLength(1)
          expect(typeof original[0].sql).toBe('string')
          await runInSeries([false, true], async changed => {
            await trx.raw('SAVEPOINT independent_candidate_journal_comparison')
            try {
              await trx.raw('DROP TRIGGER ??', [trigger])
              if (changed) await trx.raw(original[0].sql.replace(' BEGIN ', ' BEGIN SELECT 1; '))
              await expect(hasBrc38PrivateLocalCandidateJournal(trx)).rejects.toThrow(
                'Private local candidate journal differs from its actual owner, exact schema or original progress'
              )
            } finally {
              await trx.raw('ROLLBACK TO independent_candidate_journal_comparison')
              await trx.raw('RELEASE independent_candidate_journal_comparison')
            }
            expect(await hasBrc38PrivateLocalCandidateJournal(trx)).toBe(true)
          })
          await trx.raw('SAVEPOINT independent_candidate_journal_index')
          try {
            await trx.raw('CREATE INDEX independent_candidate_journal_extra ON ??(revision)', [
              brc38PrivateLocalCandidatePointTable
            ])
            await expect(hasBrc38PrivateLocalCandidateJournal(trx)).rejects.toThrow(
              'Private local candidate journal differs from its actual owner, exact schema or original progress'
            )
          } finally {
            await trx.raw('ROLLBACK TO independent_candidate_journal_index')
            await trx.raw('RELEASE independent_candidate_journal_index')
          }
          expect(await hasBrc38PrivateLocalCandidateJournal(trx)).toBe(true)
        })
        await fixture.withSource(
          async source =>
            await Brc38PrivateLocalCandidate.with(fixture.store, source, options, async candidate => {
              const progress = await candidate.copyPriorImportStep()
              expect(progress.complete).toBe(false)
            })
        )
        const storedRecords = await fixture.withRead(async trx => {
          const rows = await trx(brc38PrivatePriorImportRows).count({ count: '*' }).first()
          expect(Number.isSafeInteger(rows?.count)).toBe(true)
          return Number(rows!.count)
        })
        expect(storedRecords).toBeGreaterThan(0)
        expect(storedRecords).toBeLessThanOrEqual(options.maximumStepRows)
        const checkpoint = async () =>
          await fixture.withRead(async trx => {
            const rows = await trx(brc38PrivatePriorImportBudget)
              .where({ slot: 1 })
              .select('copyTable', 'afterRowId', 'records', 'logicalBytes')
              .limit(2)
            expect(rows).toHaveLength(1)
            return rows[0]
          })
        const beforeReopen = await checkpoint(),
          binding = fixture.store.binding?.digest
        expect(beforeReopen.records).toBe(storedRecords)
        await fixture.reopen()
        expect(fixture.store.binding?.digest).toBe(binding)
        expect(await checkpoint()).toEqual(beforeReopen)
        const packets: number[] = []
        await fixture.withRead(async trx => {
          const query = (value: { sql: string; bindings: unknown[] }): void => {
            if (!value.sql.includes('sqlite_schema')) return
            expect(value.bindings.every(item => typeof item === 'string' || Number.isSafeInteger(item))).toBe(true)
            packets.push(
              16 +
                Buffer.byteLength(value.sql) +
                value.bindings.reduce<number>(
                  (sum, item) => sum + (typeof item === 'string' ? 5 + Buffer.byteLength(item) : 9),
                  0
                )
            )
          }
          trx.on('query', query)
          try {
            expect(await hasBrc38PrivatePriorImportSchema(trx)).toBe(true)
          } finally {
            trx.off('query', query)
          }
        })
        const trigger = brc38PrivatePriorImportRows + '_delete'
        const original = await fixture.withRead(async trx => {
          const rows = await trx('sqlite_schema').where({ name: trigger, type: 'trigger' }).select('sql').limit(2)
          expect(rows).toHaveLength(1)
          expect(typeof rows[0].sql).toBe('string')
          return rows[0].sql as string
        })
        const changed = original.replace(' BEGIN ', ' BEGIN SELECT 1; ')
        expect(changed).not.toBe(original)
        await fixture.withWriter(async trx => {
          await trx.raw('DROP TRIGGER ??', [trigger])
          await trx.raw(changed)
        })
        await fixture.withRead(async trx => {
          await expect(hasBrc38PrivatePriorImportSchema(trx)).rejects.toThrow(
            'Prior import custody exact definition differs'
          )
        })
        await fixture.withWriter(async trx => {
          await trx.raw('DROP TRIGGER ??', [trigger])
          await trx.raw(original)
        })
        const extra = 'brc38_local_prior_import_independent_extra'
        await fixture.withWriter(async trx => {
          await trx.raw('CREATE TRIGGER ?? BEFORE DELETE ON ?? BEGIN SELECT 1; END', [
            extra,
            brc38PrivatePriorImportRows
          ])
        })
        await fixture.withRead(async trx => {
          await expect(hasBrc38PrivatePriorImportSchema(trx)).rejects.toThrow('Prior import custody schema differs')
        })
        await fixture.withWriter(async trx => {
          await trx.raw('DROP TRIGGER ??', [extra])
        })
        const index = 'independent_prior_custody_index'
        await fixture.withWriter(async trx => {
          await trx.raw('CREATE INDEX ?? ON ??(state)', [index, brc38PrivatePriorImportRows])
        })
        await fixture.withRead(async trx => {
          await expect(hasBrc38PrivatePriorImportSchema(trx)).rejects.toThrow(
            'Prior import custody has an extra object'
          )
        })
        await fixture.withWriter(async trx => {
          await trx.raw('DROP INDEX ??', [index])
        })
        await fixture.withRead(async trx => {
          expect(await hasBrc38PrivatePriorImportSchema(trx)).toBe(true)
        })
        // Five complete comparisons: prefix, exact definitions, full family, and
        // each of the two original implicit primary indexes. Packet bound includes
        // SQL, native cell and request framing under the existing 65,537-byte floor.
        expect(packets.length).toBeGreaterThan(0)
        expect(packets.every(bytes => bytes <= 65537)).toBe(true)
        if (packets.length > 5 || storedRecords <= 1)
          throw new Error(
            `Native prior admission unused: schema packets=${packets.length}, stored rows=${storedRecords}`
          )
        const extraSourceTrigger = 'brc38_local_baseline_read_view_probe'
        await writeSource(fixture, async writer => {
          await writer.raw('CREATE TRIGGER ?? BEFORE DELETE ON brc38_local_baseline_clock BEGIN SELECT 1; END', [
            extraSourceTrigger
          ])
        })
        try {
          // A prior successful facade cannot authorize a changed later view.
          await expect(
            fixture.withSource(async source => await Brc38NativeLocalBaselineSource.facts(source))
          ).rejects.toThrow('Local baseline original generation, schema or progress differs')
        } finally {
          await writeSource(fixture, async writer => {
            await writer.raw('DROP TRIGGER ??', [extraSourceTrigger])
          })
        }
        await fixture.withSource(async source => {
          expect((await Brc38NativeLocalBaselineSource.facts(source)).generation.enabled).toBe(true)
        })
        fixture.check()
      },
      { lifetimeMs: 600000 }
    )
  } catch (error_) {
    failed = true
    failure = error_
  }
  try {
    native.close()
  } catch (error_) {
    throw new AggregateError(
      failed ? [failure, error_] : [error_],
      'Retained source regression preserves original observer cleanup failure'
    )
  }
  if (failed) throw failure
}, 630000)
