// Invoked only by the verified disposable native MySQL fixture.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { knex } = require('knex')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const {
  snapshotNumericRelations: relations,
  addSnapshotRelationIndexes: install
} = require('../../out/src/storage/schema/snapshotRelationIndexMigration.js')
const settle = promise =>
  promise.then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  )
function success(result) {
  if (!result.ok) throw result.error
}
async function until(check) {
  let result
  function* attempts() {
    for (let i = 0; i < 1000 && !result; i++) yield i
  }
  await runInSeries(attempts(), async () => {
    result = await check()
    if (!result) await new Promise(resolve => setTimeout(resolve, 5))
  })
  if (!result) throw new Error('Native lock observation exceeded five seconds')
  return result
}

async function fixture(admin, connection, isolation, relation, tableId) {
  const database = 'ts569_relation_locks_' + randomUUID().replaceAll('-', '')
  await admin.raw('CREATE DATABASE ??', [database])
  const open = () => knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } })
  const k = open(),
    writer = open(),
    observer = open()
  const events = []
  let transaction
  try {
    await runInSeries([k, writer, observer], async client => {
      await client.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation.toUpperCase())
    })
    await runInSeries(relations, async p => {
      await runInSeries(
        [
          [p.left, p.leftKey],
          [p.right, p.rightKey]
        ],
        async ([table, key]) => {
          await k.schema.createTable(table, t => {
            t.integer(key).primary()
            t.integer('userId').notNullable()
          })
          await k(table).insert({ [key]: 1, userId: 1 })
        }
      )
      await k.schema.createTable(p.table, t => {
        t.integer(p.leftKey)
        t.integer(p.rightKey)
        t.boolean('isDeleted')
        t.primary([p.leftKey, p.rightKey])
        t.index(p.rightKey)
      })
    })
    await install(k)
    const p = relation
    const mapping = { [p.leftKey]: 1, [p.rightKey]: 1, isDeleted: false }
    const expected = () => [
      { snapshotTableId: tableId, snapshotUserId: 1, snapshotLeftId: 1, snapshotRightId: 1, snapshotMembership: 2 },
      { snapshotTableId: tableId, snapshotUserId: 2, snapshotLeftId: 1, snapshotRightId: 1, snapshotMembership: 1 }
    ]
    const verify = async () =>
      assert.deepEqual(
        await k('snapshot_relation_keys').where('snapshotTableId', tableId).orderBy('snapshotUserId'),
        expected()
      )
    const reset = async () => {
      await k(p.table).delete()
      await k(p.left).where(p.leftKey, 1).update({ userId: 1 })
    }
    const waiting = async (table, requester) => {
      const [rows] = await observer.raw(
        'SELECT l.OBJECT_NAME AS tableName, l.LOCK_MODE AS lockMode, t.PROCESSLIST_ID AS requester FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME=? AND t.PROCESSLIST_ID=?',
        [table, requester]
      )
      return rows.length ? rows : false
    }
    const connectionId = async client => Number((await client.raw('SELECT CONNECTION_ID() AS id'))[0][0].id)
    const kId = await connectionId(k)
    const writerId = await connectionId(writer)

    // The map cannot use an owner whose transaction has not committed yet.
    transaction = await writer.transaction()
    await transaction(p.left).where(p.leftKey, 1).update({ userId: 2 })
    let done = false
    const first = settle(
      k(p.table)
        .insert(mapping)
        .then(() => {
          done = true
        })
    )
    try {
      // RR's parent producer protects the empty map range with a next-key lock,
      // so the concurrent insert waits there before reaching its parent lookup.
      const blockedTable = isolation === 'repeatable read' ? p.table : p.left
      const locks = await until(() => waiting(blockedTable, kId))
      assert.ok(
        locks.every(lock =>
          isolation === 'repeatable read' ? lock.lockMode.includes('INSERT_INTENTION') : lock.lockMode.startsWith('S')
        )
      )
      assert.equal(done, false)
      events.push({ case: 'map waits for committed parent owner', locks })
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    success(await first)
    await verify()

    // The map producer retains parent protection until its own commit.
    await reset()
    transaction = await writer.transaction()
    await transaction(p.table).insert(mapping)
    done = false
    const second = settle(
      k(p.left)
        .where(p.leftKey, 1)
        .update({ userId: 2 })
        .then(() => {
          done = true
        })
    )
    try {
      const locks = await until(() => waiting(p.left, kId))
      assert.equal(done, false)
      events.push({ case: 'parent waits for map publication', locks })
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    success(await second)
    await verify()

    await reset()
    transaction = await k.transaction()
    try {
      assert.equal((await transaction(p.left).where(p.leftKey, 1).first()).userId, 1)
      await writer(p.left).where(p.leftKey, 1).update({ userId: 2 })
      await transaction(p.table).insert(mapping)
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    await verify()
    events.push({ case: 'map producer ignores earlier consistent owner snapshot' })

    await reset()
    transaction = await k.transaction()
    try {
      assert.equal((await transaction(p.table)).length, 0)
      await writer(p.table).insert(mapping)
      await transaction(p.left).where(p.leftKey, 1).update({ userId: 2 })
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    await verify()
    events.push({ case: 'parent producer ignores earlier consistent map snapshot' })

    // Replay a bounded bootstrap while an independent owner change is pending.
    await k('snapshot_relation_keys').where('snapshotTableId', tableId).delete()
    await k('snapshot_relation_index_progress')
      .where('snapshotTableId', tableId)
      .update({ afterLeftId: 0, afterRightId: 0, complete: false })
    transaction = await writer.transaction()
    await transaction(p.left).where(p.leftKey, 1).update({ userId: 1 })
    await transaction(p.left).where(p.leftKey, 1).update({ userId: 2 })
    const bootstrapWait = settle(install(k))
    try {
      const locks = await until(() => waiting(p.table, kId))
      events.push({ case: 'bootstrap waits for current committed relation', locks })
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    success(await bootstrapWait)
    await verify()

    // Pause after both source/parent reads but before auxiliary key publication.
    await k(p.left).where(p.leftKey, 1).update({ userId: 1 })
    await k('snapshot_relation_keys').where('snapshotTableId', tableId).delete()
    await k('snapshot_relation_index_progress')
      .where('snapshotTableId', tableId)
      .update({ afterLeftId: 0, afterRightId: 0, complete: false })
    let reached = false,
      release
    const gate = new Promise(resolve => {
      release = resolve
    })
    const prototype = Object.getPrototypeOf(k.client)
    const original = prototype.query
    const hadOwn = Object.hasOwn(prototype, 'query')
    prototype.query = async function (conn, query) {
      const sql = typeof query === 'string' ? query : query.sql
      if (!reached && sql.startsWith('insert into `snapshot_relation_keys`')) {
        reached = true
        await gate
      }
      return await original.call(this, conn, query)
    }
    const bootstrap = settle(install(k))
    let update
    try {
      await until(async () => reached)
      done = false
      update = settle(
        writer(p.left)
          .where(p.leftKey, 1)
          .update({ userId: 2 })
          .then(() => {
            done = true
          })
      )
      const locks = await until(() => waiting(p.left, writerId))
      assert.equal(done, false)
      events.push({ case: 'bootstrap retains source protection through key and cursor commit', locks })
    } finally {
      release()
      if (hadOwn) prototype.query = original
      else delete prototype.query
      success(await bootstrap)
      if (update !== undefined) success(await update)
    }
    await verify()
    return { isolation, relation: p.table, events }
  } finally {
    if (transaction !== undefined && !transaction.isCompleted()) await transaction.rollback()
    await observer.destroy()
    await writer.destroy()
    await k.destroy()
    await admin.raw('DROP DATABASE ??', [database])
  }
}

async function qualifyMysqlRelationIndexLocks(control, connection) {
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.database, 'ts569_snapshot')
  const results = []
  await runInSeries(['read committed', 'repeatable read'], async isolation => {
    await runInSeries(relations.entries(), async ([tableId, relation]) => {
      results.push(await fixture(control, connection, isolation, relation, tableId))
    })
  })
  return results
}
module.exports = { qualifyMysqlRelationIndexLocks }
