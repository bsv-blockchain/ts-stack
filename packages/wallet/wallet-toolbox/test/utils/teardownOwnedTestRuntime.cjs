'use strict'
const path = require('node:path')
const cleanup = require('./cleanupTestDatabases.js')
const { cleanupOwnedWorkerAssets } = require('./ownedBrc39WorkerAssets.cjs')
module.exports = async () => {
  const results = await Promise.allSettled([cleanupOwnedWorkerAssets(path.resolve(__dirname, '../..')), cleanup()])
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length !== 0) throw new AggregateError(failures, 'Test runtime retains original cleanup')
}
