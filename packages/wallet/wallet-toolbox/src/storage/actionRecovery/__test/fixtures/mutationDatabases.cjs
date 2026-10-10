const { rm } = require('node:fs/promises')
const { _tu } = require('../../../../../test/utils/TestUtilsWalletStorage')

// These mutation suites use the existing randomly named SQLite fixture factory.
// Track only this Jest environment's own allocations, instead of sweeping the
// shared scratch directory while another mutation runner has open databases.
const files = new Set()
const create = _tu.newTmpFile.bind(_tu)
_tu.newTmpFile = async (...args) => {
  const filename = await create(...args)
  files.add(filename)
  return filename
}

afterAll(async () => {
  // Test afterEach/finally hooks have already closed wallets and child processes.
  // SQLite sidecars share the exact owned filename; no directory-wide deletion.
  await Promise.all(Array.from(files, filename =>
    Promise.all(['', '-wal', '-shm', '-journal'].map(suffix => rm(filename + suffix, { force: true })))
  ))
  files.clear()
})
