const { open, StorageKnex, StorageProvider } = require('./snapshotJournalMysqlConnection.cjs')
const phase = process.argv[2]
const identity = '02' + '11'.repeat(32)
const request = { ceiling: '9223372036854775807', receiptPolicy: { receiptLimit: 128, receiptLifetimeMs: 600000 } }
const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: open() })
const injection = require('./snapshotJournalCaptureProcessLoss.cjs')(phase)
process.once('disconnect', () => process.exit(1))
const deadline = setTimeout(() => process.exit(2), 20000)
deadline.unref()
storage
  .openSnapshotJournalSource(identity, request)
  .then(async view => {
    if (phase === 'opened') injection.park()
    await view.close()
    throw new Error('Did not reach capture boundary: ' + JSON.stringify({ phase, pools: injection.pools }))
  })
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await storage.destroy()
  })
