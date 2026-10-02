const receiptPolicy = { receiptLimit: 128, receiptLifetimeMs: 2592000000 }
const assert = require('node:assert/strict'),
  { fork } = require('node:child_process'),
  { mkdtemp, rm } = require('node:fs/promises'),
  { tmpdir } = require('node:os'),
  { join } = require('node:path'),
  { writeFileSync, readFileSync } = require('node:fs')
const {
  open,
  seedArchiveClosure,
  StorageKnex,
  StorageProvider,
  exact,
  tables
} = require('./snapshotJournalMysqlConnection.cjs')
const {
  installSnapshotJournalMysqlGeneration: install,
  readSnapshotJournalMysqlGeneration: read,
  completeSnapshotJournalMysqlGeneration: complete
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.js')
const {
  copySnapshotJournalBootstrapPage: copy
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalBootstrap.js')
const ceiling = '9223372036854775807',
  intent = 'snapshot_journal_generation'
async function isolate(k, isolation) {
  assert(['READ COMMITTED', 'REPEATABLE READ'].includes(isolation))
  await k.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
  const [[level]] = await k.raw('SELECT @@transaction_isolation isolation')
  assert.equal(level.isolation.replaceAll('-', ' '), isolation)
  await k.raw('SET SESSION innodb_lock_wait_timeout=5')
}
async function finish(k) {
  for (let i = 0; i < 100; i++) {
    const page = await copy(k, 1000000)
    assert(!page.invalidated)
    if (page.complete) return await complete(k, ceiling, receiptPolicy)
    assert(i < 99)
  }
}
async function clear(k) {
  const [triggers] = await k.raw(
    "SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND LEFT(TRIGGER_NAME,17)='snapshot_journal_'"
  )
  for (const row of triggers) await k.raw('DROP TRIGGER ??', [row.name])
  const [names] = await k.raw(
    "SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LEFT(TABLE_NAME,17)='snapshot_journal_'"
  )
  for (const row of names) await k.schema.dropTable(row.name)
}
async function rows(k) {
  const result = {}
  for (const name of tables) result[name] = (await k(name).select('*')).map(row => JSON.stringify(row)).sort()
  return result
}
async function child() {
  process.once('disconnect', () => process.exit(1))
  const childDeadline = setTimeout(() => process.exit(1), 20000)
  childDeadline.unref()
  const k = open(),
    boundary = process.argv[3],
    marker = process.argv[4],
    isolation = process.argv[5]
  let completing = false
  const park = phase => {
    if (boundary === phase) {
      writeFileSync(marker, phase)
      process.kill(process.pid, 'SIGKILL')
    }
  }
  const object = sql => /^CREATE (?:TABLE|TRIGGER) (snapshot_journal_[A-Za-z0-9_]+)/.exec(sql)?.[1]
  k.on('query', q => {
    const name = object(q.sql)
    if (name) park('before-' + name)
    if (completing && q.sql === 'COMMIT;') park('complete-before-commit')
  })
  k.on('query-response', (_r, q) => {
    const name = object(q.sql)
    if (name) park('after-' + name)
    if (q.sql.startsWith('update `snapshot_journal_generation` set `nextObject`')) park('after-ack-' + q.bindings[0])
    if (completing && q.sql === 'COMMIT;') park('complete-after-commit')
    if (q.sql.startsWith('update `snapshot_journal_bootstrap` set `rowLimit`')) park('bootstrap-after-budget-bind')
    if (q.sql.startsWith('insert into `snapshot_journal_physical`')) park('bootstrap-after-metadata')
    if (q.sql.startsWith('update `snapshot_journal_bootstrap` set `cursor`')) park('bootstrap-after-progress')
  })
  try {
    await isolate(k, isolation)
    await install(k, ceiling, receiptPolicy)
    if (boundary.startsWith('bootstrap-')) {
      await copy(k, 1000000)
      park('bootstrap-after-commit')
    }
    if (boundary.startsWith('complete-')) {
      for (let i = 0; i < 100; i++) {
        const page = await copy(k, 1000000)
        if (page.complete) break
        assert(i < 99)
      }
      completing = true
      await complete(k, ceiling, receiptPolicy)
      park('complete-after-commit')
    }
    throw new Error('Crash boundary missed: ' + boundary)
  } finally {
    await k.destroy()
  }
}
async function killAt(boundary, marker, isolation) {
  const p = fork(__filename, ['child', boundary, marker, isolation], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  let stderr = ''
  p.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-6000)
  })
  const timer = setTimeout(() => p.kill('SIGKILL'), 20000),
    result = await new Promise((resolve, reject) => {
      p.once('error', reject)
      p.once('exit', (code, signal) => resolve({ code, signal }))
    })
  clearTimeout(timer)
  assert.equal(result.signal, 'SIGKILL', stderr)
  assert.equal(readFileSync(marker, 'utf8'), boundary)
}
async function main() {
  const k = open(),
    source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k }),
    directory = await mkdtemp(join(tmpdir(), 'ts569-mysql-generation-')),
    results = []
  try {
    await source.migrate('journal generation fixture', 'synthetic-journal-generation')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32)),
      { user: foreign } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(source, user.userId, foreign.userId)
    const baseline = await rows(k)
    for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
      await isolate(k, isolation)
      await clear(k)
      const created = await install(k, ceiling, receiptPolicy)
      assert.equal(created.nextObject, 59)
      assert.equal(created.complete, false)
      assert.equal(created.enabled, true)
      assert.deepEqual(await install(k, ceiling, receiptPolicy), created)
      assert.deepEqual(await read(k, ceiling, receiptPolicy), created)
      await assert.rejects(complete(k, ceiling, receiptPolicy), /Invalid or unowned/)
      const outer = await k.transaction(),
        independent = open()
      try {
        await isolate(independent, isolation)
        await outer('snapshot_journal_bootstrap').first()
        assert.equal((await copy(independent, 1000000)).invalidated, false)
        const progress = await independent('snapshot_journal_bootstrap').first()
        await assert.rejects(copy(outer, 1000000), /Invalid snapshot journal bootstrap/)
        assert.deepEqual(await independent('snapshot_journal_bootstrap').first(), progress)
      } finally {
        await outer.rollback()
        await independent.destroy()
      }
      const completed = await finish(k)
      await exact(k)
      assert.equal(completed.complete, true)
      assert.equal(completed.epoch, created.epoch)
      assert.deepEqual(await read(k, ceiling, receiptPolicy), completed)
      assert.deepEqual(await complete(k, ceiling, receiptPolicy), completed)
      await k.transaction(async t => assert.deepEqual(await read(t, ceiling, receiptPolicy), completed))
      for (const [_name, up, down] of [
        [
          'owner-comment',
          "ALTER TABLE snapshot_journal_clock COMMENT='foreign'",
          "ALTER TABLE snapshot_journal_clock COMMENT='snapshot-journal-owner:" + created.epoch + "'"
        ],
        [
          'index',
          'CREATE INDEX foreign_generation_index ON snapshot_journal_physical(present)',
          'DROP INDEX foreign_generation_index ON snapshot_journal_physical'
        ],
        [
          'check',
          'ALTER TABLE snapshot_journal_clock ALTER CHECK snapshot_journal_clock_chk_1 NOT ENFORCED',
          'ALTER TABLE snapshot_journal_clock ALTER CHECK snapshot_journal_clock_chk_1 ENFORCED'
        ],
        [
          'foreign-observer',
          'CREATE TRIGGER foreign_generation_observer AFTER UPDATE ON snapshot_journal_clock FOR EACH ROW BEGIN DO 0; END',
          'DROP TRIGGER foreign_generation_observer'
        ],
        [
          'source-binding',
          "ALTER TABLE tx_labels ALTER label SET DEFAULT 'changed'",
          'ALTER TABLE tx_labels ALTER label DROP DEFAULT'
        ]
      ]) {
        await k.raw(up)
        await assert.rejects(read(k, ceiling, receiptPolicy), /Invalid or unowned/)
        await assert.rejects(install(k, ceiling, receiptPolicy), /Invalid or unowned/)
        await k.raw(down)
        assert.deepEqual(await read(k, ceiling, receiptPolicy), completed)
      }
      await k(intent).update({ nextObject: 58, complete: 0 })
      await k.raw('CREATE TABLE snapshot_journal_foreign(id INT)')
      await assert.rejects(install(k, ceiling, receiptPolicy), /Invalid or unowned/)
      assert(await k.schema.hasTable('snapshot_journal_foreign'))
      await k.schema.dropTable('snapshot_journal_foreign')
      await k(intent).update({ nextObject: 59, complete: 1 })
      await k('snapshot_journal_clock').delete()
      await assert.rejects(install(k, ceiling, receiptPolicy), /Invalid or unowned/)
      await k('snapshot_journal_clock').insert({ id: 1, ceiling })
      await k('snapshot_journal_bootstrap').update({ stream: 16, cursor: null })
      await assert.rejects(read(k, ceiling, receiptPolicy), /Invalid or unowned/)
      await k('snapshot_journal_bootstrap').update({ stream: 17, cursor: null })
      await exact(k)
      assert.deepEqual(await rows(k), baseline)
      await clear(k)
      const boundaries = [
        'before-snapshot_journal_generation',
        'after-snapshot_journal_generation',
        'before-snapshot_journal_clock',
        'after-snapshot_journal_clock',
        'after-snapshot_journal_bootstrap',
        'before-snapshot_journal_retention',
        'after-snapshot_journal_retention',
        'before-snapshot_journal_receipts',
        'after-snapshot_journal_receipts',
        'after-snapshot_journal_scope_0_INSERT',
        'after-ack-7',
        'after-snapshot_journal_physical_12_DELETE',
        'after-ack-59',
        'bootstrap-after-budget-bind',
        'bootstrap-after-metadata',
        'bootstrap-after-progress',
        'bootstrap-after-commit',
        'complete-before-commit',
        'complete-after-commit'
      ]
      for (const boundary of boundaries) {
        await killAt(boundary, join(directory, isolation.replaceAll(' ', '-') + '-' + boundary), isolation)
        const saved = (await k.schema.hasTable(intent)) ? await k(intent).first() : undefined
        if (boundary.startsWith('complete-')) assert.equal(saved.complete, boundary === 'complete-after-commit' ? 1 : 0)
        if (boundary.startsWith('bootstrap-')) {
          const committed = boundary === 'bootstrap-after-commit',
            progress = await k('snapshot_journal_bootstrap').first()
          assert.equal(progress.rowsUsed, committed ? baseline.transactions.length : 0)
          assert.equal(progress.rowLimit, committed ? 1000000 : null)
          assert.equal(
            progress.cursor,
            committed
              ? JSON.stringify([Math.max(...baseline.transactions.map(text => JSON.parse(text).transactionId))])
              : null
          )
        }
        const resumed = await install(k, ceiling, receiptPolicy)
        if (saved) assert.equal(resumed.epoch, saved.epoch)
        await finish(k)
        let charged = 0
        for (const table of [
          ...tables,
          'snapshot_profile_keys',
          'snapshot_relation_keys',
          'snapshot_certificate_field_keys',
          'snapshot_global_keys'
        ])
          charged += Number((await k(table).count('* AS n').first()).n)
        assert.equal((await k('snapshot_journal_bootstrap').first()).rowsUsed, charged)
        await exact(k)
        assert.deepEqual(await rows(k), baseline)
        await k('tx_labels').where('txLabelId', 1).update({ label: 'post-recovery writer' })
        await k('tx_labels')
          .where('txLabelId', 1)
          .update({
            label: JSON.parse(baseline.tx_labels.find(row => JSON.parse(row).txLabelId === 1)).label
          })
        await exact(k)
        assert.deepEqual(await rows(k), baseline)
        await clear(k)
        console.log(JSON.stringify({ isolation, boundary, status: 'passed' }))
      }
      results.push({
        isolation,
        installedObjects: 60,
        exactResumeAndSourcePreserved: true,
        bootstrapAndObservers: true,
        refusals: true,
        clientSigkillBoundaries: boundaries.length,
        completionAtomic: true,
        writerBarrierReleased: true
      })
    }
    console.log(
      JSON.stringify({
        status: 'MySQL journal generation',
        results,
        readerAdvertised: false,
        limitations: [
          'client SIGKILL only; server-crash/replication/failover remains open',
          'registered forward migration,quota,receipt and receiver remain incomplete'
        ]
      })
    )
  } finally {
    await source.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}
if (process.argv[2] === 'child')
  child().catch(e => {
    console.error(e)
    process.exitCode = 1
  })
else
  main().catch(e => {
    console.error(e)
    process.exitCode = 1
  })
