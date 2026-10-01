// Synthetic current-read and bootstrap-lock qualification on the native MySQL fixture.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { knex } = require('knex')
const { oracle } = require('./snapshotCertificateIndexMysqlSchedules.cjs')
const helper = require('../../out/src/storage/schema/snapshotCertificateIndexMigration.js')
const install = helper.addSnapshotCertificateIndexes
const bootstrap = install
const settle = promise =>
  promise.then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  )
const success = result => {
  if (!result.ok) throw result.error
}
async function until(check) {
  for (let i = 0; i < 1000; i++) {
    const result = await check()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Native lock observation exceeded five seconds')
}
async function fixture(admin, connection, isolation) {
  const database = 'ts569_cert_locks_' + randomUUID().replaceAll('-', '')
  await admin.raw('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci', [database])
  const open = () => knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } })
  const k = open(),
    writer = open(),
    observer = open(),
    events = []
  let transaction
  try {
    for (const client of [k, writer, observer])
      await client.raw('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolation.toUpperCase())
    await k.raw(
      'CREATE TABLE certificates(certificateId INT UNSIGNED PRIMARY KEY,userId INT UNSIGNED NOT NULL,isDeleted TINYINT NOT NULL DEFAULT 0) ENGINE=InnoDB'
    )
    await k.raw(
      'CREATE TABLE certificate_fields(userId INT UNSIGNED NOT NULL,fieldName VARCHAR(100) NOT NULL,certificateId INT UNSIGNED NOT NULL,fieldValue VARCHAR(255) NOT NULL,UNIQUE(fieldName,certificateId)) ENGINE=InnoDB'
    )
    await k('certificates').insert({ certificateId: 1, userId: 1 })
    await install(k)
    const field = { userId: 1, fieldName: 'A', certificateId: 1, fieldValue: 'synthetic' }
    const reset = async () => {
      await k('certificate_fields').delete()
      await k('certificates').where({ certificateId: 1 }).update({ userId: 1 })
    }
    const verify = async () => {
      await oracle(k)
      assert.deepEqual(
        await k('snapshot_certificate_field_keys')
          .select({
            userId: 'snapshotUserId',
            fieldName: 'snapshotFieldName',
            certificateId: 'snapshotCertificateId',
            membership: 'snapshotMembership'
          })
          .orderBy('snapshotUserId'),
        [
          { userId: 1, fieldName: 'A', certificateId: 1, membership: 1 },
          { userId: 2, fieldName: 'A', certificateId: 1, membership: 2 }
        ]
      )
    }
    const id = async client => Number((await client.raw('SELECT CONNECTION_ID() AS id'))[0][0].id)
    const kId = await id(k),
      writerId = await id(writer)
    const waiting = async requester => {
      const [rows] = await observer.raw(
        'SELECT l.OBJECT_NAME AS tableName,l.LOCK_MODE AS lockMode,t.PROCESSLIST_ID AS requester FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND t.PROCESSLIST_ID=?',
        [requester]
      )
      return rows.length ? rows : false
    }
    transaction = await writer.transaction()
    await transaction('certificates').where({ certificateId: 1 }).update({ userId: 2 })
    let finished = false
    const first = settle(
      k('certificate_fields')
        .insert(field)
        .then(() => {
          finished = true
        })
    )
    try {
      const locks = await until(() => waiting(kId))
      assert.equal(finished, false)
      events.push({ case: 'field publication waits for current parent ownership', locks })
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    success(await first)
    await verify()

    await reset()
    transaction = await writer.transaction()
    await transaction('certificate_fields').insert(field)
    finished = false
    const second = settle(
      k('certificates')
        .where({ certificateId: 1 })
        .update({ userId: 2 })
        .then(() => {
          finished = true
        })
    )
    try {
      const locks = await until(() => waiting(kId))
      assert.equal(finished, false)
      assert.ok(locks.some(row => row.tableName === 'certificates'))
      events.push({ case: 'parent update waits for field publication', locks })
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    success(await second)
    await verify()

    await reset()
    transaction = await k.transaction()
    try {
      assert.equal((await transaction('certificates').first()).userId, 1)
      await writer('certificates').where({ certificateId: 1 }).update({ userId: 2 })
      await transaction('certificate_fields').insert(field)
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    await verify()
    events.push({ case: 'field producer ignores earlier consistent parent snapshot' })

    await reset()
    transaction = await k.transaction()
    try {
      assert.equal((await transaction('snapshot_certificate_field_keys')).length, 0)
      await writer('certificate_fields').insert(field)
      await transaction('certificates').where({ certificateId: 1 }).update({ userId: 2 })
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    await verify()
    events.push({ case: 'parent producer uses current direct keys after an earlier consistent snapshot' })

    const clearBootstrap = async () => {
      await k('snapshot_certificate_field_keys').delete()
      await k('snapshot_certificate_index_progress')
        .where({ snapshotTableId: 0 })
        .update({ started: 0, afterFieldName: '', afterCertificateId: 0, complete: 0 })
    }
    await clearBootstrap()
    transaction = await writer.transaction()
    await transaction('certificates').where({ certificateId: 1 }).update({ userId: 1 })
    await transaction('certificates').where({ certificateId: 1 }).update({ userId: 2 })
    const restoring = settle(bootstrap(k))
    try {
      const locks = await until(() => waiting(kId))
      events.push({ case: 'bootstrap waits for current committed parent ownership', locks })
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    success(await restoring)
    await verify()

    await k('certificates').where({ certificateId: 1 }).update({ userId: 1 })
    await clearBootstrap()
    let reached = false,
      release
    const gate = new Promise(resolve => {
      release = resolve
    })
    const prototype = Object.getPrototypeOf(k.client),
      original = prototype.query,
      hadOwn = Object.hasOwn(prototype, 'query')
    prototype.query = async function (connection, query) {
      const sql = typeof query === 'string' ? query : query.sql
      if (!reached && sql.startsWith('update `snapshot_certificate_index_progress`')) {
        reached = true
        await gate
      }
      return await original.call(this, connection, query)
    }
    const pending = settle(bootstrap(k))
    let change
    try {
      await until(async () => reached)
      finished = false
      change = settle(
        writer('certificates')
          .where({ certificateId: 1 })
          .update({ userId: 2 })
          .then(() => {
            finished = true
          })
      )
      const locks = await until(() => waiting(writerId))
      assert.equal(finished, false)
      assert.ok(locks.some(row => row.tableName === 'certificates'))
      events.push({ case: 'bootstrap retains parent protection through key and cursor commit', locks })
    } finally {
      release()
      if (hadOwn) prototype.query = original
      else delete prototype.query
      success(await pending)
      if (change !== undefined) success(await change)
    }
    await verify()
    return { isolation, events }
  } finally {
    if (transaction && !transaction.isCompleted()) await transaction.rollback()
    await observer.destroy()
    await writer.destroy()
    await k.destroy()
    await admin.raw('DROP DATABASE ??', [database])
  }
}
async function qualifyMysqlCertificateIndexLocks(control, connection) {
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.database, 'ts569_snapshot')
  const results = []
  for (const isolation of ['read committed', 'repeatable read'])
    results.push(await fixture(control, connection, isolation))
  return results
}
module.exports = { qualifyMysqlCertificateIndexLocks }
