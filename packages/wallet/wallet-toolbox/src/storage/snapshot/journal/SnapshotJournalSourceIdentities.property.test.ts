import fc from 'fast-check'
import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { readSnapshotJournalSourceIdentities } from './SnapshotJournalSourceIdentities'

jest.setTimeout(30000)
const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
let db: Knex
let directory: string
const high = snapshotJournalRevision('9223372036854775807')
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-source-identities-property-'))
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'source.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  await db.raw('PRAGMA journal_mode = WAL')
  await db.raw(
    'CREATE TABLE transactions(transactionId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,reference TEXT NOT NULL UNIQUE,txid TEXT)'
  )
  await db.raw(
    'CREATE TABLE outputs(outputId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,transactionId INTEGER NOT NULL,vout INTEGER NOT NULL,txid TEXT)'
  )
  await db.raw(
    'CREATE TABLE commissions(commissionId INTEGER PRIMARY KEY,userId INTEGER NOT NULL,transactionId INTEGER NOT NULL,keyOffset TEXT)'
  )
  await db.raw(
    'CREATE TABLE snapshot_journal_physical(tableId INTEGER NOT NULL,id1 INTEGER NOT NULL,id2 INTEGER NOT NULL,exactText TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(tableId,id1,id2,exactText))'
  )
  await db.raw(
    'CREATE TABLE snapshot_profile_keys_v2(snapshotTableId INTEGER NOT NULL,snapshotUserId INTEGER NOT NULL,snapshotRowId INTEGER NOT NULL,PRIMARY KEY(snapshotTableId,snapshotUserId,snapshotRowId))'
  )
})
afterEach(async () => {
  await db.destroy()
  rmSync(directory, { recursive: true, force: true })
})

test('generated relocation, txid discovery and exact parent replacement preserve only the appropriate associations', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        reference: fc
          .array(fc.constantFrom('a', 'Z', ' ', '\0', '\u00e9', 'e\u0301', '\u{1f600}'), {
            minLength: 1,
            maxLength: 20
          })
          .map(x => x.join('')),
        vout: fc.integer({ min: 0, max: 2147483647 }),
        generation: fc.integer({ min: 1, max: 1000 }),
        offset: fc.integer({ min: 10, max: 10000 })
      }),
      async model => {
        await expect(
          db.transaction(async trx => {
            async function seed(parentId: number): Promise<void> {
              await trx('transactions').insert({
                transactionId: parentId,
                userId: 1,
                reference: model.reference
              })
              await trx('outputs').insert({
                outputId: parentId,
                userId: 1,
                transactionId: parentId,
                vout: model.vout,
                txid: 'a'.repeat(64)
              })
              await trx('commissions').insert({
                commissionId: parentId,
                userId: 1,
                transactionId: parentId,
                keyOffset: 'original-value'
              })
              for (const tableId of [0, 1, 6]) {
                await trx('snapshot_journal_physical').insert({
                  tableId,
                  id1: parentId,
                  id2: 0,
                  exactText: '',
                  generation: model.generation,
                  revision: model.generation,
                  present: 1
                })
                await trx('snapshot_profile_keys_v2').insert({
                  snapshotTableId: tableId,
                  snapshotUserId: 1,
                  snapshotRowId: parentId
                })
              }
            }
            await seed(1)
            const first = await readSnapshotJournalSourceIdentities(trx, 1, high, [
              { tableId: 1, incomingId: 1 },
              { tableId: 6, incomingId: 1 }
            ])
            // Compare two independently populated layouts, never duplicate a unique
            // reference in one layout. These synthetic generations are data only.
            for (const table of [
              'outputs',
              'commissions',
              'transactions',
              'snapshot_journal_physical',
              'snapshot_profile_keys_v2'
            ])
              await trx(table).delete()
            await seed(model.offset)
            const relocated = await readSnapshotJournalSourceIdentities(trx, 1, high, [
              { tableId: 1, incomingId: model.offset },
              { tableId: 6, incomingId: model.offset }
            ])
            for (const tableId of [0, 1, 6])
              expect(first.get(tableId + ':1')?.naturalIdentity).toBe(
                relocated.get(tableId + ':' + model.offset)?.naturalIdentity
              )
            for (const table of [
              'outputs',
              'commissions',
              'transactions',
              'snapshot_journal_physical',
              'snapshot_profile_keys_v2'
            ])
              await trx(table).delete()
            await seed(1)
            const refs = [
              { tableId: 1 as const, incomingId: 1 },
              { tableId: 6 as const, incomingId: 1 }
            ]
            const initial = await readSnapshotJournalSourceIdentities(trx, 1, high, refs)
            expect(initial.get('0:1')?.required).toBe(true)
            expect(initial.get('1:1')?.naturalKey).toEqual({
              tableId: 1,
              transactionId: 1,
              vout: model.vout
            })
            await trx('transactions')
              .where({ transactionId: 1 })
              .update({ txid: 'b'.repeat(64) })
            await trx('outputs')
              .where({ outputId: 1 })
              .update({ txid: 'c'.repeat(64) })
            await trx('commissions').where({ commissionId: 1 }).update({ keyOffset: 'changed-value' })
            const valuesChanged = await readSnapshotJournalSourceIdentities(trx, 1, high, refs)
            for (const tableId of [0, 1, 6])
              expect(valuesChanged.get(tableId + ':1')?.naturalIdentity).toBe(
                initial.get(tableId + ':1')?.naturalIdentity
              )
            await trx('snapshot_journal_physical')
              .where({ tableId: 0, id1: 1 })
              .update({ generation: model.generation + 1, revision: model.generation + 1 })
            const parentReplaced = await readSnapshotJournalSourceIdentities(trx, 1, high, refs)
            expect(parentReplaced.get('0:1')?.naturalIdentity).toBe(initial.get('0:1')?.naturalIdentity)
            expect(parentReplaced.get('0:1')?.generation).toBe(String(model.generation + 1))
            for (const tableId of [1, 6]) {
              expect(parentReplaced.get(tableId + ':1')?.naturalIdentity).not.toBe(
                initial.get(tableId + ':1')?.naturalIdentity
              )
            }
            throw new Error('generated natural identity rollback')
          })
        ).rejects.toThrow('generated natural identity rollback')
        expect(await db('snapshot_journal_physical').count({ count: '*' }).first()).toEqual({
          count: 0
        })
        expect(await db('transactions').select('transactionId')).toEqual([])
      }
    ),
    controls
  )
})
