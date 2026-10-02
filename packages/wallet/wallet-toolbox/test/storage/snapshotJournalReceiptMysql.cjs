const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const assert = require('node:assert/strict')
const { open } = require('./snapshotJournalMysqlConnection.cjs')
const {
  snapshotJournalReceiptDdl,
  snapshotJournalReceiptBinding,
  recordSnapshotJournalReceipt,
  readSnapshotJournalReceipt,
  collectSnapshotJournalReceipts
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalReceipt.js')
const binding = {
  backend: '11'.repeat(32),
  epoch: '12345678-1234-4234-9234-123456789012',
  source: '22'.repeat(32),
  schema: '33'.repeat(32),
  storageIdentity: 'synthetic-storage',
  identityKey: '02' + '44'.repeat(32),
  userId: 1,
  chain: 'test'
}
async function qualify(isolation, bigNumberStrings) {
  const k = open(bigNumberStrings),
    peer = open(bigNumberStrings)
  try {
    await runInSeries([k, peer], async db => {
      await db.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
    })
    await runInSeries(
      ['snapshot_journal_receipts', 'snapshot_journal_retention', 'receipt_fixture_source'],
      async table => {
        await k.schema.dropTableIfExists(table)
      }
    )
    await runInSeries(snapshotJournalReceiptDdl(k), async sql => {
      await k.raw(sql)
    })
    await k('snapshot_journal_retention').insert({ id: 1, floor: '0', receiptLimit: 2, receiptLifetimeMs: 2592000000 })
    await k.raw('CREATE TABLE receipt_fixture_source(id INTEGER PRIMARY KEY,value INTEGER NOT NULL) ENGINE=InnoDB')
    await k('receipt_fixture_source').insert({ id: 1, value: 0 })
    const input = n => ({
      requestId: n.toString(16).padStart(64, '0'),
      highWater: '9007199254740993',
      expiresAt: Date.now() + 60000
    })
    const a = input(1),
      b = input(2),
      c = input(3)
    const stored = await k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))
    assert.deepEqual(stored, { ...a, binding: snapshotJournalReceiptBinding(binding), floor: '0' })
    assert.deepEqual(await peer.transaction(t => readSnapshotJournalReceipt(t, binding, a)), stored)
    assert.deepEqual(await k.transaction(t => recordSnapshotJournalReceipt(t, binding, a)), stored)
    await assert.rejects(k.transaction(t => readSnapshotJournalReceipt(t, { ...binding, userId: 2 }, a)))
    await assert.rejects(
      k.transaction(async t => {
        await recordSnapshotJournalReceipt(t, binding, b)
        throw new Error('before-commit')
      }),
      /before-commit/
    )
    assert.equal((await k('snapshot_journal_receipts')).length, 1)
    await assert.rejects(
      (async () => {
        await k.transaction(t => recordSnapshotJournalReceipt(t, binding, b))
        throw new Error('lost-ack')
      })(),
      /lost-ack/
    )
    assert.equal((await peer.transaction(t => readSnapshotJournalReceipt(t, binding, b))).requestId, b.requestId)
    await assert.rejects(k.transaction(t => recordSnapshotJournalReceipt(t, binding, c)))
    const stale = await peer.transaction()
    try {
      await stale('snapshot_journal_receipts').select('requestId')
      await k('snapshot_journal_receipts').where('requestId', a.requestId).delete()
      await k.transaction(t => recordSnapshotJournalReceipt(t, binding, c))
      await assert.rejects(recordSnapshotJournalReceipt(stale, binding, a))
    } finally {
      await stale.rollback()
    }
    await k('snapshot_journal_receipts').where('requestId', c.requestId).delete()
    await k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))
    await k('snapshot_journal_receipts').where('requestId', a.requestId).update({ expiresAt: 1 })
    await assert.rejects(k.transaction(t => recordSnapshotJournalReceipt(t, binding, c)))
    assert.equal(await k.transaction(t => collectSnapshotJournalReceipts(t)), 1)
    await k.transaction(t => recordSnapshotJournalReceipt(t, binding, c))
    const held = await peer.transaction()
    try {
      await held('snapshot_journal_retention').where('id', 1).forUpdate().first()
      const start = performance.now()
      await assert.rejects(
        k.transaction(t => recordSnapshotJournalReceipt(t, binding, b)),
        e => e.code === 'ER_LOCK_NOWAIT'
      )
      await assert.rejects(
        k.transaction(t => readSnapshotJournalReceipt(t, binding, b)),
        e => e.code === 'ER_LOCK_NOWAIT'
      )
      assert(performance.now() - start < 1000)
      await k('receipt_fixture_source').where('id', 1).update({ value: 1 })
    } finally {
      await held.rollback()
    }
    await k('snapshot_journal_retention').update({ floor: '9007199254740994' })
    await assert.rejects(peer.transaction(t => readSnapshotJournalReceipt(t, binding, b)))
    await k('snapshot_journal_retention').update({ floor: '0' })
    await k('snapshot_journal_receipts').delete()
    await assert.rejects(peer.transaction(t => readSnapshotJournalReceipt(t, binding, b)))
    const rows = Array.from({ length: 128 }, (_, n) => ({
      requestId: n.toString(16).padStart(64, '0'),
      binding: snapshotJournalReceiptBinding(binding),
      highWater: '9',
      floor: '0',
      expiresAt: 1
    }))
    await k('snapshot_journal_retention').update({ receiptLimit: 128 })
    await k('snapshot_journal_receipts').insert(rows)
    assert.equal(await k.transaction(t => collectSnapshotJournalReceipts(t)), 64)
    assert.equal(await k.transaction(t => collectSnapshotJournalReceipts(t)), 64)
    assert.equal(await k.transaction(t => collectSnapshotJournalReceipts(t)), 0)
    return {
      isolation,
      bigNumberStrings,
      exactSigned63: true,
      independentRead: true,
      immutableRetry: true,
      rollbackAndLostAck: true,
      boundedCapacityAndCollector: true,
      nonwaitingRetentionLock: true,
      currentReadAfterOlderSnapshot: true,
      independentSourceWrite: true,
      collectedOrMissingPrefixRefused: true
    }
  } finally {
    await Promise.all([k.destroy(), peer.destroy()])
  }
}
const { fork } = require('node:child_process'),
  { mkdtemp, rm } = require('node:fs/promises'),
  { writeFileSync, readFileSync } = require('node:fs'),
  { tmpdir } = require('node:os'),
  { join } = require('node:path')
const processRequest = { requestId: 'ee'.repeat(32), highWater: '9007199254740993', expiresAt: 0 }
async function crashChild() {
  process.once('disconnect', () => process.exit(1))
  const deadline = setTimeout(() => process.exit(1), 15000)
  deadline.unref()
  const [phase, marker, isolation, expiresAt] = process.argv.slice(3),
    k = open()
  const die = () => {
    writeFileSync(marker, phase)
    process.kill(process.pid, 'SIGKILL')
  }
  try {
    assert(['READ COMMITTED', 'REPEATABLE READ'].includes(isolation))
    await k.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
    await k.transaction(async t => {
      if (phase.startsWith('record'))
        await recordSnapshotJournalReceipt(t, binding, { ...processRequest, expiresAt: Number(expiresAt) })
      else assert.equal(await collectSnapshotJournalReceipts(t), 1)
      if (phase.endsWith('before-commit')) die()
    })
    if (phase.endsWith('after-commit')) die()
    throw new Error('Unreached owned crash boundary')
  } finally {
    await k.destroy()
  }
}
async function processLoss() {
  const k = open(),
    directory = await mkdtemp(join(tmpdir(), 'ts569-receipt-loss-')),
    results = []
  try {
    await runInSeries(['READ COMMITTED', 'REPEATABLE READ'], async isolation => {
      await runInSeries(
        ['record-before-commit', 'record-after-commit', 'collect-before-commit', 'collect-after-commit'],
        async phase => {
          await k('snapshot_journal_receipts').delete()
          await k('snapshot_journal_retention').update({ floor: '0', receiptLimit: 128, receiptLifetimeMs: 2592000000 })
          const request = { ...processRequest, expiresAt: Date.now() + 60000 },
            marker = join(directory, results.length + '.txt')
          if (phase.startsWith('collect'))
            await k('snapshot_journal_receipts').insert({
              ...request,
              binding: snapshotJournalReceiptBinding(binding),
              floor: '0',
              expiresAt: 1
            })
          const child = fork(__filename, ['child', phase, marker, isolation, String(request.expiresAt)], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc']
          })
          let stderr = ''
          child.stderr.on('data', chunk => {
            stderr = (stderr + chunk.toString()).slice(-6000)
          })
          const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
          let terminal
          try {
            terminal = await new Promise((resolve, reject) => {
              child.once('error', reject)
              child.once('exit', (code, signal) => resolve({ code, signal }))
            })
          } finally {
            clearTimeout(timer)
          }
          assert.equal(terminal.signal, 'SIGKILL', stderr)
          assert.equal(readFileSync(marker, 'utf8'), phase)
          const exists = phase === 'record-after-commit' || phase === 'collect-before-commit'
          assert.equal((await k('snapshot_journal_receipts')).length, exists ? 1 : 0)
          if (phase === 'record-after-commit')
            assert.equal(
              (await k.transaction(t => readSnapshotJournalReceipt(t, binding, request))).highWater,
              request.highWater
            )
          if (phase === 'record-before-commit')
            await assert.rejects(k.transaction(t => readSnapshotJournalReceipt(t, binding, request)))
          await k('receipt_fixture_source')
            .where('id', 1)
            .update({ value: results.length + 2 })
          results.push({
            isolation,
            phase,
            signal: terminal.signal,
            receiptPersisted: exists,
            sourceWriteAfterLoss: true
          })
        }
      )
    })
    return results
  } finally {
    await k.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}
async function main() {
  const results = []
  await runInSeries(['READ COMMITTED', 'REPEATABLE READ'], async isolation => {
    await runInSeries([false, true], async bigNumberStrings => {
      results.push(await qualify(isolation, bigNumberStrings))
    })
  })
  const crashes = await processLoss()
  console.log(
    JSON.stringify({
      status: 'native receipt-store and process-loss draft',
      results,
      crashes,
      productionAdoption: false,
      limitations: [
        'Synthetic receipt transactions do not establish full source-capture ordering',
        'Capture controller, floor/tombstone lifecycle and registered migration remain incomplete',
        'A receipt cannot reopen a killed retained read view'
      ]
    })
  )
}
;(process.argv[2] === 'child' ? crashChild() : main()).catch(e => {
  console.error(e)
  process.exitCode = 1
})
