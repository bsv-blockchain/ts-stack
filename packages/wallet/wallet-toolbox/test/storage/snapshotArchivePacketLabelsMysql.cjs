const assert = require('node:assert/strict')

// Called by the original bounded MySQL launcher and the operator's isolated
// PXC qualification. Dependencies are the actual compiled implementation.
module.exports = async function qualifyPacketLabels(database, implementation, labels) {
  const actual = (await database.raw('SELECT DATABASE() AS db,@@sql_mode AS mode'))[0][0]
  assert.ok(actual.db === 'ts569_snapshot' || /^opspr569ttnarchive20261026[a-z0-9]+$/.test(actual.db))
  assert.match(actual.mode, /STRICT_(?:TRANS|ALL)_TABLES/)
  const info = async () =>
    (
      await database.raw(
        "SELECT CHARACTER_MAXIMUM_LENGTH,COLLATION_NAME,CHARACTER_SET_NAME,IS_NULLABLE,COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='snapshot_archive_pages' AND COLUMN_NAME='tableName'"
      )
    )[0][0]
  const before = await info()
  assert.equal(Number(before.CHARACTER_MAXIMUM_LENGTH), 32)
  assert.equal(await implementation.supportsSnapshotArchivePacketLabels(database), false)
  const archiveId = 'e'.repeat(64)
  const row = {
    archiveId,
    sequence: 0,
    tableName: 'transactions',
    rows: 0,
    done: true,
    digest: 'f'.repeat(64),
    payload: Buffer.from([0, 255, 128])
  }
  await database('snapshot_archive_pages').insert(row)
  const original = await database('snapshot_archive_pages').where({ archiveId, sequence: 0 }).first()
  const longest = labels.reduce((a, b) => (a.length > b.length ? a : b))
  assert.ok(longest.length > 32 && longest.length <= 64)
  await assert.rejects(
    database('snapshot_archive_pages').insert({ ...row, sequence: 1, tableName: longest }),
    error => error.code === 'ER_DATA_TOO_LONG'
  )
  await implementation.widenSnapshotArchivePacketLabels(database)
  await implementation.widenSnapshotArchivePacketLabels(database)
  assert.equal(await implementation.supportsSnapshotArchivePacketLabels(database), true)
  assert.deepEqual(await info(), { ...before, CHARACTER_MAXIMUM_LENGTH: 64 })
  assert.deepEqual(await database('snapshot_archive_pages').where({ archiveId, sequence: 0 }).first(), original)
  for (const [index, label] of labels.entries()) {
    await database('snapshot_archive_pages').insert({ ...row, sequence: index + 1, tableName: label })
    assert.equal(
      (
        await database('snapshot_archive_pages')
          .where({ archiveId, sequence: index + 1 })
          .first()
      ).tableName,
      label
    )
  }
  await assert.rejects(implementation.refuseSnapshotArchivePacketLabelDowngrade(), /narrowing could truncate/)
  assert.equal(
    Number((await database('snapshot_archive_pages').where({ archiveId }).count({ n: '*' }))[0].n),
    labels.length + 1
  )
  await database('snapshot_archive_pages').where({ archiveId }).delete()
  return {
    strict32CharacterFailureReproduced: true,
    forwardWidth: 64,
    preservedOriginalBytes: true,
    preservedCharsetCollation: true,
    labelRoundTrips: labels.length,
    longestLabel: longest.length,
    narrowingRefused: true
  }
}
