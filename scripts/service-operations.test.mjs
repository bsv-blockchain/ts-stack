import assert from 'node:assert/strict'
import test from 'node:test'
import { validateServiceOperations } from './service-operations.mjs'

test('released service operations and checked-in application workloads satisfy policy', async () => {
  const { errors, registry } = await validateServiceOperations()
  assert.deepEqual(errors, [])
  assert.equal(registry.services.length, 7)
  assert.equal(registry.applicationWorkloads.length, 3)
  assert.equal(registry.manifestRoots.length, 3)
  assert.ok(registry.services.every(service => service.publicProtocol === true))
})
