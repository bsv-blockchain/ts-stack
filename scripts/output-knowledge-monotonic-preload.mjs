import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as sqlite from 'node:sqlite'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { createMonotonicTiming } from './output-knowledge-monotonic-timing.mjs'

assert.equal(process.platform, 'linux')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const output = process.env.OUTPUT_KNOWLEDGE_MONOTONIC_FILE
assert.ok(output && path.isAbsolute(output))
const directory = path.dirname(output)
assert.equal(fs.realpathSync(directory), directory)
assert.ok(!fs.existsSync(output))
const timing = createMonotonicTiming()
for (const method of ['prepare', 'exec', 'close'])
  timing.wrap(sqlite.DatabaseSync.prototype, method, 'DatabaseSync.' + method)
for (const method of ['all', 'get', 'run', 'iterate'])
  timing.wrap(sqlite.StatementSync.prototype, method, 'StatementSync.' + method)
for (const method of ['hkdfSync', 'createHash', 'createCipheriv', 'createDecipheriv'])
  timing.wrap(crypto, method, 'crypto.' + method)
for (const method of ['update', 'digest'])
  timing.wrap(crypto.Hash.prototype, method, 'Hash.' + method)
syncBuiltinESMExports()

// The supervising process admits this file only after its original fault, case,
// output, source, deadline and complete physical-drain checks. No operation
// arguments, object identities, keys, secrets or results enter the counters.
process.once('exit', () => {
  const descriptor = fs.openSync(
    output,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  )
  try {
    fs.writeFileSync(descriptor, JSON.stringify(timing.snapshot()))
  } finally {
    fs.closeSync(descriptor)
  }
})
