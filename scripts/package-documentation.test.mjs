import assert from 'node:assert/strict'
import test from 'node:test'
import { loadPackageDocumentation, renderPackageDocumentation } from './package-documentation.mjs'

test('package API and migration ledger covers every public package', async () => {
  const model = await loadPackageDocumentation()
  assert.deepEqual(model.errors, [])
  assert.equal(model.packages.length, 30)
  assert.equal(model.packages.filter(pkg => pkg.releaseType !== 'none').length, 21)
  assert.ok(model.packages.every(pkg => pkg.docsPath?.startsWith('docs/packages/')))

  const rendered = renderPackageDocumentation(model)
  assert.match(rendered, /records source candidates without\npublishing them/)
  for (const pkg of model.packages) {
    assert.match(rendered, new RegExp(pkg.name.replaceAll('/', String.raw`\/`)))
  }
})
