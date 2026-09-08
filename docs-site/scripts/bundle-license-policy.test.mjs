import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  DOCS_SITE_ROOT,
  checkBundledLicensePolicy,
  renderBundledNotice
} from './bundle-license-policy.mjs'

test('pins every component and license file in the deployed docs bundle', () => {
  const { registry, errors } = checkBundledLicensePolicy()

  assert.deepEqual(errors, [])
  assert.equal(registry.components.length, 55)
  assert.equal(registry.components.filter(component => component.kind === 'vite').length, 53)
  assert.ok(
    registry.components.some(
      component => component.name === 'pagefind' && component.version === '1.5.2'
    )
  )
  assert.ok(
    registry.components.some(
      component => component.name === 'mark.js' && component.version === '8.11.1'
    )
  )

  const notice = renderBundledNotice(registry)
  for (const component of registry.components) {
    assert.match(notice, new RegExp(`## ${component.name.replaceAll('.', '\\.')}`))
  }
})

test('the docs build derives notices before deleting temporary source maps', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS_SITE_ROOT, 'package.json'), 'utf8'))

  assert.match(manifest.scripts.build, /vite build --sourcemap/)
  assert.match(manifest.scripts.build, /pagefind .*bundle-license-policy\.mjs --write-dist/)
})
