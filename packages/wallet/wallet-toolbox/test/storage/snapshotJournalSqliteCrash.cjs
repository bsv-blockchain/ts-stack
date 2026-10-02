const receiptPolicy = { receiptLimit: 128, receiptLifetimeMs: 2592000000 }
const assert = require('node:assert/strict'),
  { fork } = require('node:child_process'),
  { mkdtemp, rm } = require('node:fs/promises'),
  { readFileSync, writeFileSync } = require('node:fs'),
  { tmpdir } = require('node:os'),
  { join } = require('node:path')
const { knex, StorageKnex, StorageProvider, tables, exact } = require('./snapshotJournalNativeFixture.cjs'),
  { seedArchiveClosure } = require('./snapshotJournalNativeFixture.cjs')
const {
  installSnapshotJournalSqliteGeneration: install,
  readSnapshotJournalSqliteGeneration: read,
  completeSnapshotJournalSqliteGeneration: complete
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.js')
const {
  copySnapshotJournalBootstrapPage: copy
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalBootstrap.js')
const open = filename =>
  knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
const finish = async k => {
  for (let page = 0; page < 100; page++) if ((await copy(k, 1000000)).complete) return
  throw new Error('Bootstrap incomplete')
}
async function child() {
  process.once('disconnect', () => process.exit(1))
  const childDeadline = setTimeout(() => process.exit(1), 20000)
  childDeadline.unref()

  const filename = process.argv[3],
    boundary = process.argv[4],
    k = open(filename)
  const park = phase => {
    if (phase === boundary) {
      writeFileSync(filename + '.marker', phase)
      process.kill(process.pid, 'SIGKILL')
    }
  }
  k.on('query-response', (_value, q) => {
    const sql = q.sql.toLowerCase()
    if (sql.startsWith('create trigger snapshot_journal_physical_12_delete')) park('install-after-ddl')
    if (sql.startsWith('insert into `snapshot_journal_generation`')) park('install-after-generation')
    if (sql.startsWith('insert into `snapshot_journal_bootstrap`')) park('install-after-bootstrap')
    if (sql.startsWith('insert into `snapshot_journal_retention`')) park('install-after-retention')
    if (sql.startsWith('update `snapshot_journal_generation`')) park('complete-after-state')
    if (sql.startsWith('update `snapshot_journal_bootstrap` set `rowlimit`')) park('bootstrap-after-budget-bind')
    if (sql.startsWith('insert into `snapshot_journal_physical`')) park('bootstrap-after-metadata')
    if (sql.startsWith('update `snapshot_journal_bootstrap` set `cursor`')) park('bootstrap-after-progress')
  })
  k.on('query', q => {
    if (q.sql.toLowerCase().startsWith('update `snapshot_journal_generation`')) park('complete-before-state')
  })
  try {
    if (boundary.startsWith('install-')) {
      await install(k, '1000000', receiptPolicy)
      park('install-after-commit')
    } else if (boundary.startsWith('bootstrap-')) {
      await copy(k, 1000000)
      park('bootstrap-after-commit')
    } else {
      await complete(k, receiptPolicy)
      park('complete-after-commit')
    }
    throw new Error('Boundary not reached')
  } finally {
    await k.destroy()
  }
}
async function killAt(filename, boundary) {
  const processChild = fork(__filename, ['child', filename, boundary], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  let stderr = ''
  processChild.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-6000)
  })
  const timeout = setTimeout(() => processChild.kill('SIGKILL'), 15000)
  const result = await new Promise((resolve, reject) => {
    processChild.once('error', reject)
    processChild.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timeout)
  assert.equal(result.signal, 'SIGKILL', stderr)
  assert.equal(readFileSync(filename + '.marker', 'utf8'), boundary)
  return result
}
async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-journal-generation-kill-')),
    results = []
  try {
    for (const boundary of [
      'install-after-ddl',
      'install-after-generation',
      'install-after-bootstrap',
      'install-after-retention',
      'install-after-commit',
      'bootstrap-after-budget-bind',
      'bootstrap-after-metadata',
      'bootstrap-after-progress',
      'bootstrap-after-commit',
      'complete-before-state',
      'complete-after-state',
      'complete-after-commit'
    ]) {
      const filename = join(directory, boundary + '.sqlite'),
        k = open(filename),
        source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
      try {
        await k.raw('PRAGMA journal_mode=WAL')
        await source.migrate('journal generation process-loss fixture', 'synthetic-source')
        await source.makeAvailable()
        const { user } = await source.findOrInsertUser('02' + '11'.repeat(32)),
          { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
        await seedArchiveClosure(source, user.userId, other.userId)
        const original = {}
        for (const table of tables) original[table] = await k(table)
        if (boundary.startsWith('bootstrap-')) await install(k, '1000000', receiptPolicy)
        if (boundary.startsWith('complete-')) {
          await install(k, '1000000', receiptPolicy)
          await finish(k)
        }
        const killed = await killAt(filename, boundary)
        await k.transaction(async t => {
          await t('snapshot_index_generation_v2')
            .where('id', 0)
            .update({ complete: t.ref('complete') })
        })
        const objects = await k('sqlite_master').whereRaw('lower(substr(name,1,17))=?', ['snapshot_journal_'])
        const committed = boundary.endsWith('after-commit')
        if (boundary.startsWith('install-')) assert.equal(objects.length, committed ? 61 : 0)
        else if (boundary.startsWith('bootstrap-')) {
          assert.equal((await read(k, receiptPolicy)).complete, false)
          const progress = await k('snapshot_journal_bootstrap').first()
          assert.equal(progress.rowsUsed, committed ? original.transactions.length : 0)
          assert.equal(progress.rowLimit, committed ? 1000000 : null)
          assert.equal(
            progress.cursor,
            committed ? JSON.stringify([Math.max(...original.transactions.map(row => row.transactionId))]) : null
          )
        } else assert.equal((await read(k, receiptPolicy)).complete, committed)
        await install(k, '1000000', receiptPolicy)
        await finish(k)
        await complete(k, receiptPolicy)
        assert.equal((await read(k, receiptPolicy)).complete, true)
        await exact(k)
        let charged = 0
        for (const table of [
          ...tables,
          'snapshot_profile_keys_v2',
          'snapshot_relation_keys_v2',
          'snapshot_certificate_field_keys_v2',
          'snapshot_global_keys_v2'
        ])
          charged += Number((await k(table).count('* AS n').first()).n)
        assert.equal((await k('snapshot_journal_bootstrap').first()).rowsUsed, charged)
        for (const table of tables) assert.deepEqual(await k(table), original[table])
        assert.deepEqual(await k.raw('PRAGMA foreign_key_check'), [])
        results.push({
          boundary,
          signal: killed.signal,
          atomicity: committed ? 'committed' : 'rolled back',
          writerLockReleased: true,
          sourcePreserved: true,
          resumedComplete: true
        })
      } finally {
        await source.destroy()
      }
    }
    console.log(
      JSON.stringify({
        status: 'SQLite journal generation native WAL process-loss checks',
        results,
        readerAdvertised: false,
        limitations: [
          'not yet a registered forward migration',
          'no MySQL implicit-DDL lifecycle qualification',
          'no receipt/quota/receiver or platform-scale acceptance'
        ]
      })
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
if (process.argv[2] === 'child')
  child().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
else
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
