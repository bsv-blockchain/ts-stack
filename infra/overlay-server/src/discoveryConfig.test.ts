import assert from 'node:assert/strict'
import test from 'node:test'
import { readDiscoveryRuntimeConfiguration } from './discoveryConfig.js'

test('ordinary nodes retain suppressed discovery-service advertisements and default resolvers', () => {
  for (const environment of [{}, { DISCOVERY_ROOT: 'false' }]) {
    assert.deepEqual(
      readDiscoveryRuntimeConfiguration(environment, 'ttn', 'http://localhost:8080'),
      {
        suppressDefaultSyncAdvertisements: true
      }
    )
  }
})

test('explicit roots bootstrap both advertisement protocols at their own HTTPS origin', () => {
  for (const [network, preset] of [
    ['main', 'mainnet'],
    ['test', 'testnet'],
    ['ttn', 'teratestnet']
  ] as const) {
    assert.deepEqual(
      readDiscoveryRuntimeConfiguration(
        { DISCOVERY_ROOT: 'true' },
        network,
        'https://root.example/'
      ),
      {
        suppressDefaultSyncAdvertisements: false,
        lookupResolverConfig: {
          networkPreset: preset,
          hostOverrides: { ls_ship: ['https://root.example'] },
          slapTrackers: ['https://root.example']
        }
      }
    )
  }
})

test('root mode rejects ambiguous flags and credential-bearing or non-origin bootstrap URLs', () => {
  assert.throws(
    () =>
      readDiscoveryRuntimeConfiguration({ DISCOVERY_ROOT: 'treu' }, 'ttn', 'https://root.example'),
    /DISCOVERY_ROOT must be one of/
  )
  for (const url of [
    'not-a-url',
    'http://root.example',
    'https://user:password@root.example',
    'https://root.example/lookup',
    'https://root.example?token=value',
    'https://root.example#fragment'
  ]) {
    assert.throws(
      () => readDiscoveryRuntimeConfiguration({ DISCOVERY_ROOT: 'true' }, 'ttn', url),
      /credential-free HTTPS hosting origin/
    )
  }
})
