const { rm } = require('node:fs/promises')
const path = require('node:path')

const testDatabaseDirectory = path.resolve(__dirname, '../data/tmp')

/**
 * Jest lifecycle hook that keeps generated SQLite fixtures bounded.
 *
 * The directory is deliberately fixed relative to this module. Never accept
 * a caller-provided deletion target here.
 */
module.exports = async function cleanupTestDatabases () {
  await rm(testDatabaseDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  })
}
