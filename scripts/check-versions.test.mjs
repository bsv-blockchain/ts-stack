import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acceptsPeerVersion } from './check-versions.mjs'
import { syncVersions } from './sync-versions.mjs'

const cases = [
  ['same stable version', '^2.9.0', '2.9.0', true],
  ['higher stable minor', '^2.1.6', '2.9.0', true],
  ['higher stable patch', '^2.9.0', '2.9.4', true],
  ['lower patch', '^2.9.4', '2.9.0', false],
  ['next major', '^2.9.0', '3.0.0', false],
  ['zero major same minor', '^0.2.7', '0.2.9', true],
  ['zero major next minor', '^0.2.7', '0.3.0', false],
  ['zero major lower patch', '^0.2.7', '0.2.6', false],
  ['zero minor exact patch', '^0.0.7', '0.0.7', true],
  ['zero minor next patch', '^0.0.7', '0.0.8', false],
  ['union first alternative', '^2.9.0 || ^3.0.0', '2.9.4', true],
  ['union second alternative', '^2.9.0 || ^3.0.0', '3.0.0', true],
  ['union second minor', '^2.9.0 || ^3.0.0', '3.4.5', true],
  ['union below both', '^2.9.0 || ^3.0.0', '2.8.11', false],
  ['union above both', '^2.9.0 || ^3.0.0', '4.0.0', false],
  ['three complete alternatives', '^0.2.7 || ^2.9.0 || ^3.0.0', '0.2.8', true],
  ['malformed matching single suffix', '^2.9.0garbage', '2.9.0', false],
  ['malformed matching first alternative', '^2.9.0 || garbage', '2.9.0', false],
  ['malformed preceding alternative', 'garbage || ^3.0.0', '3.0.0', false],
  ['empty following alternative', '^2.9.0 || ', '2.9.0', false],
  ['empty preceding alternative', ' || ^3.0.0', '3.0.0', false],
  ['single pipe', '^2.9.0 | ^3.0.0', '3.0.0', false],
  ['triple pipe', '^2.9.0 ||| ^3.0.0', '3.0.0', false],
  ['unspaced separator', '^2.9.0||^3.0.0', '3.0.0', false],
  ['extra separator whitespace', '^2.9.0  || ^3.0.0', '3.0.0', false],
  ['leading whitespace', ' ^3.0.0', '3.0.0', false],
  ['trailing whitespace', '^3.0.0 ', '3.0.0', false],
  ['tilde mixed into union', '^2.9.0 || ~3.0.0', '2.9.0', false],
  ['wildcard', '^3.0.x', '3.0.0', false],
  ['partial caret', '^3.0', '3.0.0', false],
  ['range operators', '>=2.9.0 <4.0.0', '3.0.0', false],
  ['leading zero', '^03.0.0', '3.0.0', false],
  ['workspace prefix', 'workspace:^', '3.0.0', false],
  ['empty range', '', '3.0.0', false],
  ['non-string range', null, '3.0.0', false],
  ['malformed workspace suffix', '^3.0.0', '3.0.0garbage', false],
  ['workspace prerelease', '^3.0.0', '3.0.0-beta.1', false],
  ['range build metadata', '^3.0.0+build', '3.0.0', false],
  ['workspace missing patch', '^3.0.0', '3.0', false],
  ['non-string workspace', '^3.0.0', undefined, false],
  ['unsafe component', '^9007199254740992.0.0', '9007199254740992.0.0', false],
  ['safe component boundary', '^9007199254740991.0.0', '9007199254740991.0.1', true],
  ['oversized version', `^${'1'.repeat(65)}.0.0`, '3.0.0', false],
  ['oversized range', '^3.0.0' + ' || ^3.0.0'.repeat(200), '3.0.0', false]
]

for (const [name, range, current, expected] of cases) {
  test(`peer caret validation: ${name}`, () => {
    assert.equal(acceptsPeerVersion(range, current), expected)
  })
}

function fixture(t, consumer = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ts-stack-peer-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.mock.method(console, 'log', () => {})
  const sdkPath = join(root, 'packages', 'sdk')
  const consumerPath = join(root, 'packages', 'consumer')
  const infraPath = join(root, 'infra', 'service')
  for (const path of [sdkPath, consumerPath, infraPath]) mkdirSync(path, { recursive: true })
  const sdk = { name: '@bsv/sdk', version: '3.0.0' }
  const client = { name: '@bsv/fixture', version: '1.0.0', ...consumer }
  const infra = {
    name: 'fixture-service',
    version: '1.2.3',
    dependencies: { '@bsv/sdk': '^2.9.0' }
  }
  const files = {
    sdk: join(sdkPath, 'package.json'),
    client: join(consumerPath, 'package.json'),
    infra: join(infraPath, 'package.json')
  }
  for (const [name, manifest] of Object.entries({ sdk, client, infra })) {
    writeFileSync(files[name], JSON.stringify(manifest, null, 1) + '\n')
  }
  return {
    root,
    files,
    packageList: [
      { ...sdk, path: sdkPath },
      { name: client.name, version: client.version, path: consumerPath }
    ]
  }
}

test('workspace-only sync preserves accepted caret union bytes and leaves infra alone', t => {
  const { root, files, packageList } = fixture(t, {
    dependencies: { '@bsv/sdk': 'workspace:^' },
    peerDependencies: { '@bsv/sdk': '^2.9.0 || ^3.0.0' }
  })
  const before = Object.fromEntries(
    Object.entries(files).map(([name, path]) => [name, readFileSync(path, 'utf8')])
  )
  syncVersions({ root, packageList, workspaceOnly: true })
  for (const [name, path] of Object.entries(files))
    assert.equal(readFileSync(path, 'utf8'), before[name])
})

test('sync repairs malformed unions and preserves nonpeer workspace-link enforcement', t => {
  const { root, files, packageList } = fixture(t, {
    dependencies: { '@bsv/sdk': '^2.9.0 || ^3.0.0', external: '^1.0.0' },
    devDependencies: { '@bsv/sdk': '^3.0.0' },
    optionalDependencies: { '@bsv/sdk': '^3.0.0' },
    peerDependencies: { '@bsv/sdk': '^3.0.0 || invalid' }
  })
  syncVersions({ root, packageList, workspaceOnly: true })
  const manifest = JSON.parse(readFileSync(files.client, 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal(manifest[field]['@bsv/sdk'], 'workspace:^')
  }
  assert.equal(manifest.peerDependencies['@bsv/sdk'], '^3.0.0')
  assert.equal(manifest.dependencies.external, '^1.0.0')
})

test('standalone infra rewrite and patch bump retain their existing behavior', t => {
  const { root, files, packageList } = fixture(t, {
    peerDependencies: { '@bsv/sdk': '^2.9.0 || ^3.0.0' }
  })
  syncVersions({ root, packageList })
  const manifest = JSON.parse(readFileSync(files.infra, 'utf8'))
  assert.equal(manifest.dependencies['@bsv/sdk'], '^3.0.0')
  assert.equal(manifest.version, '1.2.4')
  const once = readFileSync(files.infra, 'utf8')
  syncVersions({ root, packageList })
  assert.equal(readFileSync(files.infra, 'utf8'), once)
})

test('dry-run keeps workspace and standalone fixture bytes unchanged', t => {
  const { root, files, packageList } = fixture(t, { dependencies: { '@bsv/sdk': '^2.9.0' } })
  const before = Object.fromEntries(
    Object.entries(files).map(([name, path]) => [name, readFileSync(path, 'utf8')])
  )
  syncVersions({ root, packageList, dryRun: true })
  for (const [name, path] of Object.entries(files))
    assert.equal(readFileSync(path, 'utf8'), before[name])
})
