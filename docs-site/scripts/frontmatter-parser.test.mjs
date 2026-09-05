import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'

const pluginRequire = createRequire(import.meta.resolve('remark-mdx-frontmatter'))
const toml = pluginRequire('toml')

async function compile(source, options) {
  const plugin = mdx(options)
  return (await plugin.transform.call({}, source, 'fixture.mdx')).code
}

test('patched TOML parser preserves the frontmatter plugin contract', async () => {
  const result = await compile(
    '+++\ntitle = "Overlay recovery"\n[review]\nready = true\n+++\n\n# Test',
    {
      remarkPlugins: [[remarkFrontmatter, ['yaml', 'toml']], remarkMdxFrontmatter]
    }
  )
  assert.match(String(result), /Overlay recovery/)
  assert.match(String(result), /"ready": true/)
  const yaml = await compile('---\ntitle: Overlay recovery\n---\n\n# Test', {
    remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter]
  })
  assert.match(String(yaml), /Overlay recovery/)
})

test('patched TOML isolates prototype paths and rejects excessive nesting', () => {
  const parsed = toml.parse('[__proto__]\npolluted = true')
  assert.equal(Object.getPrototypeOf(parsed), null)
  assert.equal(parsed.__proto__.polluted, true)
  assert.equal(Object.prototype.polluted, undefined)
  assert.throws(() => toml.parse(`value = ${'['.repeat(1000)}0${']'.repeat(1000)}`))
})
