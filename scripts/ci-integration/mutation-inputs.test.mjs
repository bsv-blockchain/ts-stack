import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyMutationScope, dependencyEvidence } from '../ci-mutation-scope.mjs'
import { targets, policy, snapshot } from './fixtures/dependency-snapshots.mjs'

const classify = (files, dependency, legacyRequired = []) =>
  classifyMutationScope({ targets, policy, changedFiles: files, dependency, legacyRequired })

test('undeclared cross-package static imports close relative, workspace, export and require edges', () => {
  for (const source of [
    "import value from '../../producer/src/helper.js'",
    "export * from 'producer'",
    "const x = require('producer/internal')",
    "import x = require('producer')",
    "const x = import('producer')"
  ]) {
    const dependency = dependencyEvidence([
      snapshot({
        source: {
          'packages/consumer/src/index.ts': source,
          'packages/producer/src/helper.ts': 'export default 1'
        }
      })
    ])
    assert.deepEqual(classify(['packages/producer/src/helper.ts'], dependency).required, [
      'producer',
      'consumer'
    ])
  }
})

test('explicitly imported documentation remains a runtime input rather than a docs-only exemption', () => {
  const dependency = dependencyEvidence([
    snapshot({
      source: {
        'packages/consumer/src/index.ts': "import text from '../../producer/README.md'",
        'packages/producer/README.md': 'runtime fixture'
      }
    })
  ])
  assert.deepEqual(classify(['packages/producer/README.md'], dependency).required, [
    'producer',
    'consumer'
  ])
})

test('computed imports, unresolved aliases and runtime filesystem input fail closed for their dependents', () => {
  for (const source of [
    'const x = import(name)',
    "import value from '#alias'",
    "import value from '../../missing.json'",
    'fs.readFileSync(file)'
  ]) {
    const dependency = dependencyEvidence([
      snapshot({
        manifests: { consumer: { name: 'consumer', dependencies: { isolated: 'workspace:^' } } },
        source: { 'packages/isolated/src/index.ts': source }
      })
    ])
    const result = classify(['packages/producer/src/input.ts'], dependency)
    assert.deepEqual(result.required, ['producer', 'consumer', 'isolated'])
    assert.deepEqual(result.deferred, [])
  }
})

test('the actual reviewed air-gap loader selects the same corpus in checkout and nested sandbox locations', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { createRequire } = await import('node:module')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const ts = createRequire(new URL('../../packages/sdk/package.json', import.meta.url))(
    'typescript'
  )
  const source = fs.readFileSync(
    path.join(root, 'packages/helpers/air-gap/tests/helpers.ts'),
    'utf8'
  )
  const constants = fs.readFileSync(
    path.join(root, 'packages/helpers/air-gap/src/constants.ts'),
    'utf8'
  )
  const fixture = fs.readFileSync(
    path.join(root, 'conformance/vectors/transport/air-gap-optical.json'),
    'utf8'
  )
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'airgap-input-proof-'))
  try {
    const corpus = path.join(temporary, 'conformance/vectors/transport/air-gap-optical.json')
    fs.mkdirSync(path.dirname(corpus), { recursive: true })
    fs.writeFileSync(corpus, fixture)
    const expected = JSON.parse(fixture).vectors
    for (const prefix of [
      'packages/helpers/air-gap',
      '.stryker-tmp/sandbox-test/packages/helpers/air-gap'
    ]) {
      const directory = path.join(temporary, prefix)
      fs.mkdirSync(path.join(directory, 'tests'), { recursive: true })
      fs.mkdirSync(path.join(directory, 'src'), { recursive: true })
      const compile = content =>
        ts.transpileModule(content, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText
      fs.writeFileSync(path.join(directory, 'src/constants.js'), compile(constants))
      const helper = path.join(directory, 'tests/helpers.cjs')
      fs.writeFileSync(helper, compile(source))
      const module = await import(pathToFileURL(helper))
      assert.deepEqual(module.loadConformanceVectors(), expected)
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
