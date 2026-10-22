import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const mobile = new URL('../packages/wallet/wallet-toolbox/mobile/', import.meta.url)
const bridge = new URL('sdk-peer-exports.ts', mobile)
const sdk = JSON.parse(
  readFileSync(new URL('../packages/sdk/package.json', import.meta.url), 'utf8')
)
const require = createRequire(new URL('package.json', mobile))
const ts = require('typescript')

test('SDK forwarding contains only original root types and public barrel re-exports', () => {
  const parsed = ts.createSourceFile(
    fileURLToPath(bridge),
    readFileSync(bridge, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  let rootTypes = 0,
    runtimeExports = 0
  for (const statement of parsed.statements) {
    assert.ok(ts.isExportDeclaration(statement), 'no copied SDK implementation or wrapper')
    const specifier = statement.moduleSpecifier?.text
    assert.equal(typeof specifier, 'string')
    if (statement.isTypeOnly) {
      assert.equal(specifier, '@bsv/sdk')
      assert.equal(statement.exportClause, undefined)
      rootTypes++
      continue
    }
    assert.ok(
      ts.isNamedExports(statement.exportClause),
      'forward original namespace objects by name'
    )
    const subpath = specifier === '@bsv/sdk' ? '.' : './' + specifier.slice('@bsv/sdk/'.length)
    assert.ok(Object.hasOwn(sdk.exports, subpath), `declared SDK export ${specifier}`)
    if (subpath !== '.')
      assert.ok(sdk.exports[subpath].import.default.endsWith('/index.js'), 'public category barrel')
    runtimeExports += statement.exportClause.elements.length
  }
  assert.equal(rootTypes, 1)
  assert.ok(runtimeExports > 0)
})

test('SDK declared curve setup stays eager and all implementations stay external', async () => {
  for (const marked of sdk.sideEffects) {
    assert.match(
      marked,
      /^\.\/dist\/(?:(?:esm|cjs)\/src\/(?:umd\.js|primitives\/entries\/(?:BasePoint|JacobianPoint)\.js)|umd\/bundle\.js)$/
    )
  }
  const config = (await import(new URL('tsdown.config.ts', mobile))).default
  const handler = config.plugins.find(plugin => plugin.name === 'external-sdk-category-imports')
    .resolveId.handler
  const filename = fileURLToPath(bridge)
  assert.equal(handler('@bsv/sdk', '/wallet/example.ts'), filename)
  assert.equal(handler('@bsv/sdk', '/wallet/example.d.ts'), undefined)
  assert.equal(handler('@bsv/sdk/primitives/Hash', '/wallet/example.ts'), undefined)
  assert.deepEqual(handler('@bsv/sdk/primitives', filename), {
    id: '@bsv/sdk/primitives',
    external: true,
    moduleSideEffects: true
  })
  assert.deepEqual(handler('@bsv/sdk/wallet', filename), {
    id: '@bsv/sdk/wallet',
    external: true,
    moduleSideEffects: false
  })
  assert.deepEqual(handler('@bsv/sdk', filename), {
    id: '@bsv/sdk',
    external: true,
    moduleSideEffects: false
  })
  assert.deepEqual(config.deps.onlyBundle, ['@noble/hashes'])
})
