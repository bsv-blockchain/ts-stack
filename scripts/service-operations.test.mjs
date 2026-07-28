import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { renderServiceOperations, ROOT, validateServiceOperations } from './service-operations.mjs'

test('service operations registry renders all seven public services', async () => {
  const registry = JSON.parse(
    await readFile(join(ROOT, 'governance/service-operations.json'), 'utf8')
  )
  const rendered = renderServiceOperations(registry)
  assert.equal(registry.services.length, 7)
  assert.equal(registry.applicationWorkloads.length, 3)
  assert.equal(registry.statefulExamples.length, 4)
  assert.equal(registry.manifestRoots.length, 3)
  assert.ok(registry.services.every(service => service.publicProtocol === true))
  assert.equal(registry.policy.publicEdge.defaultCorsMode, 'public-wildcard')
  assert.match(rendered, /Credential-free wildcard CORS is therefore the default/)
  assert.match(rendered, /AuthSocket close API/)
  for (const service of registry.services) assert.match(rendered, new RegExp(service.name))
})

test('service operations registry satisfies its executable contract', async () => {
  const { errors } = await validateServiceOperations()
  assert.deepEqual(errors, [])
})
