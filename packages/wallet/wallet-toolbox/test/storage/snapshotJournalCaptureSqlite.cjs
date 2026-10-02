const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { mkdtemp, rm, readFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  knex,
  StorageKnex,
  StorageProvider,
  seedArchiveClosure,
  tables,
  exact
} = require('./snapshotJournalNativeFixture.cjs')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  installSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.js')
const {
  copySnapshotJournalBootstrapPage
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalBootstrap.js')
const { readSnapshotJournalReceipt } = require('../../out/src/storage/snapshot/journal/SnapshotJournalReceipt.js')
const { snapshotArchiveTables } = require('../../out/src/storage/snapshot/archive/KnexSnapshotArchiveStore.js')
const identity = '02' + '11'.repeat(32)
const request = { ceiling: '9223372036854775807', receiptPolicy: { receiptLimit: 128, receiptLifetimeMs: 600000 } }
const open = filename =>
  knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
async function child(filename, phase, marker) {
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: open(filename) })
  const injection = require('./snapshotJournalCaptureProcessLoss.cjs')(phase, marker)
  process.once('disconnect', () => process.exit(1))
  const deadline = setTimeout(() => process.exit(2), 20000)
  deadline.unref()
  try {
    const view = await storage.openSnapshotJournalSource(identity, request)
    if (phase === 'opened') injection.park()
    await view.close()
    throw Error('Did not reach capture boundary: ' + JSON.stringify({ phase, pools: injection.pools }))
  } finally {
    await storage.destroy()
  }
}
async function killAt(filename, phase, marker) {
  const killed = fork(__filename, ['child', filename, phase, marker], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  killed.stderr.on('data', data => {
    stderr += data
  })
  const timer = setTimeout(() => killed.kill('SIGKILL'), 20000)
  try {
    const result = await new Promise((resolve, reject) => {
      killed.once('error', reject)
      killed.once('exit', (code, signal) => resolve({ code, signal }))
    })
    assert.equal(result.signal, 'SIGKILL', stderr)
    assert.equal(await readFile(marker, 'utf8'), phase)
  } finally {
    clearTimeout(timer)
  }
}
async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-capture-sqlite-'))
  const filename = join(directory, 'wallet.sqlite'),
    k = open(filename),
    peer = open(filename)
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  const results = []
  let failure
  try {
    await k.raw('PRAGMA journal_mode=WAL')
    await storage.migrate('capture native WAL fixture', 'synthetic-capture-native')
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(identity),
      { user: other } = await storage.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(storage, user.userId, other.userId)
    await installSnapshotJournalSqliteGeneration(k, request.ceiling, request.receiptPolicy)
    let finished = false
    function* pages() {
      for (let n = 0; n < 100 && !finished; n++) yield n
    }
    await runInSeries(pages(), async () => {
      finished = (await copySnapshotJournalBootstrapPage(k, 1000000)).complete
    })
    assert(finished)
    await completeSnapshotJournalSqliteGeneration(k, request.receiptPolicy)
    await exact(k)
    const view = await storage.openSnapshotJournalSource(identity, request),
      pinned = []
    try {
      assert.deepEqual(
        await peer.transaction(t => readSnapshotJournalReceipt(t, view.receiptBinding, view.receipt)),
        view.receipt
      )
      await runInSeries(snapshotArchiveTables, async table => {
        const page = await view.readPage(table)
        assert(page.done)
        assert(page.rows.length > 0)
        pinned.push(page.rows)
      })
      const started = performance.now()
      await runInSeries(tables, async table => {
        await peer(table).update({ created_at: '2026-01-02T00:00:00.000Z' })
      })
      assert(performance.now() - started < 5000, 'WAL writer remained blocked by a retained reader')
      await runInSeries(snapshotArchiveTables.entries(), async ([index, table]) => {
        assert.deepEqual((await view.readPage(table)).rows, pinned[index])
      })
      assert.deepEqual(
        pinned[0].map(row => row.provenTxId),
        [1, 3]
      )
      assert.deepEqual(
        pinned[1].map(row => row.provenTxReqId),
        [1, 3]
      )
      assert.deepEqual(
        pinned[12].map(row => row.syncStateId),
        [1, 3]
      )
      results.push({ tables: 13, receiptCommitted: true, immutable: true, writerProgress: true })
    } finally {
      await view.close()
    }
    await runInSeries(['before-commit', 'after-commit', 'opened'], async phase => {
      const before = (await peer('snapshot_journal_receipts')).length
      await killAt(filename, phase, join(directory, phase))
      assert.equal((await peer('snapshot_journal_receipts')).length, before + Number(phase !== 'before-commit'))
      const next = await storage.openSnapshotJournalSource(identity, request)
      assert.deepEqual(
        await peer.transaction(t => readSnapshotJournalReceipt(t, next.receiptBinding, next.receipt)),
        next.receipt
      )
      await next.close()
      await peer('tx_labels')
        .where('txLabelId', 1)
        .update({ label: 'after process loss ' + phase })
      await exact(k)
      assert.deepEqual(await k.raw('PRAGMA foreign_key_check'), [])
      results.push({ processLoss: phase, receiptAtomic: true, newCapture: true, writerProgress: true })
    })
    console.log(JSON.stringify({ fixture: 'journal-capture-WAL', results }))
  } catch (error) {
    failure = { error }
  }
  const closed = await Promise.allSettled([storage.destroy(), k.destroy(), peer.destroy()])
  const errors = closed.filter(result => result.status === 'rejected').map(result => result.reason)
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length)
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure.error]), ...errors],
      'WAL capture fixture cleanup failed'
    )
  if (failure !== undefined) throw failure.error
}
module.exports = main
if (require.main === module) {
  const run = process.argv[2] === 'child' ? child(...process.argv.slice(3)) : main()
  run.catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
