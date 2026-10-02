const { runInSeries } = require('../../out/src/utility/runInSeries.js')
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
  completeSnapshotJournalMysqlGeneration: complete
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.js')
const {
  copySnapshotJournalBootstrapPage: copy
} = require('../../out/src/storage/snapshot/journal/SnapshotJournalBootstrap.js')
const ceiling = '9223372036854775807',
  intent = 'snapshot_journal_generation'
const { execFileSync } = require('node:child_process')
const { executable, context, validateContainer } = require('./snapshotArchiveDocker.cjs')
const containerId = process.env.TS_STACK_SNAPSHOT_CONTAINER_ID
const docker = (...args) =>
  execFileSync(executable, ['--context', context, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, MYSQL_PWD: process.env.TS_STACK_SNAPSHOT_MYSQL_SECRET },
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
function ownedServer() {
  const actual = JSON.parse(docker('inspect', containerId))[0]
  validateContainer(actual, {
    id: containerId,
    name: process.env.TS_STACK_SNAPSHOT_CONTAINER,
    owner: process.env.TS_STACK_SNAPSHOT_CONTAINER_OWNER
  })
  assert.deepEqual(actual.Config.Entrypoint, ['/bin/sh'])
  assert.equal(actual.HostConfig.Memory, 1073741824)
  assert.equal(actual.HostConfig.NanoCpus, 2000000000)
  assert.equal(actual.HostConfig.Binds, null)
  assert.equal(actual.HostConfig.Tmpfs['/var/lib/mysql'], 'rw,nosuid,nodev,size=512m')
  const pid = docker('exec', containerId, 'cat', '/var/lib/mysql/fixture.pid')
  assert(/^\d+$/.test(pid) && Number(pid) > 1)
  assert.equal(docker('exec', containerId, 'cat', '/proc/' + pid + '/comm'), 'mysqld')
  return pid
}
function crashServer() {
  const pid = ownedServer()
  docker('exec', containerId, '/bin/sh', '-c', 'kill -KILL "$1"', 'journal-fixture', pid)
  return pid
}
async function ready(previous) {
  const deadline = Date.now() + 20000
  let last, recovered
  function* attempts() {
    while (Date.now() < deadline && recovered === undefined) yield undefined
  }
  await runInSeries(attempts(), async () => {
    try {
      docker(
        'exec',
        '--env',
        'MYSQL_PWD',
        containerId,
        'mysqladmin',
        '--protocol=tcp',
        '--host=127.0.0.1',
        '--user=root',
        'ping'
      )
      const pid = ownedServer()
      assert.notEqual(pid, previous)
      recovered = pid
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  })
  if (recovered === undefined) throw last
  return recovered
}

async function isolate(k, isolation) {
  assert(['READ COMMITTED', 'REPEATABLE READ'].includes(isolation))
  await k.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
  const [[level]] = await k.raw('SELECT @@transaction_isolation isolation')
  assert.equal(level.isolation.replaceAll('-', ' '), isolation)
  await k.raw('SET SESSION innodb_lock_wait_timeout=5')
}
async function bootstrap(k) {
  let complete = false
  function* pages() {
    for (let i = 0; i < 100 && !complete; i++) yield i
  }
  await runInSeries(pages(), async () => {
    const page = await copy(k, 1000000)
    assert(!page.invalidated)
    complete = page.complete
  })
  assert(complete, 'Bootstrap did not complete within its bounded fixture pages')
}
async function finish(k) {
  await bootstrap(k)
  return await complete(k, ceiling, receiptPolicy)
}

async function clear(k) {
  const [triggers] = await k.raw(
    "SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND LEFT(TRIGGER_NAME,17)='snapshot_journal_'"
  )
  await runInSeries(triggers, async row => {
    await k.raw('DROP TRIGGER ??', [row.name])
  })
  const [names] = await k.raw(
    "SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LEFT(TABLE_NAME,17)='snapshot_journal_'"
  )
  await runInSeries(names, async row => {
    await k.schema.dropTable(row.name)
  })
}
async function rows(k) {
  const result = {}
  await runInSeries(tables, async name => {
    result[name] = (await k(name).select('*')).map(row => JSON.stringify(row)).sort()
  })
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
      const serverPid = crashServer()
      writeFileSync(marker, JSON.stringify({ phase, serverPid }))
      process.kill(process.pid, 'SIGKILL')
    }
  }
  const object = sql => /^CREATE (?:TABLE|TRIGGER) (snapshot_journal_\w+)/.exec(sql)?.[1]
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
      await bootstrap(k)
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
  const evidence = JSON.parse(readFileSync(marker, 'utf8'))
  assert.equal(evidence.phase, boundary)
  return { previousServerPid: evidence.serverPid, newServerPid: await ready(evidence.serverPid) }
}
async function main() {
  let k = open(),
    source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  const directory = await mkdtemp(join(tmpdir(), 'ts569-mysql-server-crash-')),
    results = []
  try {
    ownedServer()
    await source.migrate('journal server crash fixture', 'synthetic-journal-server-crash')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32)),
      { user: foreign } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(source, user.userId, foreign.userId)
    const baseline = await rows(k)
    await source.destroy()
    source = undefined
    k = undefined
    const boundaries = [
      'after-snapshot_journal_generation',
      'after-snapshot_journal_clock',
      'after-snapshot_journal_retention',
      'after-snapshot_journal_receipts',
      'after-snapshot_journal_scope_0_INSERT',
      'after-snapshot_journal_physical_12_DELETE',
      'bootstrap-after-budget-bind',
      'bootstrap-after-metadata',
      'bootstrap-after-progress',
      'bootstrap-after-commit',
      'complete-before-commit',
      'complete-after-commit'
    ]
    await runInSeries(['READ COMMITTED', 'REPEATABLE READ'], async isolation => {
      await runInSeries(boundaries, async boundary => {
        const restarted = await killAt(
          boundary,
          join(directory, isolation.replaceAll(' ', '-') + '-' + boundary),
          isolation
        )
        k = open()
        await isolate(k, isolation)
        const saved = await k(intent).first()
        assert(saved)
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
        assert.equal(resumed.epoch, saved.epoch)
        await finish(k)
        let charged = 0
        await runInSeries(
          [
            ...tables,
            'snapshot_profile_keys',
            'snapshot_relation_keys',
            'snapshot_certificate_field_keys',
            'snapshot_global_keys'
          ],
          async table => {
            charged += Number((await k(table).count('* AS n').first()).n)
          }
        )
        assert.equal((await k('snapshot_journal_bootstrap').first()).rowsUsed, charged)
        await exact(k)
        assert.deepEqual(await rows(k), baseline)
        await k('tx_labels').where('txLabelId', 1).update({ label: 'post-server-recovery writer' })
        await exact(k)
        await k('tx_labels')
          .where('txLabelId', 1)
          .update({
            label: JSON.parse(baseline.tx_labels.find(row => JSON.parse(row).txLabelId === 1)).label
          })
        await exact(k)
        assert.deepEqual(await rows(k), baseline)
        await clear(k)
        await k.destroy()
        k = undefined
        results.push({
          isolation,
          boundary,
          ...restarted,
          sourcePreserved: true,
          epochPreserved: true,
          bootstrapExact: true,
          writerRecovered: true
        })
        console.log(JSON.stringify(results.at(-1)))
      })
    })
    console.log(
      JSON.stringify({
        status: 'isolated MySQL server-process crash recovery',
        serverCrashes: results.length,
        results,
        readerAdvertised: false,
        limitations: [
          'tmpfs-backed single MySQL8.4 server; no machine power-loss,replication,PXC/failover or production performance acceptance',
          'registered migration,quota,receipt and receiver remain incomplete'
        ]
      })
    )
  } finally {
    if (source) await source.destroy()
    else if (k) await k.destroy()
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
