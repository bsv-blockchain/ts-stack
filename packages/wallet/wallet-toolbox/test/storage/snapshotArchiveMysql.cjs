const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { knex } = require('knex')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const executable = require('./snapshotArchiveDocker.cjs')
const container = process.env.TS_STACK_SNAPSHOT_CONTAINER
const expectedId = process.env.TS_STACK_SNAPSHOT_CONTAINER_ID
const secret = process.env.TS_STACK_SNAPSHOT_MYSQL_SECRET
if (!container || !expectedId || !secret) throw new Error('Use the bounded local fixture launcher')
const actual = JSON.parse(
  execFileSync(executable, ['--context', 'desktop-linux', 'inspect', container], { encoding: 'utf8' })
)[0]
assert.equal(actual.Id, expectedId)
assert.equal(actual.Config.Labels['network-ops.fixture'], 'ts-stack-544-durable')
assert.equal(actual.Config.Image, 'mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d')
const port = Number(
  execFileSync(executable, ['--context', 'desktop-linux', 'port', expectedId, '3306/tcp'], { encoding: 'utf8' })
    .trim()
    .split(':')
    .at(-1)
)
const connection = {
  host: '127.0.0.1',
  port,
  user: 'root',
  password: secret,
  database: 'ts569_snapshot',
  timezone: 'Z'
}

const {
  KnexSnapshotArchiveStore,
  snapshotArchiveTables,
  snapshotArchiveLimits
} = require('../../out/src/storage/snapshot/archive/KnexSnapshotArchiveStore.js')
const { addSnapshotArchiveTables } = require('../../out/src/storage/schema/snapshotArchiveMigration.js')
const { StorageKnex } = require('../../out/src/storage/StorageKnex.js')
const { StorageProvider } = require('../../out/src/storage/StorageProvider.js')
const { captureKnexSnapshotArchive } = require('../../out/src/storage/snapshot/archive/captureKnexSnapshotArchive.js')
const { decodeSyncTransfer } = require('../../out/src/storage/remoting/SyncTransfer.js')
const open = () => knex({ client: 'mysql2', connection, pool: { min: 1, max: 1 } })
const database = open(),
  replica = open(),
  third = open()
const identity = '02' + '11'.repeat(32),
  other = '03' + '22'.repeat(32)
const date = new Date('2026-01-01T00:00:00.000Z')
const binding = {
  version: 1,
  snapshotId: 'a'.repeat(64),
  sourceSchema: 'synthetic-v1',
  sourceStorage: {
    created_at: date,
    updated_at: date,
    storageIdentityKey: 'source',
    storageName: 'source',
    chain: 'test',
    dbtype: 'MySQL',
    maxOutputScript: 1024
  },
  user: { created_at: date, updated_at: date, userId: 7, identityKey: identity, activeStorage: 'source' }
}

async function captureFixture() {
  const writer = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: open() })
  const reader = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: open() })
  const originalAppend = KnexSnapshotArchiveStore.prototype.append
  try {
    await writer.migrate('native capture source', 'native-source')
    await writer.makeAvailable()
    await reader.makeAvailable()
    const { user } = await writer.findOrInsertUser(identity)
    const { user: foreign } = await writer.findOrInsertUser(other)
    const labels = Array.from({ length: 140 }, (_, index) => ({
      userId: user.userId,
      label: `original-${index}`,
      isDeleted: index % 7 === 0,
      created_at: date,
      updated_at: date
    }))
    await writer.knex('tx_labels').insert(labels)
    await writer.findOrInsertTxLabel(foreign.userId, 'foreign label')
    const tx = {
      created_at: date,
      updated_at: date,
      status: 'completed',
      isOutgoing: false,
      satoshis: 1,
      description: 'synthetic fixture'
    }
    const proof = await writer.insertProvenTx({
      created_at: date,
      updated_at: date,
      provenTxId: 0,
      txid: 'a'.repeat(64),
      height: 1,
      index: 0,
      merklePath: [4, 5, 255],
      rawTx: [1, 2, 255],
      blockHash: 'b'.repeat(64),
      merkleRoot: 'c'.repeat(64)
    })
    await writer.insertTransaction({
      ...tx,
      transactionId: 0,
      userId: user.userId,
      provenTxId: proof,
      txid: 'a'.repeat(64),
      reference: 'owned'
    })
    const foreignTransaction = await writer.insertTransaction({
      ...tx,
      transactionId: 0,
      userId: foreign.userId,
      reference: 'foreign'
    })
    await writer.knex('users').where({ userId: user.userId }).update({ activeStorage: 'historical selection' })
    let changedDuringCapture = false
    KnexSnapshotArchiveStore.prototype.append = async function (owner, page) {
      await originalAppend.call(this, owner, page)
      if (page.sequence === 0) {
        await writer
          .knex('tx_labels')
          .where({ userId: user.userId, label: 'original-0' })
          .update({ label: 'replacement' })
        await writer.knex('users').where({ userId: user.userId }).update({ activeStorage: 'replacement selection' })
        changedDuringCapture = true
      }
    }
    const manifest = await captureKnexSnapshotArchive(reader, writer.knex, identity, 'test')
    KnexSnapshotArchiveStore.prototype.append = originalAppend
    assert.equal(changedDuringCapture, true)
    assert.equal(manifest.pages, 14)
    assert.equal(manifest.binding.sourceStorage.storageIdentityKey, 'native-source')
    assert.equal(manifest.binding.user.activeStorage, 'historical selection')
    assert.equal(manifest.binding.sourceSchema, '2026-09-30-002 add snapshot archive staging')
    const store = new KnexSnapshotArchiveStore(writer.knex)
    const first = decodeSyncTransfer((await store.read(identity, manifest.archiveId, 8)).bytes)
    const second = decodeSyncTransfer((await store.read(identity, manifest.archiveId, 9)).bytes)
    assert.equal(first.table, 'txLabels')
    assert.equal(first.rows.length, 128)
    assert.equal(second.rows.length, 12)
    assert.deepEqual(
      [...first.rows, ...second.rows].map(row => row.label),
      labels.map(row => row.label)
    )
    assert.equal(first.rows[0].created_at, date.toISOString())
    assert.equal(first.rows[0].isDeleted, true)
    const proofPage = decodeSyncTransfer((await store.read(identity, manifest.archiveId, 0)).bytes)
    assert.deepEqual(proofPage.rows[0].rawTx, new Uint8Array([1, 2, 255]))
    await store.close(identity, manifest.archiveId)
    await writer.insertCommission({
      created_at: date,
      updated_at: date,
      commissionId: 0,
      userId: user.userId,
      transactionId: foreignTransaction,
      satoshis: 1,
      keyOffset: 'synthetic',
      isRedeemed: false,
      lockingScript: [1]
    })
    await assert.rejects(captureKnexSnapshotArchive(reader, writer.knex, identity, 'test'), /relation/)
    assert.equal((await writer.knex('snapshot_archive_capacity').first()).archives, 0)
    return {
      tables: 13,
      pages: manifest.pages,
      labels: 140,
      pinnedConcurrentWrites: true,
      originalPrimary: true,
      originalSchema: true,
      packedBinary: true,
      crossProfileClosureRejected: true
    }
  } finally {
    KnexSnapshotArchiveStore.prototype.append = originalAppend
    await reader.destroy()
    await writer.destroy()
  }
}
async function main() {
  try {
    const version = (await database.raw('SELECT VERSION() AS version'))[0][0].version
    await addSnapshotArchiveTables(database)
    const store = new KnexSnapshotArchiveStore(database),
      peer = new KnexSnapshotArchiveStore(replica),
      final = new KnexSnapshotArchiveStore(third)
    const writer = await store.begin(binding)
    await assert.rejects(peer.inspect(identity, writer.archiveId), /unavailable/)
    await assert.rejects(peer.begin(binding), /occupied/)
    const payload = new Uint8Array(snapshotArchiveLimits.pageBytes).fill(42)
    await runInSeries(snapshotArchiveTables.entries(), ([sequence, table]) =>
      store.append(writer, { sequence, table, rows: 1, done: true, bytes: payload })
    )
    const manifest = await store.seal(writer)
    assert.deepEqual(manifest.binding, binding)
    assert.equal(manifest.pages, 13)
    assert.equal(manifest.rows, 13)
    assert.deepEqual(await peer.inspect(identity, writer.archiveId), manifest)
    assert.deepEqual((await peer.read(identity, writer.archiveId, 0)).bytes, payload)
    await assert.rejects(peer.read(other, writer.archiveId, 0), /unavailable/)
    await addSnapshotArchiveTables(database)
    assert.equal(Number((await database('snapshot_archive_capacity').first()).archives), 1)
    await Promise.all([peer.close(identity, writer.archiveId), final.close(identity, writer.archiveId)])
    assert.equal(Number((await database('snapshot_archive_pages').count({ count: '*' }))[0].count), 0)
    assert.equal(Number((await database('snapshot_archive_capacity').first()).reservedBytes), 0)
    // SQL failure after page insertion must roll back both the page and cursor.
    const failing = await store.begin(binding)
    await database.raw(
      "CREATE TRIGGER synthetic_archive_failure BEFORE UPDATE ON snapshot_archives FOR EACH ROW BEGIN IF NEW.nextSequence > OLD.nextSequence THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic append failure'; END IF; END"
    )
    await assert.rejects(
      store.append(failing, { sequence: 0, table: 'provenTxs', rows: 0, done: true, bytes: new Uint8Array([91, 93]) }),
      /synthetic append failure/
    )
    await database.raw('DROP TRIGGER synthetic_archive_failure')
    assert.equal(Number((await database('snapshot_archive_pages').count({ count: '*' }))[0].count), 0)
    assert.equal((await database('snapshot_archives').where({ archiveId: failing.archiveId }).first()).nextSequence, 0)
    await database('snapshot_archives').where({ archiveId: failing.archiveId }).update({ expiresAt: 0 })
    await peer.reap()
    assert.equal(Number((await database('snapshot_archive_capacity').first()).archives), 0)
    // Independent servers racing for one profile can admit exactly one capture.
    const contested = await Promise.allSettled([store.begin(binding), peer.begin(binding), final.begin(binding)])
    assert.equal(contested.filter(x => x.status === 'fulfilled').length, 1)
    const admitted = contested.find(x => x.status === 'fulfilled').value
    await peer.close(identity, admitted.archiveId)
    await database.schema.dropTable('snapshot_archive_pages')
    await addSnapshotArchiveTables(database)
    assert.equal(await database.schema.hasTable('snapshot_archive_pages'), true)
    assert.equal(Number((await database('snapshot_archive_capacity').first()).archives), 0)
    const capture = await captureFixture()
    console.log(
      JSON.stringify({
        version,
        source: 'built checkout; internal staging only',
        crossReplicaImmutableReads: true,
        exactMaximumPageBytes: payload.length,
        profileOwnership: true,
        concurrentCloseExactlyOnce: true,
        appendRollback: true,
        expiredPartialUnreadable: true,
        profileReservationRace: true,
        idempotentPartialDdl: true,
        capture
      })
    )
  } finally {
    await third.destroy()
    await replica.destroy()
    await database.destroy()
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
