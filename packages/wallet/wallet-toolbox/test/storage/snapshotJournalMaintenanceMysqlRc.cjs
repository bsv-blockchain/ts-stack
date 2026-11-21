require('./snapshotJournalMaintenanceFixture.cjs')('READ COMMITTED').catch(error => {
  console.error(error)
  process.exitCode = 1
})
