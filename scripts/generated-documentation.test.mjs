import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

function run(script, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  })
}

test('generated stack facts are current', () => {
  const result = run('scripts/generate-stack-facts.mjs', '--check')
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('conformance metadata and parity matrix are current', () => {
  const result = run('scripts/generate-parity-matrix.mjs', '--check')
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('documentation policy is satisfied', () => {
  const result = run('scripts/documentation-policy.mjs')
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
