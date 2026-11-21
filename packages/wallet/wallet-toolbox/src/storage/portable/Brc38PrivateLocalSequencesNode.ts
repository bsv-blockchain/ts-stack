import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { readBrc38PrivateLocalCandidateJournal } from './Brc38PrivateLocalCandidateJournalNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { brc38NativeLocalBaselineTableCount } from './Brc38NativeLocalBaselineTables'
import type { SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'

const table = 'brc38_private_local_sequences',
  definitions = Object.freeze([
    `CREATE TABLE ${table}(slot INTEGER PRIMARY KEY CHECK(slot=1),bindingSha256 TEXT NOT NULL CHECK(length(bindingSha256)=64),sourceSha256 TEXT NOT NULL CHECK(length(sourceSha256)=64),epoch TEXT NOT NULL CHECK(length(epoch)=36),revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),digest TEXT NOT NULL CHECK(length(digest)=64),tables INTEGER NOT NULL CHECK(tables BETWEEN 0 AND ${brc38NativeLocalBaselineTableCount}))`,
    `CREATE TRIGGER ${table}_update BEFORE UPDATE ON ${table} WHEN NEW.slot IS NOT OLD.slot OR NEW.bindingSha256 IS NOT OLD.bindingSha256 OR NEW.sourceSha256 IS NOT OLD.sourceSha256 OR NEW.epoch IS NOT OLD.epoch OR NEW.revision<OLD.revision BEGIN SELECT RAISE(ABORT,'Local sequence original binding or progress differs'); END`,
    `CREATE TRIGGER ${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Local sequence receipt remains owned'); END`
  ])
function invalid(): never {
  throw new Error(
    'Private local allocation history differs from the original source, actual candidate or complete copy'
  )
}
async function exact(k: Knex.Transaction): Promise<void> {
  const count = (await k('sqlite_schema')
    .whereRaw('substr(name,1,?)=?', [table.length, table])
    .count({ count: '*' })
    .first()) as { count: unknown } | undefined
  if (count?.count !== definitions.length) invalid()
  for (const sql of definitions) {
    const name = /^CREATE (TABLE|TRIGGER) ([A-Za-z0-9_]+)/.exec(sql)!,
      row = (await k('sqlite_schema')
        .where({ type: name[1].toLowerCase(), name: name[2] })
        .whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [sql])
        .count({ count: '*' })
        .first()) as { count: unknown } | undefined
    if (row?.count !== 1) invalid()
  }
}
/** Low-level allocation copy only. The complete candidate's issuer first
 * proves its ORIGINAL source identity/policy; this primitive never grants
 * current-source/primary/semantic admission from epoch or receipt DATA. Source
 * rows and these counters come from one genuine retained source snapshot. */
export async function copyBrc38PrivateLocalSequences(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  selected: Readonly<{ expiresAt: number; workingAllocation: Brc38WorkingAllocation; signal?: AbortSignal }>
): Promise<Readonly<{ revision: SnapshotJournalRevision; digest: string; tables: number }>> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    expiresAt = selected.expiresAt,
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    expiresAt !== store.limits.expiresAt ||
    working.maximum > store.limits.maximumRowAllocationBytes
  )
    invalid()
  const check = (): void => {
    signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() >= deadline) invalid()
    store.assertPrivateNativeDestination(store.knex)
    Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
  }
  check()
  const facts = await Brc38NativeLocalBaselineSource.facts(source),
    charge = working.claim(1048576)
  try {
    return await Brc38NativeLocalBaselineSource.withOwnedSequences(source, async sequences => {
      check()
      // Packed/default entity coordinates remain signed safe integers. Refuse
      // a counter that would enter an unsupported allocation space, preserving
      // the original history for explicit recovery rather than truncating it.
      if (sequences.some(row => row.sequence !== null && BigInt(row.sequence) > 9007199254740991n)) invalid()
      const hash = createHash('sha256').update(JSON.stringify(sequences)).digest('hex')
      return await store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async k => {
            store.assertPrivateNativeWriteTransaction(k)
            check()
            await verifyBrc38AuthenticatedSourceSeal(k)
            const journal = await readBrc38PrivateLocalCandidateJournal(k)
            if (
              journal.phase !== 'RECOVERY' ||
              journal.bindingSha256 !== store.binding?.digest ||
              journal.epoch !== facts.generation.epoch ||
              journal.caughtUpRevision !== facts.generation.revision
            )
              invalid()
            const savepoint = '__brc38_local_sequence_' + randomUUID().replaceAll('-', '')
            await k.raw('SAVEPOINT ' + savepoint)
            try {
              if (!(await k.schema.hasTable(table))) for (const sql of definitions) await k.raw(sql)
              await exact(k)
              for (const row of sequences) {
                check()
                store.assertPrivateNativeWriteTransaction(k)
                const actual = (await k(row.table)
                    .where('rowid', '>', 0)
                    .select(k.raw('CAST(rowid AS TEXT) AS high'))
                    .orderBy('rowid', 'desc')
                    .limit(1)) as Array<{ high: string }>,
                  prior = (await k('sqlite_sequence')
                    .where({ name: row.table })
                    .select(k.raw("CASE WHEN typeof(seq)='integer' AND seq>=0 THEN CAST(seq AS TEXT) END AS high"))
                    .limit(2)) as Array<{ high: string | null }>
                if (
                  actual.length > 1 ||
                  prior.length > 1 ||
                  prior.some(value => value.high === null || !/^(?:0|[1-9]\d{0,18})$/.test(value.high)) ||
                  (row.sequence === null && (actual.length !== 0 || prior.length !== 0)) ||
                  (row.sequence !== null &&
                    (actual.some(value => BigInt(value.high) > BigInt(row.sequence!)) ||
                      prior.some(value => BigInt(value.high!) > BigInt(row.sequence!))))
                )
                  invalid()
                if (row.sequence !== null) {
                  if (prior.length === 0)
                    await k('sqlite_sequence').insert({
                      name: row.table,
                      seq: k.raw('CAST(? AS INTEGER)', [row.sequence])
                    })
                  else if (
                    (await k('sqlite_sequence')
                      .where({ name: row.table })
                      .update({ seq: k.raw('CAST(? AS INTEGER)', [row.sequence]) })) !== 1
                  )
                    invalid()
                  const post = (await k('sqlite_sequence')
                    .where({ name: row.table })
                    .select(k.raw('CAST(seq AS TEXT) AS high'))
                    .limit(2)) as Array<{ high: string }>
                  if (post.length !== 1 || post[0].high !== row.sequence) invalid()
                }
              }
              const receipt = {
                slot: 1,
                bindingSha256: journal.bindingSha256,
                sourceSha256: journal.sourceSha256,
                epoch: journal.epoch,
                revision: journal.caughtUpRevision,
                digest: hash,
                tables: sequences.length
              }
              await k(table).insert(receipt).onConflict('slot').merge(receipt)
              const post = (await k(table)
                .where({ slot: 1 })
                .select(
                  'bindingSha256',
                  'sourceSha256',
                  'epoch',
                  'digest',
                  'tables',
                  k.raw('CAST(revision AS TEXT) AS revision')
                )
                .limit(2)) as Array<Record<string, unknown>>
              if (
                post.length !== 1 ||
                Object.entries(receipt).some(([key, value]) => key !== 'slot' && !Object.is(post[0][key], value))
              )
                invalid()
              check()
              store.assertPrivateNativeWriteTransaction(k)
              await k.raw('RELEASE ' + savepoint)
              return Object.freeze({ revision: journal.caughtUpRevision, digest: hash, tables: sequences.length })
            } catch (cause) {
              try {
                await k.raw('ROLLBACK TO ' + savepoint)
                await k.raw('RELEASE ' + savepoint)
              } catch (error_) {
                throw new AggregateError([cause, error_], 'Private sequence copy retains actual savepoint failure', {
                  cause
                })
              }
              throw cause
            }
          })
      )
    })
  } finally {
    charge.close()
  }
}
