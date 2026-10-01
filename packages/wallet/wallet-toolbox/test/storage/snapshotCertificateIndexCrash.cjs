// Synthetic process-loss qualification, invoked by the existing native fixtures.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const { writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { knex } = require('knex')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const { KnexMigrations } = require('../../out/src/storage/schema/KnexMigrations.js')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  readSnapshotCertificateIndexState,
  SNAPSHOT_CERTIFICATE_INDEX_MIGRATION
} = require('../../out/src/storage/schema/snapshotCertificateIndexMigration.js')

const phases = [
  'after-key-table',
  'after-first-index',
  'partial-observers',
  'partial-producers',
  'before-cursor',
  'after-cursor',
  'after-commit'
]
const migrationName = 'synthetic certificate crash'
const migrationIdentity = 'synthetic-certificate-crash'
const { oracle } = require('./snapshotCertificateIndexMysqlSchedules.cjs')
const dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
const provider = options =>
  new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: knex(options) })

async function seed(options) {
  const source = provider(options)
  try {
    if (options.client === 'better-sqlite3') await source.knex.raw('PRAGMA journal_mode = WAL')
    await source.migrate(migrationName, migrationIdentity)
    await source.makeAvailable()
    const migrationSource = new KnexMigrations('test', migrationName, migrationIdentity, 1024)
    await source.knex.migrate.down({
      migrationSource,
      name: SNAPSHOT_CERTIFICATE_INDEX_MIGRATION,
      disableTransactions: false
    })
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32))
    const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await source.knex('certificates').insert({
      ...dates,
      certificateId: 1,
      userId: user.userId,
      serialNumber: 'synthetic-certificate',
      type: 'type',
      certifier: '02' + '11'.repeat(32),
      subject: '02' + '11'.repeat(32),
      revocationOutpoint: 'a'.repeat(64) + '.0',
      signature: 'synthetic',
      isDeleted: false
    })
    await runInSeries([0, 1, 2], async batch => {
      await source.knex('certificate_fields').insert(
        Array.from({ length: 200 }, (_, i) => ({
          ...dates,
          userId: user.userId,
          certificateId: 1,
          fieldName: String(batch * 200 + i).padStart(6, '0'),
          fieldValue: 'synthetic',
          masterKey: 'synthetic'
        }))
      )
    })
    return { userId: user.userId, otherId: other.userId }
  } finally {
    await source.destroy()
  }
}

async function child(options, phase, marker) {
  assert(phases.includes(phase))
  assert.equal(typeof process.send, 'function', 'Child requires its fixture parent')
  const source = provider(options)
  let cursorWritten = false
  const cursor = query =>
    query.sql.startsWith('update `snapshot_certificate_index_progress`') && query.bindings.includes('000255')
  const park = event => {
    writeFileSync(marker, JSON.stringify({ phase, event }), { mode: 0o600 })
    process.kill(process.pid, 'SIGKILL')
  }
  source.knex.on('query', query => {
    if (phase === 'before-cursor' && cursor(query)) park('query')
    if (phase === 'after-commit' && cursorWritten && query.sql.toLowerCase().startsWith('begin'))
      park('next-transaction')
  })
  source.knex.on('query-response', (_result, query) => {
    const sql = query.sql.toLowerCase()
    if (phase === 'after-key-table' && sql.startsWith('create table `snapshot_certificate_field_keys`'))
      park('query-response')
    if (
      phase === 'after-first-index' &&
      (sql.startsWith('create index `snapshot_certificate_parent`') ||
        sql.startsWith('alter table `snapshot_certificate_field_keys` add index `snapshot_certificate_parent`'))
    )
      park('query-response')
    if (phase === 'partial-observers' && sql.startsWith('create trigger snapshot_certificate_field_delete '))
      park('query-response')
    if (phase === 'partial-producers' && sql.startsWith('create trigger snapshot_certificate_field_insert '))
      park('query-response')
    if (cursor(query)) {
      cursorWritten = true
      if (phase === 'after-cursor') park('query-response')
    }
    if (phase === 'after-commit' && cursorWritten && sql.startsWith('commit')) park('query-response')
  })
  try {
    await source.migrate(migrationName, migrationIdentity)
    throw new Error('Expected migration boundary was not reached')
  } finally {
    await source.destroy()
  }
}

async function terminateAt(options, phase) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts569-certificate-boundary-'))
  const marker = path.join(directory, 'boundary.json')
  const processHandle = spawn(process.execPath, [__filename, 'child'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  processHandle.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-65536)
  })
  const exited = new Promise((resolve, reject) => {
    processHandle.once('exit', (code, signal) => resolve({ code, signal }))
    processHandle.once('error', reject)
  })
  const timer = setTimeout(() => processHandle.kill('SIGKILL'), 15000)
  try {
    processHandle.send({ options, phase, marker })
    const result = await exited
    assert.equal(result.signal, 'SIGKILL', stderr)
    const observed = JSON.parse(await fs.readFile(marker, 'utf8'))
    assert.equal(observed.phase, phase)
    return { phase, event: observed.event, signal: result.signal }
  } finally {
    clearTimeout(timer)
    if (processHandle.exitCode === null && processHandle.signalCode === null) {
      processHandle.kill('SIGKILL')
      await exited
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function qualify(options, phase) {
  const { userId, otherId } = await seed(options)
  const outcome = await terminateAt(options, phase)
  const source = provider(options)
  const database = source.knex
  try {
    assert.equal(await readSnapshotCertificateIndexState(database), false)
    if (['before-cursor', 'after-cursor', 'after-commit'].includes(phase)) {
      const committed = phase === 'after-commit'
      const progress = await database('snapshot_certificate_index_progress').where('snapshotTableId', 0).first()
      assert.equal(progress.afterFieldName, committed ? '000255' : '')
      assert.equal(progress.started, committed ? 1 : 0)
      assert.equal(progress.afterCertificateId, committed ? 1 : 0)
      assert.equal(
        Number((await database('snapshot_certificate_field_keys').count({ count: '*' }).first()).count),
        committed ? 256 : 0
      )
    }
    await database('certificates').where('certificateId', 1).update({ userId: otherId })
    await database('certificate_fields').where('fieldName', '000004').delete()
    await database('certificate_fields').insert({
      ...dates,
      userId,
      certificateId: 1,
      fieldName: '000003a',
      fieldValue: 'inserted-behind-cursor',
      masterKey: 'synthetic'
    })
    // A killed migrator leaves Knex's lock claimed. This is fixture-owned recovery;
    // the verified child is gone and no other migrator can own this isolated store.
    await database.migrate.forceFreeMigrationsLock()
    await source.migrate(migrationName, migrationIdentity)
    assert.equal(await readSnapshotCertificateIndexState(database), true)
    await oracle(database)
    assert.equal(
      Number(
        (
          await database('knex_migrations')
            .where('name', SNAPSHOT_CERTIFICATE_INDEX_MIGRATION)
            .count({ count: '*' })
            .first()
        ).count
      ),
      1
    )
    return { ...outcome, journalPublishedAfterRecovery: true, independentProfileChangeAndLowIdInsert: true }
  } finally {
    await source.destroy()
  }
}

async function qualifySQLiteCertificateIndexProcessLoss() {
  const results = []
  await runInSeries(phases, async phase => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts569-certificate-index-crash-'))
    try {
      results.push(
        await qualify(
          {
            client: 'better-sqlite3',
            connection: { filename: path.join(directory, 'wallet.sqlite') },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 }
          },
          phase
        )
      )
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
  return results
}

async function qualifyMysqlCertificateIndexProcessLoss(control, connection) {
  // The calling fixture has already verified its disposable, pinned container.
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.database, 'ts569_snapshot')
  const results = []
  await runInSeries(phases, async phase => {
    const database = 'ts569_certificate_' + randomUUID().replaceAll('-', '')
    await control.raw('CREATE DATABASE ??', [database])
    try {
      results.push(
        await qualify({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } }, phase)
      )
    } finally {
      await control.raw('DROP DATABASE ??', [database])
    }
  })
  return results
}

if (process.argv[2] === 'child') {
  assert.equal(typeof process.send, 'function', 'Child execution requires its fixture parent')
  process.once('message', ({ options, phase, marker }) => {
    child(options, phase, marker).catch(error => {
      console.error(error)
      process.exitCode = 1
      process.disconnect()
    })
  })
}
module.exports = { qualifySQLiteCertificateIndexProcessLoss, qualifyMysqlCertificateIndexProcessLoss }
