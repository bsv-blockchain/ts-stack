import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = 'packages/wallet/wallet-toolbox/package.json'
const packageDirectory = path.dirname(path.join(root, manifest))
const wallet = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8'))
const policy = JSON.parse(
  fs.readFileSync(path.join(root, 'governance/test-quality/policy.json'), 'utf8')
)
const prefix = 'node ../../../scripts/check-wallet-property-command.mjs && jest '
assert.ok(wallet.scripts['test:property'].startsWith(prefix))
const tokens = wallet.scripts['test:property'].slice(prefix.length).split(' ')
const declared = tokens.filter(value => value.startsWith('src/') && value.endsWith('.test.ts'))
const registered = policy.propertyTesting.suites
  .filter(suite => suite.manifest === manifest)
  .map(suite => path.relative(packageDirectory, path.join(root, suite.path)))
assert.deepEqual([...declared].sort(), [...registered].sort())

// Resolve the same installed parser as the wallet's Jest command, without discovering tests.
const walletRequire = createRequire(path.join(packageDirectory, 'package.json'))
const jestRequire = createRequire(walletRequire.resolve('jest/package.json'))
const { buildArgv } = jestRequire('jest-cli')
const actual = await buildArgv(tokens)
assert.deepEqual(actual._, declared)
assert.deepEqual(actual.testPathIgnorePatterns, ['man.test.ts'])
assert.equal(actual.runInBand, true)
assert.equal(actual.runTestsByPath, true)
assert.equal(actual.watchman, false)
console.log(`Wallet property command selects all ${declared.length} registered suites.`)
