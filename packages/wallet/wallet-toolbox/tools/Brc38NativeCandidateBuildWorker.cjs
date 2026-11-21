'use strict'
// Private preparation worker: emits build DATA, never executes a candidate.
const path = require('node:path')
const { buildBrc38NativeCandidate } = require('./Brc38NativeCandidateBuild.cjs')
Promise.resolve()
  .then(async () => {
    const args = process.argv.slice(2)
    if (
      !['linux', 'darwin'].includes(process.platform) ||
      !['arm64', 'x64'].includes(process.arch) ||
      process.version !== 'v24.18.0' ||
      process.versions.modules !== '137' ||
      args.length !== 2 ||
      args.some(value => !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0'))
    )
      throw new Error('Native preparation requires its original controlled supported Unix worker and paths')
    const receipt = await buildBrc38NativeCandidate({ sqliteSource: args[0], outputDirectory: args[1] })
    process.stdout.write(JSON.stringify(receipt) + '\n')
  })
  .catch(cause => {
    process.stderr.write(
      JSON.stringify({
        message: String(cause.message || cause).slice(-4096),
        cause: String(cause.cause?.message || '').slice(-4096),
        originalWorkerShutdownRequired: true
      }) + '\n'
    )
    process.exitCode = 1
  })
