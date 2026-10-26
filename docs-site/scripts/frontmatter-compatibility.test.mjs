import assert from 'node:assert/strict'
import test from 'node:test'
import frontmatter from 'remark-mdx-frontmatter'

function value(node) {
  if (node.type === 'Literal') return node.value
  if (node.type === 'Identifier' && node.name === 'undefined') return undefined
  if (node.type === 'ArrayExpression') return node.elements.map(value)
  assert.equal(node.type, 'ObjectExpression')
  return Object.fromEntries(
    node.properties
      .filter(property => property.key.name !== '__proto__')
      .map(property => [property.key.value ?? property.key.name, value(property.value)])
  )
}

function transform(children, options) {
  const tree = { type: 'root', children }
  frontmatter(options)(tree, {
    message(message) {
      throw new Error(message)
    }
  })
  const program = tree.children.find(node => node.type === 'mdxjsEsm').data.estree
  const declaration = program.body[0].declaration.declarations[0]
  return { name: declaration.id.name, value: value(declaration.init) }
}

test('YAML and TOML preserve equivalent metadata exports after the parser migration', () => {
  const expected = { title: 'Security release', ready: true, count: 42, tags: ['node', 'tls'] }
  const yaml = 'title: Security release\nready: true\ncount: 42\ntags: [node, tls]'
  const toml = 'title = "Security release"\nready = true\ncount = 42\ntags = ["node", "tls"]'
  for (const [type, input] of [
    ['yaml', yaml],
    ['toml', toml]
  ]) {
    assert.deepEqual(transform([{ type, value: input }]), {
      name: 'frontmatter',
      value: expected
    })
  }
})

test('named exports, defaults and explicit parser overrides retain their contract', () => {
  assert.deepEqual(transform([], { name: 'metadata', default: { title: 'Default' } }), {
    name: 'metadata',
    value: { title: 'Default' }
  })
  assert.deepEqual(
    transform([{ type: 'custom', value: '{"count":42}' }], {
      name: 'metadata',
      parsers: { custom: JSON.parse }
    }),
    { name: 'metadata', value: { count: 42 } }
  )
})

test('malformed TOML fails compilation rather than exporting partial metadata', () => {
  assert.throws(() => transform([{ type: 'toml', value: 'title = ["unterminated"' }]))
})
