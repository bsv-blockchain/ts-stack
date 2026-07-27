import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CODEGEN_MANIFEST,
  CODEGEN_TYPESCRIPT_SPECIFIER,
  COMPATIBILITY_TYPESCRIPT_SPECIFIER,
  inspectTypeScriptManifest,
  inspectTypeScriptToolchain,
  NATIVE_TYPESCRIPT_SPECIFIER
} from './typescript-toolchain.mjs'

const governedManifest = {
  scripts: { typecheck: 'tsc --noEmit' },
  devDependencies: {
    '@typescript/native': NATIVE_TYPESCRIPT_SPECIFIER,
    typescript: COMPATIBILITY_TYPESCRIPT_SPECIFIER
  }
}

test('all tracked TypeScript projects use the governed side-by-side toolchain', () => {
  const report = inspectTypeScriptToolchain()
  assert.equal(report.governed, 43)
  assert.equal(report.codegen, 1)
  assert.deepEqual(report.findings, [])
})

test('native CLI and compatibility API must be exact development dependencies', () => {
  assert.deepEqual(
    inspectTypeScriptManifest('packages/example/package.json', governedManifest).findings,
    []
  )

  const missingNative = structuredClone(governedManifest)
  delete missingNative.devDependencies['@typescript/native']
  assert.match(
    inspectTypeScriptManifest('packages/example/package.json', missingNative).findings[0],
    /@typescript\/native/
  )

  const runtimeLeak = structuredClone(governedManifest)
  runtimeLeak.dependencies = {
    typescript: runtimeLeak.devDependencies.typescript
  }
  delete runtimeLeak.devDependencies.typescript
  assert.match(
    inspectTypeScriptManifest('packages/example/package.json', runtimeLeak).findings[0],
    /devDependency typescript/
  )
})

test('the reproducible OpenAPI generator retains its independent API compiler', () => {
  assert.deepEqual(
    inspectTypeScriptManifest(CODEGEN_MANIFEST, {
      dependencies: { typescript: CODEGEN_TYPESCRIPT_SPECIFIER }
    }).findings,
    []
  )
  assert.match(
    inspectTypeScriptManifest(CODEGEN_MANIFEST, governedManifest).findings[0],
    /isolated TypeScript 5\.9\.3/
  )
})
