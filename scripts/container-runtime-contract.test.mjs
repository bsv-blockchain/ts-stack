import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contractNames } from './container-runtime-contract.mjs'

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
