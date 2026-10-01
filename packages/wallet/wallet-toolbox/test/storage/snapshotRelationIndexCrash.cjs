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
  readSnapshotRelationIndexState,
  snapshotNumericRelations,
  SNAPSHOT_RELATION_INDEX_MIGRATION
} = require('../../out/src/storage/schema/snapshotRelationIndexMigration.js')

const phases = [
  'after-key-table',
  'after-first-index',
  'partial-observers',
  'partial-producers',
  'before-cursor',
  'after-cursor',
  'after-commit'
]
const migrationName = 'synthetic relation crash'
const migrationIdentity = 'synthetic-relation-crash'
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
      name: SNAPSHOT_RELATION_INDEX_MIGRATION,
      disableTransactions: false
    })
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32))
    const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await source
      .knex('transactions')
      .insert({
        ...dates,
        transactionId: 1,
        userId: user.userId,
        status: 'completed',
        reference: 'synthetic-relation',
        isOutgoing: true,
        satoshis: 0,
        description: ''
      })
    await source
      .knex('outputs')
      .insert({
        ...dates,
        outputId: 1,
        userId: user.userId,
        transactionId: 1,
        spendable: false,
        change: false,
        vout: 0,
        satoshis: 1,
        providedBy: 'you',
        purpose: '',
        type: 'P2PKH'
      })
    await runInSeries(snapshotNumericRelations, async relation => {
      await runInSeries([0, 1, 2], async batch => {
        const rows = Array.from({ length: 200 }, (_, i) => batch * 200 + i + 1).filter(id => id !== 9)
        const name = relation.left === 'tx_labels' ? 'label' : 'tag'
        await source
          .knex(relation.left)
          .insert(
            rows.map(id => ({
              ...dates,
              [relation.leftKey]: id,
              userId: user.userId,
              [name]: `synthetic-${id}`,
              isDeleted: false
            }))
          )
        await source
          .knex(relation.table)
          .insert(
            rows.map(id => ({ ...dates, [relation.leftKey]: id, [relation.rightKey]: 1, isDeleted: id % 2 === 0 }))
          )
      })
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
    query.sql.startsWith('update `snapshot_relation_index_progress`') &&
    query.bindings[0] === 257 &&
    query.bindings[1] === 1 &&
    query.bindings.at(-1) === 0
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
    if (phase === 'after-key-table' && sql.startsWith('create table `snapshot_relation_keys`')) park('query-response')
    if (
      phase === 'after-first-index' &&
      (sql.startsWith('create index `snapshot_relation_right`') ||
        sql.startsWith('alter table `snapshot_relation_keys` add index `snapshot_relation_right`'))
    )
      park('query-response')
    if (phase === 'partial-observers' && sql.startsWith('create trigger snapshot_relation_0_map_delete '))
      park('query-response')
    if (phase === 'partial-producers' && sql.startsWith('create trigger snapshot_relation_0_map_insert '))
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts569-relation-boundary-'))
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
    assert.equal(await readSnapshotRelationIndexState(database), false)
    if (['before-cursor', 'after-cursor', 'after-commit'].includes(phase)) {
      const committed = phase === 'after-commit'
      const progress = await database('snapshot_relation_index_progress').where('snapshotTableId', 0).first()
      assert.equal(progress.afterLeftId, committed ? 257 : 0)
      assert.equal(progress.afterRightId, committed ? 1 : 0)
      assert.equal(
        Number(
          (await database('snapshot_relation_keys').where('snapshotTableId', 0).count({ count: '*' }).first()).count
        ),
        committed ? 256 : 0
      )
    }
    await runInSeries(snapshotNumericRelations, async relation => {
      await database(relation.left).where(relation.leftKey, 3).update({ userId: otherId })
      const name = relation.left === 'tx_labels' ? 'label' : 'tag'
      await database(relation.left).insert({
        ...dates,
        [relation.leftKey]: 9,
        userId,
        [name]: 'reinserted-behind-cursor',
        isDeleted: false
      })
      await database(relation.table).insert({
        ...dates,
        [relation.leftKey]: 9,
        [relation.rightKey]: 1,
        isDeleted: true
      })
      await database(relation.table).where(relation.leftKey, 4).delete()
    })
    // A killed migrator leaves Knex's lock claimed. This is fixture-owned recovery;
    // the verified child is gone and no other migrator can own this isolated store.
    await database.migrate.forceFreeMigrationsLock()
    await source.migrate(migrationName, migrationIdentity)
    assert.equal(await readSnapshotRelationIndexState(database), true)
    await runInSeries(snapshotNumericRelations.entries(), async ([tableId, relation]) => {
      const left = new Map((await database(relation.left)).map(row => [row[relation.leftKey], row.userId]))
      const right = new Map((await database(relation.right)).map(row => [row[relation.rightKey], row.userId]))
      const expected = []
      for (const row of await database(relation.table)) {
        const owners = new Map()
        for (const [userId, bit] of [
          [left.get(row[relation.leftKey]), 1],
          [right.get(row[relation.rightKey]), 2]
        ])
          if (userId !== undefined) owners.set(userId, (owners.get(userId) ?? 0) | bit)
        for (const [userId, membership] of owners)
          expected.push({
            snapshotTableId: tableId,
            snapshotUserId: userId,
            snapshotLeftId: row[relation.leftKey],
            snapshotRightId: row[relation.rightKey],
            snapshotMembership: membership
          })
      }
      expected.sort(
        (a, b) =>
          a.snapshotUserId - b.snapshotUserId ||
          a.snapshotLeftId - b.snapshotLeftId ||
          a.snapshotRightId - b.snapshotRightId
      )
      assert.deepEqual(
        await database('snapshot_relation_keys')
          .where('snapshotTableId', tableId)
          .orderBy(['snapshotUserId', 'snapshotLeftId', 'snapshotRightId']),
        expected
      )
    })
    assert.equal(
      Number(
        (
          await database('knex_migrations')
            .where('name', SNAPSHOT_RELATION_INDEX_MIGRATION)
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

async function qualifySQLiteRelationIndexProcessLoss() {
  const results = []
  await runInSeries(phases, async phase => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts569-relation-index-crash-'))
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

async function qualifyMysqlRelationIndexProcessLoss(control, connection) {
  // The calling fixture has already verified its disposable, pinned container.
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.database, 'ts569_snapshot')
  const results = []
  await runInSeries(phases, async phase => {
    const database = 'ts569_relation_' + randomUUID().replaceAll('-', '')
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
module.exports = { qualifySQLiteRelationIndexProcessLoss, qualifyMysqlRelationIndexProcessLoss }
