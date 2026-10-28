require('./snapshotJournalRetentionMysql.cjs')('REPEATABLE READ').catch(error => {
  console.error(error)
  process.exitCode = 1
})
