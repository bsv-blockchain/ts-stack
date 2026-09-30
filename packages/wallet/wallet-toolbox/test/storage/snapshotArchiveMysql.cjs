const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { knex } = require('knex')
const { runInSeries } = require('../../out/src/utility/runInSeries.js')
const container = process.env.TS_STACK_SNAPSHOT_CONTAINER
const expectedId = process.env.TS_STACK_SNAPSHOT_CONTAINER_ID
if (!container || !expectedId) throw new Error('Use the bounded local fixture launcher')
const actual = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
assert.equal(actual.Id, expectedId)
assert.equal(actual.Config.Labels['network-ops.fixture'], 'ts-stack-544-durable')
assert.equal(actual.Config.Image, 'mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d')
const port = Number(
  execFileSync('docker', ['port', expectedId, '3306/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)
)
const connection = {
  host: '127.0.0.1',
  port,
  user: 'root',
  password: 'synthetic-snapshot-fixture',
  database: 'ts569_snapshot',
  timezone: 'Z'
}

const {
  KnexSnapshotArchiveStore,
  snapshotArchiveTables,
  snapshotArchiveLimits
} = require('../../out/src/storage/snapshot/archive/KnexSnapshotArchiveStore.js')
const { addSnapshotArchiveTables } = require('../../out/src/storage/schema/snapshotArchiveMigration.js')
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
        idempotentPartialDdl: true
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
