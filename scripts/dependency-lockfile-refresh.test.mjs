import assert from 'node:assert/strict'
import test from 'node:test'

import {
  firstPartyResolutionChanges,
  nonLockfileChanges,
  npmRefreshNames
} from './dependency-lockfile-refresh.mjs'

const lock = {
  packages: {
    '': { name: '@bsv/fixture-server' },
    'node_modules/express': { version: '5.1.0' },
    'node_modules/@bsv/sdk': { version: '2.1.0' },
    'node_modules/@bsv/wallet-toolbox': { version: '2.4.0' },
    'node_modules/@bsv/wallet-toolbox/node_modules/@bsv/sdk': { version: '2.0.9' },
    'node_modules/@bsv/wallet-toolbox/node_modules/ip-address': { version: '10.3.1' },
    'node_modules/ip-address': { version: '10.7.3' },
    'node_modules/@scope/linked': { resolved: '../linked', link: true }
  }
}

test('npm refresh names every registry package except first-party and linked ones', () => {
  assert.deepEqual(npmRefreshNames(lock), ['express', 'ip-address'])
  assert.deepEqual(npmRefreshNames({}), [])
})

test('first-party resolution changes are detected at every depth', () => {
  assert.deepEqual(firstPartyResolutionChanges(lock, structuredClone(lock)), [])

  const refreshed = structuredClone(lock)
  refreshed.packages['node_modules/ip-address'].version = '10.8.0'
  refreshed.packages['node_modules/@bsv/wallet-toolbox/node_modules/@bsv/sdk'].version = '2.1.0'
  delete refreshed.packages['node_modules/@bsv/wallet-toolbox']
  assert.deepEqual(firstPartyResolutionChanges(lock, refreshed), [
    'node_modules/@bsv/wallet-toolbox 2.4.0 -> absent',
    'node_modules/@bsv/wallet-toolbox/node_modules/@bsv/sdk 2.0.9 -> 2.1.0'
  ])
})

test('only lockfiles may change during a refresh', () => {
  assert.deepEqual(
    nonLockfileChanges([
      'pnpm-lock.yaml',
      'infra/wab/package-lock.json',
      'infra/wab/package.json',
      'packages/sdk/package.json',
      'pnpm-workspace.yaml'
    ]),
    ['infra/wab/package.json', 'packages/sdk/package.json', 'pnpm-workspace.yaml']
  )
})
