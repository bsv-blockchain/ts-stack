const { existsSync } = require('node:fs')

// Fixture executables use known installation paths rather than searching PATH.
const executable = [
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  '/usr/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker'
].find(candidate => existsSync(candidate))

if (executable === undefined) throw new Error('Install Docker Desktop at a supported local installation path')
module.exports = executable
