import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { renderServiceOperations, ROOT } from './service-operations.mjs'

test('service operations registry renders all seven public services', async () => {
  const registry = JSON.parse(
    await readFile(join(ROOT, 'governance/service-operations.json'), 'utf8')
  )
  const rendered = renderServiceOperations(registry)
  assert.equal(registry.services.length, 7)
  assert.equal(registry.applicationWorkloads.length, 3)
  assert.equal(registry.manifestRoots.length, 3)
  assert.ok(registry.services.every(service => service.publicProtocol === true))
  assert.match(rendered, /Public services retain wildcard,\ncredential-free CORS by default/)
  for (const service of registry.services) assert.match(rendered, new RegExp(service.name))
})
