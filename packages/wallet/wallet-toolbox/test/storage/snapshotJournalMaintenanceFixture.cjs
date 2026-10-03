const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  maintainSnapshotJournal: maintain
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalMaintenance.js')
const native = require('./snapshotJournalNativeFixture.cjs')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  copySnapshotJournalBootstrapPage
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalBootstrap.js')
const sqliteGeneration = require('../../out/src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.js')
const mysqlGeneration = require('../../out/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.js')
const backend = require('../../out/src/storage/snapshot/journal/SnapshotJournalCaptureBackend.js')
const identity = '02' + '11'.repeat(32)
const policy = { receiptLimit: 128, receiptLifetimeMs: 600000 },
  ceiling = '9223372036854775807'
function gate() {
  let resolve
  const promise = new Promise(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
module.exports = async function proof(isolation) {
  const local = isolation === 'WAL',
    directory = await mkdtemp(join(tmpdir(), 'ts569-maintenance-controller-'))
  const mysql = local ? undefined : require('./snapshotJournalMysqlConnection.cjs')
  const config = {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'wallet.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  }
  const k = local ? native.knex(config) : mysql.open(true)
  const peer = local ? native.knex(config) : mysql.open(true)
  const { StorageKnex: Provider } = require('../../out/src/storage/StorageKnex.js')
  const storage = new Provider({ ...native.StorageProvider.createStorageBaseOptions('test'), knex: k })
  const results = [],
    pools = [],
    originalClose = backend.closeSnapshotJournalCapturePool,
    originalBind = backend.bindSnapshotJournalCaptureBackend
  backend.closeSnapshotJournalCapturePool = async (...args) => {
    await originalClose(...args)
    pools.push(args[1])
  }
  const request = (epoch, operation) => ({ epoch, ceiling, receiptPolicy: policy, operation })
  const run = async input => {
    const value = await storage.maintainSnapshotJournal(input)
    await storage.awaitSnapshotJournalMaintenanceCleanup()
    return value
  }
  try {
    if (local) {
      await k.raw('PRAGMA journal_mode=WAL')
      await k.raw('PRAGMA busy_timeout=0')
      await peer.raw('PRAGMA busy_timeout=0')
    } else {
      await k.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
      await peer.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
      k.client.config.pool = {
        ...k.client.config.pool,
        afterCreate(connection, done) {
          connection.query('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation, error => done(error, connection))
        }
      }
      backend.bindSnapshotJournalCaptureBackend = async (...args) => {
        const value = await originalBind(...args)
        const [[write]] = await args[0].raw('SELECT @@transaction_isolation isolationLevel').connection(args[1])
        const [[read]] = await args[2].raw('SELECT @@transaction_isolation isolationLevel').connection(args[3])
        assert.equal(write.isolationLevel, isolation.replaceAll(' ', '-'))
        assert.equal(read.isolationLevel, isolation.replaceAll(' ', '-'))
        return value
      }
    }
    await storage.migrate('owned bounded journal maintenance', 'synthetic-maintenance-controller')
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(identity),
      { user: other } = await storage.findOrInsertUser('03' + '22'.repeat(32))
    await native.seedArchiveClosure(storage, user.userId, other.userId)
    if (local) await sqliteGeneration.installSnapshotJournalSqliteGeneration(k, ceiling, policy)
    else await mysqlGeneration.installSnapshotJournalMysqlGeneration(k, ceiling, policy)
    let done = false
    function* pages() {
      for (let n = 0; n < 100 && !done; n++) yield n
    }
    await runInSeries(pages(), async () => {
      done = (await copySnapshotJournalBootstrapPage(k, 1000000)).complete
    })
    assert(done)
    const generation = local
      ? await sqliteGeneration.completeSnapshotJournalSqliteGeneration(k, policy)
      : await mysqlGeneration.completeSnapshotJournalMysqlGeneration(k, ceiling, policy)
    const epoch = generation.epoch
    const date = local ? '2026-01-01T00:00:00.000Z' : new Date('2026-01-01T00:00:00.000Z')
    await k('tx_labels').insert({
      txLabelId: 999,
      userId: user.userId,
      label: 'collectible',
      isDeleted: false,
      created_at: date,
      updated_at: date
    })
    await k('tx_labels').where('txLabelId', 999).delete()
    const revisionSql =
      'SELECT CAST(MAX(revision) AS ' +
      (local ? 'TEXT' : 'CHAR') +
      ') revision FROM (SELECT revision FROM snapshot_journal_scope UNION ALL SELECT revision FROM snapshot_journal_physical) AS revisions'
    const [[row]] = local ? [await k.raw(revisionSql)] : await k.raw(revisionSql)
    await native.exact(k)
    const arrays = async () => {
      const rows = []
      await runInSeries(native.tables, async table => {
        rows.push((await k(table)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      })
      return rows
    }
    const before = await arrays()
    const floor = await run(request(epoch, { kind: 'floor', floor: row.revision }))
    assert.equal(floor.kind, 'floor')
    assert.equal(floor.value.floor, row.revision)
    results.push('owned complete generation advances floor and physically closes both pools')
    await runInSeries(['scope', 'physical'], async stream => {
      let after,
        finished = false,
        examined = 0,
        removed = 0
      function* pages() {
        for (let n = 0; n < 100 && !finished; n++) yield n
      }
      await runInSeries(pages(), async () => {
        const answer = await run(
          request(epoch, { kind: 'collect', page: { epoch, floor: row.revision, stream, limit: 4, after } })
        )
        assert.equal(answer.kind, 'collect')
        assert(answer.value.examined <= 4)
        examined += answer.value.examined
        removed += answer.value.removed
        after = answer.value.after
        finished = answer.value.complete
      })
      assert(finished)
      assert(examined > 4)
      assert.equal(removed, 1)
    })
    await native.exact(k)
    assert.deepEqual(await arrays(), before)
    results.push('bounded multi-page collection preserves all thirteen source arrays')
    const stale = request('00000000-0000-4000-8000-000000000000', { kind: 'floor', floor: row.revision })
    const rejected = maintain(async () => k.client.config, stale)
    await assert.rejects(rejected.result, /generation/)
    await assert.rejects(rejected.closed, /generation/)
    assert.deepEqual(await arrays(), before)
    results.push('changed generation refuses without source mutation')
    const lock = await peer.transaction()
    try {
      await lock('knex_migrations_lock').where('index', 1).update({ is_locked: 1 })
      const rejected = maintain(async () => k.client.config, request(epoch, { kind: 'floor', floor: row.revision }))
      const start = performance.now()
      await assert.rejects(rejected.result)
      await assert.rejects(rejected.closed)
      assert(performance.now() - start < 2000)
    } finally {
      await lock.rollback()
    }
    results.push('actual held migration owner refuses boundedly')
    if (!local) {
      const entered = gate(),
        release = gate(),
        read = mysqlGeneration.readSnapshotJournalMysqlGeneration
      mysqlGeneration.readSnapshotJournalMysqlGeneration = async (...args) => {
        entered.resolve()
        await release.promise
        return await read(...args)
      }
      const task = maintain(async () => k.client.config, request(epoch, { kind: 'floor', floor: row.revision }))
      try {
        await entered.promise
        const start = performance.now()
        await peer('tx_labels').where('txLabelId', 1).update({ label: 'foreground during generation verification' })
        assert(performance.now() - start < 2000)
        release.resolve()
        await task.result
        await task.closed
        results.push('foreground wallet write proceeds during actual controller generation validation')
      } finally {
        release.resolve()
        mysqlGeneration.readSnapshotJournalMysqlGeneration = read
        await task.closed.catch(() => {})
      }
    }
    assert(pools.length >= 6)
    assert(pools.every(connection => (local ? connection.open === false : connection.stream.closed)))
    const cuts = await require('./snapshotJournalMaintenanceCuts.cjs')(k, {
      backend: local ? 'sqlite' : 'mysql',
      filename: config.connection.filename,
      isolation,
      directory,
      userId: user.userId,
      epoch,
      ceiling,
      receiptPolicy: policy
    })
    assert.equal(cuts.length, 8)
    results.push({ processLoss: cuts })
    row.revision = String((await k('snapshot_journal_retention').first()).floor)
    const entered = gate(),
      release = gate(),
      controller = new AbortController()
    const receipts = require('../../out/src/storage/snapshot/journal/SnapshotJournalReceipt.js'),
      advance = receipts.advanceSnapshotJournalFloor
    const prior = await k('snapshot_journal_retention').first()
    receipts.advanceSnapshotJournalFloor = async (...args) => {
      const value = await advance(...args)
      entered.resolve()
      await release.promise
      return value
    }
    try {
      const pending = storage.maintainSnapshotJournal(request(epoch, { kind: 'floor', floor: row.revision }), {
        signal: controller.signal
      })
      const rejection = assert.rejects(pending, /cancelled/)
      await entered.promise
      controller.abort()
      await rejection
      await assert.rejects(
        storage.maintainSnapshotJournal(request(epoch, { kind: 'floor', floor: row.revision })),
        /already/
      )
      await assert.rejects(storage.openSnapshotJournalSource(identity, { ceiling, receiptPolicy: policy }), /already/)
      let closed = false
      const cleanup = storage.awaitSnapshotJournalMaintenanceCleanup().then(() => {
        closed = true
      })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(closed, false)
      release.resolve()
      await cleanup
      assert.equal((await k('snapshot_journal_retention').first()).floor, prior.floor)
      results.push('provider cancellation retains shared source admission until rollback and physical cleanup')
    } finally {
      release.resolve()
      receipts.advanceSnapshotJournalFloor = advance
    }
    await run(request(epoch, { kind: 'floor', floor: row.revision }))
    const resolve = storage.concurrentSnapshotReaderConfig.bind(storage),
      enteredConfig = gate(),
      releaseConfig = gate(),
      controller2 = new AbortController()
    storage.concurrentSnapshotReaderConfig = async () => {
      enteredConfig.resolve()
      await releaseConfig.promise
      return await resolve()
    }
    const pending = storage.maintainSnapshotJournal(request(epoch, { kind: 'floor', floor: row.revision }), {
      signal: controller2.signal
    })
    const rejection = assert.rejects(pending)
    await enteredConfig.promise
    let destroyed = false
    const destroying = storage.destroy().then(() => {
      destroyed = true
    })
    await rejection
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(destroyed, false)
    await assert.rejects(
      storage.maintainSnapshotJournal(request(epoch, { kind: 'floor', floor: row.revision })),
      /destruction/
    )
    releaseConfig.resolve()
    await destroying
    results.push(
      'provider destruction fences admission synchronously and drains pending configuration without allocating'
    )
    console.log(
      JSON.stringify({
        fixture: 'owned bounded journal maintenance',
        isolation,
        results,
        nativePoolsClosed: pools.length,
        limitations: [
          'no runtime quotas or registered generation lifecycle qualification',
          'component qualification does not establish full program or production readiness'
        ]
      })
    )
  } finally {
    backend.closeSnapshotJournalCapturePool = originalClose
    backend.bindSnapshotJournalCaptureBackend = originalBind
    await Promise.allSettled([storage.destroy(), peer.destroy()])
    await rm(directory, { recursive: true, force: true })
  }
}
if (require.main?.filename === __filename)
  module.exports('WAL').catch(error => {
    console.error(error)
    process.exitCode = 1
  })
