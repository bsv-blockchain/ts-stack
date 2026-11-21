// Owned synthetic process fixture; invoked only by snapshotArchiveGuardCrash.cjs.
const { knex } = require('knex')
const { readGuardedSnapshotArchive } = require('../../out/src/storage/snapshot/archive/SnapshotArchiveGuard.js')
if (typeof process.send !== 'function') throw new Error('Owned fixture parent required')
process.once('message', ({ config, owner }) => {
  const control = knex(config)
  const source = knex(config)
  void readGuardedSnapshotArchive(control, source, owner, async trx => {
    const row = await trx('snapshot_guard_fixture').first()
    process.send({ ready: true, value: row.value })
    await new Promise(resolve => process.once('message', resolve))
  })
    .catch(error => {
      process.send({ ready: false, error: error.name })
      process.exitCode = 1
    })
    .finally(async () => {
      await source.destroy()
      await control.destroy()
      process.disconnect()
    })
})
