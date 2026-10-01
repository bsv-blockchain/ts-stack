// Invoked only after the existing launcher verifies its disposable MySQL fixture.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { knex } = require('knex')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const { addSnapshotProfileIndexes } = require('../../out/src/storage/schema/snapshotProfileIndexMigration.js')

async function waitFor(check) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Synthetic MySQL lock observation deadline')
}

async function qualifyMysqlProfileIndexLocks(control, connection) {
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.database, 'ts569_snapshot')
  const database = 'ts569_profile_' + randomUUID().replaceAll('-', '')
  await control.raw('CREATE DATABASE ??', [database])
  const open = () => knex({ client: 'mysql2', connection: { ...connection, database }, pool: { min: 1, max: 1 } })
  const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: open() })
  const writer = open()
  const observer = open()
  const k = source.knex
  let transaction
  try {
    await source.migrate('synthetic profile locks', 'synthetic-profile-locks')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32))
    const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await k('tx_labels').insert(
      Array.from({ length: 20 }, (_, index) => ({
        userId: user.userId,
        label: `lock-label-${index}`,
        isDeleted: false,
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01')
      }))
    )
    const reset = async () => {
      await k('snapshot_profile_keys').where('snapshotTableId', 3).delete()
      await k('snapshot_profile_index_progress').where('snapshotTableId', 3).update({ afterRowId: 0, complete: false })
    }
    const verify = async () => {
      const expected = (await k('tx_labels').select('userId', 'txLabelId').orderBy('txLabelId')).map(row => ({
        snapshotUserId: row.userId,
        snapshotRowId: row.txLabelId
      }))
      assert.deepEqual(
        await k('snapshot_profile_keys')
          .where('snapshotTableId', 3)
          .select('snapshotUserId', 'snapshotRowId')
          .orderBy('snapshotRowId'),
        expected
      )
    }
    const waiting = async () => {
      const [rows] = await observer.raw(
        "SELECT COUNT(*) AS pending FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='tx_labels'"
      )
      return Number(rows[0].pending) > 0
    }
    await reset()
    transaction = await writer.transaction()
    await transaction('tx_labels').where('txLabelId', 1).update({ userId: other.userId })
    let finished = false
    const first = addSnapshotProfileIndexes(k).then(
      () => {
        finished = true
        return { ok: true }
      },
      error => ({ ok: false, error })
    )
    try {
      await waitFor(waiting)
      assert.equal(finished, false)
      await transaction.commit()
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    const firstResult = await first
    if (!firstResult.ok) throw firstResult.error
    await verify()

    await reset()
    let reached = false
    let release
    const gate = new Promise(resolve => {
      release = resolve
    })
    const prototype = Object.getPrototypeOf(k.client)
    const original = prototype.query
    const hadOwn = Object.hasOwn(prototype, 'query')
    let intercepted = false
    prototype.query = async function (conn, query) {
      const sql = typeof query === 'string' ? query : query.sql
      if (!intercepted && sql.startsWith('insert ignore into `snapshot_profile_keys`')) {
        intercepted = true
        reached = true
        await gate
      }
      return await original.call(this, conn, query)
    }
    const second = addSnapshotProfileIndexes(k).then(
      () => ({ ok: true }),
      error => ({ ok: false, error })
    )
    let change
    let secondResult
    let changedResult
    try {
      await waitFor(async () => reached)
      let writerDone = false
      change = writer('tx_labels')
        .where('txLabelId', 3)
        .update({ userId: other.userId })
        .then(
          () => {
            writerDone = true
            return { ok: true }
          },
          error => ({ ok: false, error })
        )
      await waitFor(waiting)
      assert.equal(writerDone, false)
    } finally {
      release()
      if (hadOwn) prototype.query = original
      else delete prototype.query
      secondResult = await second
      if (change !== undefined) changedResult = await change
    }
    if (!secondResult.ok) throw secondResult.error
    if (changedResult !== undefined && !changedResult.ok) throw changedResult.error
    await verify()
    return {
      bootstrapWaitsForCommittedOwner: true,
      sourceLocksRetainedThroughKeyAndCursorCommit: true,
      independentWriterMaintainsExactOwnerAfterCommit: true,
      lockEvidence: 'performance_schema.data_lock_waits in the isolated fixture database'
    }
  } finally {
    if (transaction !== undefined && !transaction.isCompleted()) await transaction.rollback()
    await observer.destroy()
    await writer.destroy()
    await source.destroy()
    await control.raw('DROP DATABASE ??', [database])
  }
}
module.exports = { qualifyMysqlProfileIndexLocks }
