import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { containerBaseContexts } from './ci-container-base-contexts.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const digest = 'sha256:' + 'a'.repeat(64)
const base = () => ({
  schemaVersion: 1,
  platform: 'linux/amd64',
  baseImages: [
    {
      digest,
      discoveryReference: 'node',
      references: ['node', 'public.ecr.aws/docker/library/node']
    }
  ]
})

test('the governed alias and canonical source retain exactly the same digest', () => {
  assert.deepEqual(containerBaseContexts(base()), [
    `public.ecr.aws/docker/library/node@${digest}=docker-image://node@${digest}`
  ])
  const canonicalOnly = base()
  canonicalOnly.baseImages[0].references = ['node']
  assert.deepEqual(containerBaseContexts(canonicalOnly), [])
})

test('every emitted repository context uses only its registered discovery reference and digest', () => {
  const registry = JSON.parse(readFileSync(path.join(root, 'governance/container-images.json')))
  const contexts = containerBaseContexts(registry)
  assert.ok(contexts.length > 0)
  for (const context of contexts) {
    const [alias, source] = context.split('=')
    const entry = registry.baseImages.find(base =>
      base.references.some(reference => alias === `${reference}@${base.digest}`)
    )
    assert.ok(entry)
    assert.equal(source, `docker-image://${entry.discoveryReference}@${entry.digest}`)
  }
})

test('malformed, mutable, unregistered and delimiter-injecting inputs fail closed', () => {
  const changes = [
    value => {
      value.schemaVersion = 2
    },
    value => {
      value.platform = 'linux/arm64'
    },
    value => {
      value.baseImages = []
    },
    value => {
      value.baseImages[0].digest = 'latest'
    },
    value => {
      value.baseImages[0].discoveryReference = 'other'
    },
    value => {
      value.baseImages[0].references.push('node')
    },
    value => {
      value.baseImages[0].references.push('node\nCI_PINNED_BASE_CONTEXTS')
    },
    value => {
      value.baseImages[0].references.push('node=other')
    },
    value => {
      value.baseImages[0].references.push('node@' + digest)
    },
    value => {
      value.baseImages.push(structuredClone(value.baseImages[0]))
    }
  ]
  for (const change of changes) {
    const value = base()
    change(value)
    assert.throws(() => containerBaseContexts(value))
  }
})

test('the CLI emits the same contexts for the shell and a bounded multiline Actions output', () => {
  const script = path.join(root, 'scripts/ci-container-base-contexts.mjs')
  const registry = JSON.parse(readFileSync(path.join(root, 'governance/container-images.json')))
  const expected = containerBaseContexts(registry).join('\n')
  const direct = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(direct.status, 0, direct.stderr)
  assert.equal(direct.stdout, expected + '\n')
  const directory = mkdtempSync(path.join(tmpdir(), 'container-base-contexts-'))
  try {
    const output = path.join(directory, 'output')
    const action = spawnSync(process.execPath, [script, '--github-output'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output }
    })
    assert.equal(action.status, 0, action.stderr)
    assert.equal(action.stdout, '')
    assert.equal(
      readFileSync(output, 'utf8'),
      `contexts<<CI_PINNED_BASE_CONTEXTS\n${expected}\nCI_PINNED_BASE_CONTEXTS\n`
    )
    const invalid = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8' })
    assert.equal(invalid.status, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
