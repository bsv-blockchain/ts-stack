require('./snapshotJournalMaintenanceFixture.cjs')('WAL').catch(error => {
  console.error(error)
  process.exitCode = 1
})
