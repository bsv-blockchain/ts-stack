import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const wallet = path.resolve(import.meta.dirname, '../packages/wallet/wallet-toolbox')
const {
  sqlite
} = require('../packages/wallet/wallet-toolbox/src/storage/portable/native/source_recipe.cjs')

test('native delivery resolves the actual locked UDL amalgamation matching the qualified recipe', () => {
  const manifest = require.resolve('better-sqlite3/package.json', { paths: [wallet] })
  const source = readFileSync(path.join(path.dirname(manifest), 'deps', 'sqlite3', 'sqlite3.c'))
  assert.equal(source.length, sqlite.bytes)
  assert.equal(createHash('sha256').update(source).digest('hex'), sqlite.sha256)
  assert.match(source.toString('utf8', 0, 4096), /#define SQLITE_UDL_CAPABLE_PARSER 1/)
  const provision = readFileSync(
    new URL('./provision-wallet-native-tests.sh', import.meta.url),
    'utf8'
  )
  assert.match(provision, /require\.resolve\("better-sqlite3\/package\.json"/)
  assert.match(
    provision,
    /path\.join\(path\.dirname\(manifest\), "deps", "sqlite3", "sqlite3\.c"\)/
  )
  assert.match(provision, /TS_STACK_NATIVE_SQLITE_SOURCE/)
  assert.match(provision, /stat --format=%s/)
  assert.match(provision, /sha256sum --check --status/)
  assert.ok(!provision.includes('sqlite-amalgamation-3530400.zip'))
})
