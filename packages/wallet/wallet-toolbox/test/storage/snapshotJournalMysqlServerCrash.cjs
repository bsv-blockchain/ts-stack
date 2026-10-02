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
  assert(/^[0-9]+$/.test(pid) && Number(pid) > 1)
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
  let last
  while (Date.now() < deadline) {
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
      return pid
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  throw last
}

async function isolate(k, isolation) {
  assert(['READ COMMITTED', 'REPEATABLE READ'].includes(isolation))
  await k.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation)
  const [[level]] = await k.raw('SELECT @@transaction_isolation isolation')
  assert.equal(level.isolation.replaceAll('-', ' '), isolation)
  await k.raw('SET SESSION innodb_lock_wait_timeout=5')
}
async function finish(k) {
  for (let i = 0; i < 100; i++) {
    const page = await copy(k)
    assert(!page.invalidated)
    if (page.complete) return await complete(k, ceiling)
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
      const serverPid = crashServer()
      writeFileSync(marker, JSON.stringify({ phase, serverPid }))
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
  })
  try {
    await isolate(k, isolation)
    await install(k, ceiling)
    if (boundary.startsWith('complete-')) {
      for (let i = 0; i < 100; i++) {
        const page = await copy(k)
        if (page.complete) break
        assert(i < 99)
      }
      completing = true
      await complete(k, ceiling)
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
      'after-snapshot_journal_scope_0_INSERT',
      'after-snapshot_journal_physical_12_DELETE',
      'complete-before-commit',
      'complete-after-commit'
    ]
    for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
      for (const boundary of boundaries) {
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
        const resumed = await install(k, ceiling)
        assert.equal(resumed.epoch, saved.epoch)
        await finish(k)
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
      }
    }
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
