const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { mkdtemp, rm, open: openFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  open,
  StorageKnex,
  StorageProvider,
  seedArchiveClosure,
  tables,
  exact
} = require('./snapshotJournalMysqlConnection.cjs')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  installSnapshotJournalMysqlGeneration,
  completeSnapshotJournalMysqlGeneration
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.js')
const {
  copySnapshotJournalBootstrapPage
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalBootstrap.js')
const { readSnapshotJournalReceipt } = require('../../out/src/storage/snapshot/journal/SnapshotJournalReceipt.js')
const { snapshotArchiveTables } = require('../../out/src/storage/snapshot/archive/KnexSnapshotArchiveStore.js')
const identity = '02' + '11'.repeat(32)
const request = { ceiling: '9223372036854775807', receiptPolicy: { receiptLimit: 128, receiptLifetimeMs: 600000 } }
async function killAt(phase, marker) {
  const output = await openFile(marker, 'wx+', 0o600)
  const child = fork(join(__dirname, 'snapshotJournalCaptureMysqlChild.cjs'), [phase], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc', output.fd],
    env: process.env
  })
  let stderr = ''
  child.stderr.on('data', data => {
    stderr += data
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    assert.equal(result.signal, 'SIGKILL', stderr)
    const bytes = Buffer.alloc(64)
    const { bytesRead } = await output.read(bytes, 0, bytes.length, 0)
    assert.equal(bytes.subarray(0, bytesRead).toString('utf8'), phase)
  } finally {
    clearTimeout(timer)
    await output.close()
  }
}
async function main() {
  const k = open(),
    peer = open(),
    storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k }),
    results = []
  let failure
  try {
    await storage.migrate('capture native fixture', 'synthetic-capture-native')
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(identity),
      { user: other } = await storage.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(storage, user.userId, other.userId)
    await installSnapshotJournalMysqlGeneration(k, request.ceiling, request.receiptPolicy)
    let finished = false
    function* pages() {
      for (let n = 0; n < 100 && !finished; n++) yield n
    }
    await runInSeries(pages(), async () => {
      finished = (await copySnapshotJournalBootstrapPage(k, 1000000)).complete
    })
    assert(finished)
    await completeSnapshotJournalMysqlGeneration(k, request.ceiling, request.receiptPolicy)
    await exact(k)
    await runInSeries(['READ COMMITTED', 'REPEATABLE READ'], async isolation => {
      const foreground = open(),
        provider = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: foreground })
      try {
        await provider.makeAvailable()
        await foreground.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
        await peer.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
        const started = performance.now(),
          view = await provider.openSnapshotJournalSource(identity, request),
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
          const writing = performance.now()
          await runInSeries(tables, async table => {
            await peer(table).update({
              created_at: new Date(isolation === 'READ COMMITTED' ? '2026-01-02T00:00:00Z' : '2026-01-03T00:00:00Z')
            })
          })
          assert(performance.now() - writing < 5000, 'Writer remained blocked by the retained view')
          await runInSeries(snapshotArchiveTables.entries(), async ([index, table]) => {
            const page = await view.readPage(table)
            assert.deepEqual(page.rows, pinned[index])
            for (const row of page.rows) if ('userId' in row) assert.equal(row.userId, user.userId)
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
          await assert.rejects(provider.openSnapshotArchiveSource(identity), /already has/)
          const rows = await peer('snapshot_journal_physical').select(peer.raw('CAST(revision AS CHAR) revision'))
          assert(
            rows.some(row => BigInt(row.revision) > BigInt(view.receipt.highWater)),
            JSON.stringify({
              isolation,
              highWater: view.receipt.highWater,
              maxRevision: rows.reduce((v, row) => (BigInt(row.revision) > BigInt(v) ? row.revision : v), '0')
            })
          )
        } finally {
          await view.close()
        }
        assert.equal(view.isOpen, false)
        const held = await peer.transaction()
        try {
          await held('snapshot_journal_clock').where('id', 1).forUpdate().first()
          const lockStart = performance.now()
          await assert.rejects(
            provider.openSnapshotJournalSource(identity, request),
            error => error.code === 'ER_LOCK_NOWAIT'
          )
          assert(performance.now() - lockStart < 2000)
        } finally {
          await held.rollback()
        }
        const next = await provider.openSnapshotJournalSource(identity, request)
        assert.notEqual(next.receipt.requestId, view.receipt.requestId)
        assert.equal(next.receiptBinding.backend, view.receiptBinding.backend)
        assert(BigInt(next.receipt.highWater) > BigInt(view.receipt.highWater))
        await next.close()
        const before = (await peer('information_schema.PROCESSLIST').where('DB', 'ts569_snapshot')).length
        const last = await provider.openSnapshotJournalSource(identity, request)
        const during = (await peer('information_schema.PROCESSLIST').where('DB', 'ts569_snapshot')).length
        assert.equal(during, before + 2)
        await provider.destroy()
        assert.equal(last.isOpen, false)
        await last.closed
        await assert.rejects(last.readPage('txLabels'))
        let after = (await peer('information_schema.PROCESSLIST').where('DB', 'ts569_snapshot')).length
        const closeDeadline = performance.now() + 5000
        function* closing() {
          while (after !== before - 1 && performance.now() < closeDeadline) yield undefined
        }
        await runInSeries(closing(), async () => {
          await new Promise(resolve => setTimeout(resolve, 20))
          after = (await peer('information_schema.PROCESSLIST').where('DB', 'ts569_snapshot')).length
        })
        assert.equal(after, before - 1, 'Server did not retire all provider-owned connections within five seconds')
        // A fresh provider is used for the next isolation cohort; foreground pool
        // ownership was deliberately drained by the preceding shutdown proof.
        results.push({
          isolation,
          tables: 13,
          receiptCommitted: true,
          immutable: true,
          writerProgress: true,
          lockRefusal: true,
          nativeShutdown: true,
          milliseconds: Math.round(performance.now() - started)
        })
      } finally {
        await provider.destroy()
      }
    })
    const directory = await mkdtemp(join(tmpdir(), 'ts569-capture-kill-'))
    try {
      await runInSeries(['before-commit', 'after-commit', 'opened'], async phase => {
        const before = (await peer('snapshot_journal_receipts')).length
        await killAt(phase, join(directory, phase))
        assert.equal((await peer('snapshot_journal_receipts')).length, before + Number(phase !== 'before-commit'))
        const view = await storage.openSnapshotJournalSource(identity, request)
        await assert.rejects(storage.openSnapshotJournalSource(identity, request), /already has/)
        assert.deepEqual(
          await peer.transaction(t => readSnapshotJournalReceipt(t, view.receiptBinding, view.receipt)),
          view.receipt
        )
        await view.close()
        await peer('tx_labels')
          .where('txLabelId', 1)
          .update({ label: 'after process loss ' + phase })
        await exact(k)
        results.push({ processLoss: phase, receiptAtomic: true, newCapture: true, writerProgress: true })
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    console.log(JSON.stringify({ fixture: 'journal-capture-provider', results }))
  } catch (error) {
    failure = { error }
  }
  const closed = await Promise.allSettled([storage.destroy(), k.destroy(), peer.destroy()])
  const errors = closed.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length)
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure.error]), ...errors],
      'MySQL capture fixture cleanup failed'
    )
  if (failure !== undefined) throw failure.error
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
