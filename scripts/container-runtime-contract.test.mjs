import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { contractEnvironment, contractNames } from './container-runtime-contract.mjs'

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

test('every container contract probes additive CORS request headers', () => {
  const source = readFileSync(new URL('./container-runtime-contract.mjs', import.meta.url), 'utf8')
  assert.match(source, /assertForwardCompatiblePreflight/)
  assert.match(source, /X-Correlation-ID/)
  assert.match(source, /X-TS-Stack-Contract-Probe/)
  assert.match(source, /cors-request-header-forward-compatibility/)
})
