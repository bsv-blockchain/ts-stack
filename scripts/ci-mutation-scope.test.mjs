import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { classifyMutationScope, parseArguments } from './ci-mutation-scope.mjs'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { validateMutationClassification } from './ci-result-gate.mjs'

const targets = Object.fromEntries(
  ['producer', 'consumer', 'isolated', 'novel'].map(name => [
    name,
    { packageDirectory: `packages/${name}`, manifest: `packages/${name}/package.json` }
  ])
)
const policy = {
  targets: [
    { id: 'producer', risk: 'critical' },
    { id: 'consumer', risk: 'critical' },
    { id: 'isolated', risk: 'high' },
    { id: 'novel', risk: 'unknown' }
  ]
}

test('ordinary changes select no governed mutation target and keep a complete partition', () => {
  const result = classifyMutationScope({ targets, policy })
  assert.deepEqual(result.required, ['novel'])
  assert.deepEqual(result.deferred, ['isolated'])
  assert.deepEqual(result.outside, ['producer', 'consumer'])
  assert.deepEqual(result.newlyDeferred, [])
  assert.deepEqual(validateMutationClassification(result, result.required, targets, policy), [])
})

test('a full campaign requires every target in canonical registry order', () => {
  const result = classifyMutationScope({ targets, policy, all: true })
  assert.deepEqual(result.required, Object.keys(targets))
  assert.deepEqual(result.deferred, [])
  assert.deepEqual(result.outside, [])
  assert.deepEqual(validateMutationClassification(result, result.required, targets, policy), [])
})

test('compared revisions stay accepted and still select nothing; other flags fail', () => {
  assert.deepEqual(parseArguments([]), { all: false })
  assert.deepEqual(parseArguments(['--base', 'abc', '--head', 'def']), { all: false })
  assert.deepEqual(parseArguments(['--all']), { all: true })
  assert.throws(() => parseArguments(['--affected']), /Use --all/)
  assert.throws(() => parseArguments(['--base']), /Use --all/)
})

test('the repository registry partitions without any workspace install', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const run = flags =>
    JSON.parse(
      execFileSync(process.execPath, ['scripts/ci-mutation-scope.mjs', ...flags], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' }
      })
    )
  const registry = Object.keys(buildMutationTargets(root))
  const ordinary = run(['--base', 'HEAD', '--head', 'HEAD'])
  assert.deepEqual(ordinary.required, [])
  assert.deepEqual([...ordinary.deferred, ...ordinary.outside].sort(), [...registry].sort())
  assert.deepEqual(run(['--all']).required, registry)
})
