import knex, { type Knex } from 'knex'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { brc38StagingBinding } from './Brc38StagingBinding'
import {
  commitBrc38ImportJournalStep,
  prepareBrc38ImportJournal,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalStep
} from './Brc38ImportJournal'

export async function importJournalFixture(totalRows = 5) {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-import-journal-')),
    config: Knex.Config = {
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'destination.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    },
    k = knex(config),
    observer = knex(config)
  async function close(): Promise<void> {
    const results = await Promise.allSettled([k.destroy(), observer.destroy()]),
      failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length > 0) throw new AggregateError(failures, 'Import journal fixture retains physical cleanup')
    await rm(directory, { recursive: true, force: true })
  }
  try {
    await k.raw('PRAGMA journal_mode=WAL')
    await k.raw('PRAGMA foreign_keys=ON')
    await observer.raw('PRAGMA foreign_keys=ON')
    await observer.raw('PRAGMA busy_timeout=0')
    await k.transaction(async trx => await installBrc38ImportJournalSchema(trx))
    await k.raw(
      'CREATE TABLE native_import_rows (rowId INTEGER PRIMARY KEY, userId INTEGER NOT NULL, value TEXT NOT NULL)'
    )
    await k.raw('CREATE TABLE native_import_clock (slot INTEGER PRIMARY KEY, revision INTEGER NOT NULL)')
    await k.raw('INSERT INTO native_import_clock VALUES (1, 9007199254740992)')
    await k.raw(
      'CREATE TRIGGER native_import_insert AFTER INSERT ON native_import_rows BEGIN UPDATE native_import_clock SET revision = revision + 1 WHERE slot = 1; END'
    )
    async function destinationSha256(trx: Knex): Promise<string> {
      const value: { revision: string } | undefined = await trx('native_import_clock')
        .where({ slot: 1 })
        .first(trx.raw('CAST(revision AS TEXT) revision'))
      if (value === undefined) throw new Error('Synthetic destination clock missing')
      return createHash('sha256')
        .update(JSON.stringify({ directory, revision: value.revision, userId: 7 }))
        .digest('hex')
    }
    const expiresAt = Date.now() + 180000,
      originalBinding = brc38StagingBinding(
        {
          archiveSha256: 'b'.repeat(64),
          identityKey: 'synthetic identity',
          chain: 'test',
          sourceStorageIdentityKey: 'synthetic source',
          targetStorageIdentityKey: 'synthetic target',
          targetGeneration: 0
        },
        {
          maximumRows: 1000,
          maximumLogicalBytes: 1048576,
          maximumPhysicalBytes: 7340032,
          maximumRowBytes: 65536,
          maximumRowAllocationBytes: 65536,
          expiresAt
        }
      ),
      admission: Brc38ImportJournalAdmission = {
        scope: {
          importId: randomUUID(),
          bindingSha256: originalBinding.digest,
          archiveSha256: 'b'.repeat(64),
          userId: 7
        },
        previewId: randomUUID(),
        originalLimitsJson: originalBinding.limitsJson,
        expiresAt,
        initialDestinationSha256: await destinationSha256(k),
        totalRows,
        maximumStepRows: 128,
        maximumStepBytes: 65536,
        maximumMappedIds: 1000,
        maximumJournalLogicalBytes: 516096
      }
    function step(fromRow: number, rows: number): Brc38ImportJournalStep {
      return {
        fromRow,
        rows,
        bytes: rows * 128,
        mappedIds: rows,
        pageSha256: createHash('sha256').update(JSON.stringify({ fromRow, rows })).digest('hex')
      }
    }
    async function prepare(selected = admission) {
      return await k.transaction(
        async trx => await prepareBrc38ImportJournal(trx, selected, await destinationSha256(trx))
      )
    }
    async function apply(
      trx: Knex.Transaction,
      page: Brc38ImportJournalStep,
      incoming: (index: number) => number = index => index
    ): Promise<string> {
      const ordinals = Array.from({ length: page.rows }, (_value, index) => page.fromRow + index),
        prepared = await loadBrc38ImportIdMap(
          trx,
          admission.scope,
          ordinals.map(index => ({
            entity: 'transaction',
            incomingId: incoming(index),
            required: false
          }))
        )
      await trx('native_import_rows').insert(
        ordinals.map(index => ({ rowId: 100 + index, userId: 7, value: 'synthetic ' + index }))
      )
      for (const index of ordinals) prepared.map.transaction.idMap[incoming(index)] = 100 + index
      await prepared.persist()
      return await destinationSha256(trx)
    }
    async function commit(page: Brc38ImportJournalStep, incoming?: (index: number) => number) {
      return await k.transaction(
        async trx =>
          await commitBrc38ImportJournalStep(
            trx,
            admission,
            page,
            await destinationSha256(trx),
            async () => await apply(trx, page, incoming)
          )
      )
    }
    return {
      directory,
      k,
      observer,
      admission,
      destinationSha256,
      step,
      prepare,
      apply,
      commit,
      close
    }
  } catch (cause) {
    try {
      await close()
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Import journal fixture setup and cleanup failed')
    }
    throw cause
  }
}
