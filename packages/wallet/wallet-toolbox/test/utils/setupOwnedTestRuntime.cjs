'use strict'
const path = require('node:path')
const cleanup = require('./cleanupTestDatabases.js')
const { prepareOwnedWorkerAssets } = require('./ownedBrc39WorkerAssets.cjs')
module.exports = async () => {
  await cleanup()
  await prepareOwnedWorkerAssets(path.resolve(__dirname, '../..'))
}
