import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  changedLinesFromDiff,
  evaluatePatchCoverage,
  hasRuntimeChange,
  isStaticMarkdownModule,
  omitStaticMarkdownModules,
  omitTypeOnlyChanges,
  mergeLcov,
  runtimeComparisonAvailable
} from './patch-coverage.mjs'

test('patch coverage intersects changed production lines with merged LCOV line and branch data', () => {
  const changed =
    changedLinesFromDiff(`diff --git a/packages/sdk/src/example.ts b/packages/sdk/src/example.ts
+++ b/packages/sdk/src/example.ts
@@ -1,0 +2,3 @@
`)
  const coverage = mergeLcov([
    `SF:packages/sdk/src/example.ts
DA:2,1
DA:3,1
DA:4,0
BRDA:3,0,0,1
BRDA:3,0,1,0
end_of_record
`,
    `SF:packages/sdk/src/example.ts
DA:4,1
BRDA:3,0,1,1
end_of_record
`
  ])

  assert.deepEqual(evaluatePatchCoverage(changed, coverage), {
    covered: 5,
    total: 5,
    percent: 100,
    misses: [],
    missingFiles: []
  })
})

test('patch coverage ignores tests and reports uncovered production branches', () => {
  const changed =
    changedLinesFromDiff(`diff --git a/packages/sdk/src/example.ts b/packages/sdk/src/example.ts
+++ b/packages/sdk/src/example.ts
@@ -3 +3 @@
diff --git a/packages/sdk/src/example.test.ts b/packages/sdk/src/example.test.ts
+++ b/packages/sdk/src/example.test.ts
@@ -1,0 +1,20 @@
diff --git a/packages/sdk/src/__tests/fixtures/slow-worker.cjs b/packages/sdk/src/__tests/fixtures/slow-worker.cjs
+++ b/packages/sdk/src/__tests/fixtures/slow-worker.cjs
@@ -0,0 +1,20 @@
diff --git a/packages/sdk/src/__tests__/fixtures/legacy-slow-worker.cjs b/packages/sdk/src/__tests__/fixtures/legacy-slow-worker.cjs
+++ b/packages/sdk/src/__tests__/fixtures/legacy-slow-worker.cjs
@@ -0,0 +1,20 @@
`)
  const coverage = mergeLcov([
    `SF:packages/sdk/src/example.ts
DA:3,1
BRDA:3,0,0,1
BRDA:3,0,1,0
end_of_record
`
  ])
  const result = evaluatePatchCoverage(changed, coverage)

  assert.equal(changed.size, 1)
  assert.equal(result.covered, 2)
  assert.equal(result.total, 3)
  assert.ok(Math.abs(result.percent - 200 / 3) < Number.EPSILON * 100)
  assert.deepEqual(result.misses, ['packages/sdk/src/example.ts:3 (branch 0:1)'])
  assert.deepEqual(result.missingFiles, [])
})

test('patch coverage fails closed when a changed production file is absent from LCOV', () => {
  const changed =
    changedLinesFromDiff(`diff --git a/packages/sdk/src/missing.ts b/packages/sdk/src/missing.ts
+++ b/packages/sdk/src/missing.ts
@@ -0,0 +1,2 @@
`)

  assert.deepEqual(evaluatePatchCoverage(changed, new Map()), {
    covered: 0,
    total: 0,
    percent: 100,
    misses: [],
    missingFiles: ['packages/sdk/src/missing.ts']
  })
})

test('patch coverage ignores non-instrumented configuration, benchmarks, and type-only declarations', () => {
  const changed =
    changedLinesFromDiff(`diff --git a/packages/helpers/example/jest.config.cjs b/packages/helpers/example/jest.config.cjs
+++ b/packages/helpers/example/jest.config.cjs
@@ -0,0 +1,24 @@
diff --git a/packages/helpers/example/vitest.config.ts b/packages/helpers/example/vitest.config.ts
+++ b/packages/helpers/example/vitest.config.ts
@@ -0,0 +1,12 @@
diff --git a/packages/sdk/benchmarks/example.js b/packages/sdk/benchmarks/example.js
+++ b/packages/sdk/benchmarks/example.js
@@ -0,0 +1,12 @@
diff --git a/packages/verifast/bench/crypto-benchmark.ts b/packages/verifast/bench/crypto-benchmark.ts
+++ b/packages/verifast/bench/crypto-benchmark.ts
@@ -0,0 +1,12 @@
diff --git a/packages/sdk/scripts/run-benchmarks.js b/packages/sdk/scripts/run-benchmarks.js
+++ b/packages/sdk/scripts/run-benchmarks.js
@@ -0,0 +1,12 @@
diff --git a/packages/content/lch/scripts/regenerate-brc170-vectors.mjs b/packages/content/lch/scripts/regenerate-brc170-vectors.mjs
+++ b/packages/content/lch/scripts/regenerate-brc170-vectors.mjs
@@ -0,0 +1,220 @@
diff --git a/packages/wallet/wallet-toolbox/src/storage/schema/StorageIdbSchema.ts b/packages/wallet/wallet-toolbox/src/storage/schema/StorageIdbSchema.ts
+++ b/packages/wallet/wallet-toolbox/src/storage/schema/StorageIdbSchema.ts
@@ -0,0 +1,12 @@
diff --git a/packages/wallet/wallet-toolbox/src/sdk/WalletStorage.interfaces.ts b/packages/wallet/wallet-toolbox/src/sdk/WalletStorage.interfaces.ts
+++ b/packages/wallet/wallet-toolbox/src/sdk/WalletStorage.interfaces.ts
@@ -0,0 +1,12 @@
diff --git a/packages/wallet/wallet-toolbox/src/SetupWallet.ts b/packages/wallet/wallet-toolbox/src/SetupWallet.ts
+++ b/packages/wallet/wallet-toolbox/src/SetupWallet.ts
@@ -0,0 +1,12 @@
diff --git a/packages/wallet/wallet-toolbox/src/storage/index.mobile.ts b/packages/wallet/wallet-toolbox/src/storage/index.mobile.ts
+++ b/packages/wallet/wallet-toolbox/src/storage/index.mobile.ts
@@ -0,0 +1,12 @@
diff --git a/packages/helpers/simple/src/core/types.ts b/packages/helpers/simple/src/core/types.ts
+++ b/packages/helpers/simple/src/core/types.ts
@@ -0,0 +1,12 @@
diff --git a/packages/wallet/btms/src/types.ts b/packages/wallet/btms/src/types.ts
+++ b/packages/wallet/btms/src/types.ts
@@ -0,0 +1,12 @@
diff --git a/packages/wallet/ecpm-permission-module/src/types.ts b/packages/wallet/ecpm-permission-module/src/types.ts
+++ b/packages/wallet/ecpm-permission-module/src/types.ts
@@ -0,0 +1,12 @@
diff --git a/packages/network/chirp/src/index.ts b/packages/network/chirp/src/index.ts
+++ b/packages/network/chirp/src/index.ts
@@ -0,0 +1,12 @@
diff --git a/packages/network/chirp/src/types.ts b/packages/network/chirp/src/types.ts
+++ b/packages/network/chirp/src/types.ts
@@ -0,0 +1,12 @@
diff --git a/packages/content/lch/src/index.ts b/packages/content/lch/src/index.ts
+++ b/packages/content/lch/src/index.ts
@@ -0,0 +1,22 @@
diff --git a/packages/content/lch/src/types.ts b/packages/content/lch/src/types.ts
+++ b/packages/content/lch/src/types.ts
@@ -0,0 +1,140 @@
diff --git a/packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Api/BulkFileDataCacheApi.ts b/packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Api/BulkFileDataCacheApi.ts
+++ b/packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Api/BulkFileDataCacheApi.ts
@@ -0,0 +1,12 @@
diff --git a/packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Api/ChaintracksFetchApi.ts b/packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Api/ChaintracksFetchApi.ts
+++ b/packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Api/ChaintracksFetchApi.ts
@@ -0,0 +1,12 @@
diff --git a/packages/wallet/wallet-toolbox/src/services/chaintracker/index.mobile.ts b/packages/wallet/wallet-toolbox/src/services/chaintracker/index.mobile.ts
+++ b/packages/wallet/wallet-toolbox/src/services/chaintracker/index.mobile.ts
@@ -0,0 +1,12 @@
diff --git a/packages/helpers/example/src/index.ts b/packages/helpers/example/src/index.ts
+++ b/packages/helpers/example/src/index.ts
@@ -0,0 +1 @@
`)

  assert.deepEqual([...changed.keys()], ['packages/helpers/example/src/index.ts'])
})

test('patch coverage ignores documentation modules and named barrels, but not every index', () => {
  const changed =
    changedLinesFromDiff(`diff --git a/packages/overlays/topics/src/uoradpp/UoraDppTopicDocs.md.ts b/packages/overlays/topics/src/uoradpp/UoraDppTopicDocs.md.ts
+++ b/packages/overlays/topics/src/uoradpp/UoraDppTopicDocs.md.ts
@@ -0,0 +1,24 @@
diff --git a/packages/overlays/overlay-express/src/generalGuide.md.ts b/packages/overlays/overlay-express/src/generalGuide.md.ts
+++ b/packages/overlays/overlay-express/src/generalGuide.md.ts
@@ -0,0 +1,57 @@
diff --git a/packages/overlays/topics/src/index.ts b/packages/overlays/topics/src/index.ts
+++ b/packages/overlays/topics/src/index.ts
@@ -0,0 +1,8 @@
diff --git a/packages/overlays/topics/src/uoradpp/types.ts b/packages/overlays/topics/src/uoradpp/types.ts
+++ b/packages/overlays/topics/src/uoradpp/types.ts
@@ -0,0 +1,58 @@
diff --git a/packages/helpers/example/src/executable.md.ts b/packages/helpers/example/src/executable.md.ts
+++ b/packages/helpers/example/src/executable.md.ts
@@ -0,0 +1,2 @@
diff --git a/packages/helpers/create-bsv-app/src/index.ts b/packages/helpers/create-bsv-app/src/index.ts
+++ b/packages/helpers/create-bsv-app/src/index.ts
@@ -0,0 +1,40 @@
`)

  omitStaticMarkdownModules(changed, file => {
    if (file.endsWith('UoraDppTopicDocs.md.ts')) {
      return '/** Static documentation. */\nexport default `Topic documentation`\n'
    }
    if (file.endsWith('generalGuide.md.ts')) return 'export default `General guide`\n'
    return 'export default `${runExecutableCode()}`\n'
  })

  // The last two are the point of this test. A new `*.md.ts` module can contain
  // executable code, and `create-bsv-app`'s entry point is a CLI that reads
  // `process.argv` and branches on it. Broad name-based exemptions would drop
  // real code out of this gate without anybody noticing.
  assert.deepEqual(
    [...changed.keys()],
    [
      'packages/helpers/example/src/executable.md.ts',
      'packages/helpers/create-bsv-app/src/index.ts'
    ]
  )
})

test('static Markdown detection fails closed on imports, interpolation, and extra statements', () => {
  assert.equal(
    isStaticMarkdownModule('/** Documentation. */\nexport default `Static \\`Markdown\\``\n'),
    true
  )
  assert.equal(isStaticMarkdownModule('import "./side-effect.js"\nexport default `Docs`'), false)
  assert.equal(isStaticMarkdownModule('export default `Value: ${runtimeValue}`'), false)
  assert.equal(isStaticMarkdownModule('export default `Docs`\nstartService()'), false)
  assert.equal(isStaticMarkdownModule('export const docs = `Docs`'), false)
})

test('patch coverage compares emitted code for type-only edits without hiding runtime changes', () => {
  // The pre-install repository health job has no esbuild installed, so the
  // comparison fails closed there and these type-only edits report as
  // runtime changes (true) instead of being recognized as type-only (false).
  const typeOnlyEdit = !runtimeComparisonAvailable()
  assert.equal(
    hasRuntimeChange(
      "export { Relay } from './Relay.js'; export type { First } from './types.js'",
      "export { Relay } from './Relay.js'; export type { First, Second } from './types.js'"
    ),
    typeOnlyEdit
  )
  assert.equal(
    hasRuntimeChange(
      'interface Options { first: string }; export {}',
      'interface Options { first: string; second?: number }; export {}'
    ),
    typeOnlyEdit
  )
  assert.equal(
    hasRuntimeChange(
      "import { Value } from './types.js'; interface Options { value: Value }; export {}",
      "import type { Value } from './types.js'; interface Options { value: Value }; export {}"
    ),
    typeOnlyEdit
  )
  assert.equal(
    hasRuntimeChange(
      '/** Before. */ interface Options { first: string }; export {}',
      '/** After. */ interface Options { first: string }; export {}'
    ),
    typeOnlyEdit
  )
  assert.equal(hasRuntimeChange("export const value = 'a b'", "export const value = 'ab'"), true)
  assert.equal(
    hasRuntimeChange('export const value = `a\n\nb`', 'export const value = `a\nb`'),
    true
  )
  assert.equal(
    hasRuntimeChange("export { First } from './value.js'", "export { Second } from './value.js'"),
    true
  )
  assert.equal(hasRuntimeChange('export {}', 'startService(); export {}'), true)
  assert.equal(hasRuntimeChange('enum State { Ready }', 'enum State { Ready = 2 }'), true)
  assert.equal(hasRuntimeChange('export {}', 'invalid TypeScript {'), true)
})

test('the coverage aggregation job installs its locked compiler before classifying source changes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const section = workflow.split('  coverage-upload:\n')[1].split(/\n  [a-z][a-z-]*:/)[0]
  const bootstrap = section.indexOf('name: Install the locked patch-coverage compiler')
  const gate = section.indexOf('name: Enforce the repository-owned 90% patch-coverage gate')
  assert.ok(bootstrap >= 0 && gate > bootstrap)
  const beforeGate = section.slice(0, gate)
  assert.match(beforeGate, /uses: pnpm\/action-setup@/)
  assert.match(beforeGate, /uses: actions\/setup-node@/)
  assert.match(
    beforeGate,
    /pnpm install --frozen-lockfile --ignore-scripts --filter @bsv\/ts-stack/
  )
  assert.match(beforeGate, /pnpm rebuild esbuild/)
  assert.match(beforeGate, /if \(!runtimeComparisonAvailable\(\)\) throw new Error/)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(typeof manifest.devDependencies.esbuild, 'string')
})

test('new erased declarations need no LCOV while runtime, unsupported syntax and unreadable Git sources stay governed', t => {
  const repository = mkdtempSync(join(tmpdir(), 'patch-coverage-source-'))
  t.after(() => rmSync(repository, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('/usr/bin/git', args, {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  const write = (name, source) => writeFileSync(join(repository, 'packages', name), source)
  git('init', '--initial-branch=main')
  mkdirSync(join(repository, 'packages'))
  write('existing.ts', 'export interface Options { first: string }')
  git('add', 'packages')
  const commit = () =>
    git(
      '-c',
      'user.name=Coverage fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Synthetic source'
    )
  commit()
  const base = git('rev-parse', 'HEAD')
  write('existing.ts', 'export interface Options { first: string; second?: number }')
  write(
    'new-types.ts',
    "import type * as values from './values'; export type Value = values.Value; export interface Options { value: Value }"
  )
  write('new-runtime.ts', 'export const value = 1')
  write('new-enum.ts', 'export enum State { Ready }')
  write('new-effect.ts', 'import "./start.js"; export interface Options {}')
  write('new-invalid.ts', 'invalid TypeScript {')
  git('add', 'packages')
  commit()
  const names = [
    'existing.ts',
    'new-types.ts',
    'new-runtime.ts',
    'new-enum.ts',
    'new-effect.ts',
    'new-invalid.ts'
  ]
  const changed = new Map(names.map(name => ['packages/' + name, new Set([1])]))
  omitTypeOnlyChanges(changed, base, repository)
  const expected = runtimeComparisonAvailable() ? names.slice(2) : names
  assert.deepEqual(
    [...changed.keys()],
    expected.map(name => 'packages/' + name)
  )
  assert.throws(() =>
    omitTypeOnlyChanges(new Map([['packages/missing.ts', new Set([1])]]), base, repository)
  )
  assert.throws(() =>
    omitTypeOnlyChanges(
      new Map([['packages/new-types.ts', new Set([1])]]),
      'missing-base',
      repository
    )
  )
})
