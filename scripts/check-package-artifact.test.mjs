import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  concretePublicEntrypoints,
  nodeModeDefaultImports,
  typeProblemsForModes,
  validateManifestArtifactContract,
  validatePackedFiles,
  validateReferencedSourceMaps,
  workspaceRuntimeClosure
} from './check-package-artifact.mjs'

const manifest = {
  name: '@bsv/example',
  version: '1.2.3',
  sideEffects: false,
  exports: './dist/index.js'
}

test('packed artifact policy accepts a minimal compiled package', () => {
  assert.deepEqual(
    validatePackedFiles(
      {
        name: manifest.name,
        version: manifest.version,
        files: [
          { path: 'LICENSE.txt' },
          { path: 'README.md' },
          { path: 'dist/index.js' },
          { path: 'dist/index.d.ts' },
          { path: 'package.json' }
        ]
      },
      manifest
    ),
    []
  )
})

test('packed artifact policy rejects source, tests, caches, locks, and identity drift', () => {
  const errors = validatePackedFiles(
    {
      name: '@bsv/wrong',
      version: '9.9.9',
      files: [
        { path: 'LICENSE.txt' },
        { path: 'LICENSE.txt' },
        { path: 'src/index.ts' },
        { path: 'dist/index.test.js' },
        { path: 'dist/tsconfig.tsbuildinfo' },
        { path: 'package-lock.json' },
        { path: 'package.json' }
      ]
    },
    manifest
  )

  assert.ok(errors.some(error => error.includes('exactly one root LICENSE.txt')))
  assert.ok(errors.some(error => error.includes('root README')))
  assert.ok(errors.some(error => error.includes('uncompiled TypeScript')))
  assert.ok(errors.some(error => error.includes('test artifact')))
  assert.ok(errors.some(error => error.includes('compiler cache')))
  assert.ok(errors.some(error => error.includes('package-manager lockfile')))
  assert.ok(errors.some(error => error.includes('tarball name')))
  assert.ok(errors.some(error => error.includes('tarball version')))
})

test('packed artifact policy permits only explicitly allowlisted scaffold source', () => {
  const files = [
    { path: 'LICENSE.txt' },
    { path: 'README.md' },
    { path: 'dist/index.js' },
    { path: 'dist/index.d.ts' },
    { path: 'package.json' },
    { path: 'template/server.ts' },
    { path: 'src/index.ts' }
  ]
  const errors = validatePackedFiles(
    { name: manifest.name, version: manifest.version, files },
    manifest,
    ['template']
  )

  assert.equal(
    errors.some(error => error.includes('template/server.ts')),
    false
  )
  assert.equal(
    errors.some(error => error.includes('src/index.ts')),
    true
  )
  assert.throws(
    () =>
      validatePackedFiles({ name: manifest.name, version: manifest.version, files }, manifest, [
        '../'
      ]),
    /invalid allowed source prefix/
  )
})

test('strict type policy ignores only the unsupported CommonJS mode for ESM-only packages', () => {
  const problems = [
    { kind: 'NoResolution', entrypoint: '.', resolutionKind: 'node16-cjs' },
    { kind: 'CJSResolvesToESM', entrypoint: '.', resolutionKind: 'node16-cjs' },
    { kind: 'NoResolution', entrypoint: '.', resolutionKind: 'node16-esm' },
    { kind: 'UntypedResolution', entrypoint: '.', resolutionKind: 'bundler' }
  ]

  assert.deepEqual(typeProblemsForModes(problems, ['esm']), problems.slice(2))
  assert.deepEqual(typeProblemsForModes(problems, ['esm', 'cjs']), problems)
  assert.deepEqual(typeProblemsForModes(problems, ['esm', 'cjs'], ['.']), problems.slice(2))
  assert.deepEqual(typeProblemsForModes(problems, ['esm', 'cjs'], [], ['.']), [])
})

test('artifact contract expands every concrete wildcard export and validates target payloads', () => {
  const exportedManifest = {
    ...manifest,
    exports: {
      '.': { import: './dist/index.js', types: './dist/index.d.ts' },
      './*.ts': {
        import: './dist/src/*.js',
        types: './dist/src/*.d.ts'
      }
    },
    peerDependencies: { react: '>=18' },
    peerDependenciesMeta: { react: { optional: true } }
  }
  const files = [
    'dist/index.d.ts',
    'dist/index.js',
    'dist/src/type-only.d.ts',
    'dist/src/alpha.d.ts',
    'dist/src/alpha.js',
    'dist/src/nested/beta.d.ts',
    'dist/src/nested/beta.js'
  ]

  assert.deepEqual(validateManifestArtifactContract(exportedManifest, files), [])
  assert.deepEqual(concretePublicEntrypoints(exportedManifest, files), [
    '.',
    './alpha.ts',
    './nested/beta.ts'
  ])
  assert.ok(
    validateManifestArtifactContract(
      {
        ...exportedManifest,
        exports: { '.': './dist/missing.js' },
        peerDependenciesMeta: { missing: { optional: true } }
      },
      files
    ).some(error => error.includes('does not match a packed file'))
  )
})

test('artifact contract permits a bin-only package without runtime exports', () => {
  assert.deepEqual(
    validateManifestArtifactContract(
      {
        name: '@bsv/cli',
        version: '1.0.0',
        sideEffects: false,
        bin: { cli: './dist/index.mjs' }
      },
      ['dist/index.mjs']
    ),
    []
  )
})

test('artifact contract validates each referenced packed source map', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-source-map-'))
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(path.join(directory, 'dist'))
  await fs.writeFile(
    path.join(directory, 'dist/index.js'),
    'export const value = 1\n//# sourceMappingURL=index.js.map\n'
  )
  await fs.writeFile(
    path.join(directory, 'dist/index.js.map'),
    JSON.stringify({ version: 3, sources: ['../src/index.ts'], mappings: '' })
  )
  const sourceMapManifest = {
    ...manifest,
    exports: { '.': './dist/index.js' }
  }
  assert.deepEqual(
    await validateReferencedSourceMaps(directory, sourceMapManifest, [
      'dist/index.js',
      'dist/index.js.map'
    ]),
    []
  )
  assert.ok(
    (await validateReferencedSourceMaps(directory, sourceMapManifest, ['dist/index.js'])).some(
      error => error.includes('missing packed source map')
    )
  )
})

test('packed consumers use the exact transitive workspace runtime closure', () => {
  const root = {
    name: '@bsv/root',
    dependencies: {
      '@bsv/a': 'workspace:^',
      '@bsv/registry-only': '^1.0.0'
    },
    peerDependencies: {
      '@bsv/external-peer': '^1.0.0'
    }
  }
  const manifests = new Map([
    [
      '@bsv/a',
      {
        name: '@bsv/a',
        optionalDependencies: { '@bsv/b': 'workspace:*' }
      }
    ],
    [
      '@bsv/b',
      {
        name: '@bsv/b',
        dependencies: { '@bsv/a': 'workspace:^' },
        peerDependencies: { '@bsv/peer': '^1.0.0' }
      }
    ],
    [
      '@bsv/peer',
      {
        name: '@bsv/peer'
      }
    ]
  ])

  assert.deepEqual(workspaceRuntimeClosure(root, manifests), ['@bsv/a', '@bsv/b', '@bsv/peer'])
  assert.throws(
    () =>
      workspaceRuntimeClosure(
        { name: '@bsv/root', dependencies: { '@bsv/missing': 'workspace:^' } },
        manifests
      ),
    /unknown workspace dependency @bsv\/missing/
  )
})

test('CommonJS interop policy finds Node-mode default bindings that are read', () => {
  const rolldown = [
    'const require_runtime = require("../_virtual/_rolldown/runtime.cjs");',
    'let _bsv_sdk_script_LockingScript = require("@bsv/sdk/script/LockingScript");',
    '_bsv_sdk_script_LockingScript = require_runtime.__toESM(_bsv_sdk_script_LockingScript, 1);',
    'let _bsv_sdk_primitives_Hash = require("@bsv/sdk/primitives/Hash");',
    '_bsv_sdk_primitives_Hash = require_runtime.__toESM(_bsv_sdk_primitives_Hash, 1);',
    'const script = new _bsv_sdk_script_LockingScript.default();',
    'const digest = _bsv_sdk_primitives_Hash.sha256([]);'
  ].join('\n')
  assert.deepEqual(nodeModeDefaultImports(rolldown), ['@bsv/sdk/script/LockingScript'])

  const esbuild = [
    "var import_OP = __toESM(require('@bsv/sdk/script/OP'), 1);",
    'var import_express = __toESM(require("express"));',
    'const code = import_OP.default.OP_RETURN;',
    'const app = (0, import_express.default)();'
  ].join('\n')
  assert.deepEqual(nodeModeDefaultImports(esbuild), ['@bsv/sdk/script/OP'])
})

test('CommonJS interop policy ignores Babel-style interop and named-only reads', () => {
  const source = [
    'let _bsv_sdk_script = require("@bsv/sdk/script");',
    'let _bsv_sdk_primitives_PublicKey = require("@bsv/sdk/primitives/PublicKey");',
    '_bsv_sdk_primitives_PublicKey = require_runtime.__toESM(_bsv_sdk_primitives_PublicKey);',
    'let _bsv_sdk_primitives_Hash = require("@bsv/sdk/primitives/Hash");',
    '_bsv_sdk_primitives_Hash = require_runtime.__toESM(_bsv_sdk_primitives_Hash, 1);',
    'new _bsv_sdk_script.LockingScript();',
    '_bsv_sdk_primitives_PublicKey.default.fromString("");',
    '_bsv_sdk_primitives_Hash.sha256([]);',
    '_bsv_sdk_primitives_Hash.defaultish;'
  ].join('\n')
  assert.deepEqual(nodeModeDefaultImports(source), [])
})
