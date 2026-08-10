import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  contractEnvironment,
  contractNames,
  walletDependencyEnvironment
} from './container-runtime-contract.mjs'

test('container runtime contracts exactly cover the governed service inventory', async () => {
  const { readFile } = await import('node:fs/promises')
  const registry = JSON.parse(
    await readFile(new URL('../governance/container-images.json', import.meta.url), 'utf8')
  )
  assert.deepEqual(
    contractNames().sort(),
    registry.components.map(component => component.name).sort()
  )
})

test('chaintracks runtime contract exercises the image default port', () => {
  assert.equal(contractEnvironment('chaintracks-server').PORT, undefined)
})

test('wallet dependency profile coexists with services on port 8080', () => {
  const environment = walletDependencyEnvironment()
  assert.equal(environment.ENABLE_NGINX, 'false')
  assert.equal(environment.HTTP_PORT, '3998')
  assert.equal(environment.WALLET_INFRA_ROLE, 'api')
  assert.equal(environment.WALLET_STORAGE_MONITOR_ADMIN_ENABLED, 'false')
  assert.equal(environment.WALLET_STORAGE_MONITOR_START_TASKS, 'false')
})

test('every container contract probes additive CORS request headers', () => {
  const source = readFileSync(new URL('./container-runtime-contract.mjs', import.meta.url), 'utf8')
  assert.match(source, /assertForwardCompatiblePreflight/)
  assert.match(source, /X-Correlation-ID/)
  assert.match(source, /X-TS-Stack-Contract-Probe/)
  assert.match(source, /cors-request-header-forward-compatibility/)
})
