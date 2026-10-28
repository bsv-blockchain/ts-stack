import fc from 'fast-check'
import { knex, type Knex } from 'knex'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import {
  readSnapshotJournalSourceGenerations,
  type SnapshotJournalSourceReference
} from './SnapshotJournalSourceGenerations'

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
const definitions = [
  [0, 'transactions', 'transactionId'],
  [1, 'outputs', 'outputId'],
  [2, 'certificates', 'certificateId'],
  [3, 'tx_labels', 'txLabelId'],
  [4, 'output_baskets', 'basketId'],
  [5, 'output_tags', 'outputTagId'],
  [6, 'commissions', 'commissionId'],
  [8, 'proven_txs', 'provenTxId'],
  [9, 'proven_tx_reqs', 'provenTxReqId']
] as const
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'journal-source-generations-'))
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'source.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  await db.raw('PRAGMA journal_mode = WAL')
  await db.raw(
    'CREATE TABLE snapshot_journal_physical(tableId INTEGER NOT NULL,id1 INTEGER NOT NULL,id2 INTEGER NOT NULL,exactText TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(tableId,id1,id2,exactText))'
  )
  await db.raw(
    'CREATE TABLE snapshot_profile_keys_v2(snapshotTableId INTEGER NOT NULL,snapshotUserId INTEGER NOT NULL,snapshotRowId INTEGER NOT NULL,PRIMARY KEY(snapshotTableId,snapshotUserId,snapshotRowId))'
  )
  await db.raw(
    'CREATE TABLE snapshot_global_keys_v2(tableId INTEGER NOT NULL,userId INTEGER NOT NULL,rowId INTEGER NOT NULL,refs INTEGER NOT NULL,present INTEGER NOT NULL,PRIMARY KEY(tableId,userId,rowId))'
  )
  for (const [, name, key] of definitions)
    await db.raw('CREATE TABLE ??(?? INTEGER PRIMARY KEY,userId INTEGER NOT NULL)', [name, key])
})
afterEach(async () => {
  await db.destroy()
  rmSync(directory, { recursive: true, force: true })
})
async function live(
  k: Knex,
  tableId: SnapshotJournalSourceReference['tableId'],
  incomingId: number,
  generation = '2',
  revision = '9',
  userId = 1
): Promise<void> {
  const [, name, key] = definitions.find(row => row[0] === tableId)!
  await k(name).insert({ [key]: incomingId, userId })
  await k('snapshot_journal_physical').insert({
    tableId,
    id1: incomingId,
    id2: 0,
    exactText: '',
    generation,
    revision,
    present: 1
  })
  if (tableId < 7)
    await k('snapshot_profile_keys_v2').insert({
      snapshotTableId: tableId,
      snapshotUserId: userId,
      snapshotRowId: incomingId
    })
  else
    await k('snapshot_global_keys_v2').insert({
      tableId: tableId === 8 ? 1 : 0,
      userId,
      rowId: incomingId,
      refs: 1,
      present: 1
    })
}

test('generated source membership and identity independently predict bounded live resolution and rollback', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          tableId: fc.constantFrom(
            0 as const,
            1 as const,
            2 as const,
            3 as const,
            4 as const,
            5 as const,
            6 as const,
            8 as const,
            9 as const
          ),
          generation: fc.integer({ min: 1, max: 20 }),
          later: fc.integer({ min: 0, max: 5 }),
          member: fc.boolean(),
          physicallyPresent: fc.boolean()
        }),
        { minLength: 1, maxLength: 6 }
      ),
      async examples => {
        const model = examples.map((event, index) => ({
          ...event,
          incomingId: index + 1,
          revision: event.generation + event.later,
          visible: event.member && event.physicallyPresent
        }))
        await expect(
          db.transaction(async trx => {
            for (const entry of model) {
              await live(
                trx,
                entry.tableId,
                entry.incomingId,
                String(entry.generation),
                String(entry.revision),
                entry.member ? 1 : 2
              )
              if (!entry.physicallyPresent)
                await trx('snapshot_journal_physical')
                  .where({ tableId: entry.tableId, id1: entry.incomingId })
                  .update({ present: 0 })
              const readOne = readSnapshotJournalSourceGenerations(trx, 1, high, [
                { tableId: entry.tableId, incomingId: entry.incomingId }
              ])
              if (entry.visible)
                expect([...(await readOne)]).toEqual([
                  [
                    entry.tableId + ':' + entry.incomingId,
                    { generation: String(entry.generation), revision: String(entry.revision) }
                  ]
                ])
              else await expect(readOne).rejects.toThrow('Missing or inconsistent')
            }
            const visible = model.filter(entry => entry.visible)
            expect([...(await readSnapshotJournalSourceGenerations(trx, 1, high, visible))]).toEqual(
              visible.map(entry => [
                entry.tableId + ':' + entry.incomingId,
                { generation: String(entry.generation), revision: String(entry.revision) }
              ])
            )
            throw new Error('generated source rollback')
          })
        ).rejects.toThrow('generated source rollback')
        expect(await db('snapshot_journal_physical').select('id1')).toEqual([])
        expect(await db('snapshot_profile_keys_v2').select('snapshotRowId')).toEqual([])
        expect(await db('snapshot_global_keys_v2').select('rowId')).toEqual([])
      }
    ),
    controls
  )
})
