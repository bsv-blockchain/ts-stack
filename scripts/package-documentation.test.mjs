import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadPackageDocumentation, renderPackageDocumentation } from './package-documentation.mjs'

test('package API and migration ledger covers every public package', async () => {
  const model = await loadPackageDocumentation()
  assert.deepEqual(model.errors, [])
  assert.equal(model.packages.length, 34)
  for (const pkg of model.packages) {
    assert.equal(pkg.releaseType === 'none', pkg.publishedVersion === pkg.sourceVersion)
  }
  assert.ok(model.packages.every(pkg => pkg.docsPath?.startsWith('docs/packages/')))

  const rendered = renderPackageDocumentation(model)
  assert.match(rendered, /records source candidates without\npublishing them/)
  for (const pkg of model.packages) {
    assert.match(rendered, new RegExp(pkg.name.replaceAll('/', String.raw`\/`)))
  }
})

test('publication reconciliation preserves migration notes and rejects a stale release classification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ts-stack-published-ledger-'))
  const name = '@example/release-ledger'
  const write = async (relative, value) => {
    const file = join(root, relative)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const entry = {
    name,
    publishedVersion: '1.0.0',
    releaseType: 'patch',
    summary: 'Preserves the reviewed runtime correction and its release evidence.',
    migration: 'Consumers retain the documented migration guidance after publication.'
  }
  const notes = { schemaVersion: 1, lastReviewed: '2026-09-23', entries: [entry] }
  try {
    await write('governance/repository-health/projects.json', {
      projects: [{ name, path: 'packages/example', release: 'npm-oidc' }]
    })
    await write('packages/example/package.json', { name, version: '1.0.1' })
    await write('packages/example/README.md', '# Example package\n')
    await write('docs/packages/example.md', `---\ntitle: '${name}'\n---\n`)
    await write('governance/package-release-notes.json', notes)
    const pending = await loadPackageDocumentation(root)
    assert.deepEqual(pending.errors, [])
    assert.equal(pending.packages[0].releaseType, 'patch')

    entry.publishedVersion = '1.0.1'
    await write('governance/package-release-notes.json', notes)
    const stale = await loadPackageDocumentation(root)
    assert.equal(stale.errors.length, 1)
    assert.match(stale.errors[0], /releaseType patch disagrees with 1\.0\.1 -> 1\.0\.1 \(none\)/)

    entry.releaseType = 'none'
    await write('governance/package-release-notes.json', notes)
    const published = await loadPackageDocumentation(root)
    assert.deepEqual(published.errors, [])
    assert.equal(published.packages[0].sourceVersion, '1.0.1')
    const rendered = renderPackageDocumentation(published)
    assert.ok(rendered.includes('| `1.0.1` | `1.0.1` | none |'))
    assert.ok(rendered.includes(entry.summary))
    assert.ok(rendered.includes(entry.migration))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
