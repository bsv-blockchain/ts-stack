import assert from 'node:assert/strict'
import test from 'node:test'

import { changedLinesFromDiff, evaluatePatchCoverage, mergeLcov } from './patch-coverage.mjs'

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

test('patch coverage ignores non-instrumented configuration, benchmarks, and type-only schemas', () => {
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
diff --git a/packages/sdk/scripts/run-benchmarks.js b/packages/sdk/scripts/run-benchmarks.js
+++ b/packages/sdk/scripts/run-benchmarks.js
@@ -0,0 +1,12 @@
diff --git a/packages/wallet/wallet-toolbox/src/storage/schema/StorageIdbSchema.ts b/packages/wallet/wallet-toolbox/src/storage/schema/StorageIdbSchema.ts
+++ b/packages/wallet/wallet-toolbox/src/storage/schema/StorageIdbSchema.ts
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
diff --git a/packages/helpers/create-bsv-app/src/index.ts b/packages/helpers/create-bsv-app/src/index.ts
+++ b/packages/helpers/create-bsv-app/src/index.ts
@@ -0,0 +1,40 @@
`)

  // The last one is the point of this test. `create-bsv-app`'s entry point is a
  // CLI that reads `process.argv` and branches on it, so excluding barrels by
  // the name `index.ts` rather than by path would drop real code out of this
  // gate without anybody noticing.
  assert.deepEqual([...changed.keys()], ['packages/helpers/create-bsv-app/src/index.ts'])
})
