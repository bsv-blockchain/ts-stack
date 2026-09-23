import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCiResults } from './ci-result-gate.mjs'

function evidence(selected = true) {
  const required = [
    'repository-health',
    'scope',
    'prepare',
    'infra-scope',
    'build-and-test',
    'mutation-quality'
  ]
  const lanes = [
    'standard-tests',
    'dependent-tests',
    'browser-packages',
    'wallet-browser-platform',
    'wallet-mobile-platform',
    'coverage-sdk',
    'coverage-did',
    'coverage-wallet',
    'coverage-wallet-monitor',
    'coverage-verifast',
    'coverage-other',
    'coverage-upload',
    'mutation-tests',
    'infra',
    'docs-validate',
    'conformance'
  ]
  const needs = Object.fromEntries(
    [...required, ...lanes].map(name => [
      name,
      { result: required.includes(name) || selected ? 'success' : 'skipped' }
    ])
  )
  needs.prepare.outputs = Object.fromEntries(
    [
      'standard-packages',
      'dependent-test-packages',
      'browser-packages',
      'coverage-other-packages',
      'mutation-targets'
    ].map(key => [key, selected ? '["selected"]' : '[]'])
  )
  Object.assign(
    needs.prepare.outputs,
    Object.fromEntries(
      [
        'wallet_client',
        'wallet_mobile',
        'sdk',
        'did',
        'wallet',
        'verifast',
        'coverage-required'
      ].map(key => [key, String(selected)])
    )
  )
  needs.scope.outputs = { docs: String(selected), conformance: String(selected) }
  needs['infra-scope'].outputs = { 'has-infra': String(selected) }
  needs['sonar-zero-findings'] = { result: 'skipped' }
  needs['dependency-review'] = { result: 'skipped' }
  return needs
}

test('main and full dispatch accept selected successes with PR-only gates skipped', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    assert.deepEqual(validateCiResults(evidence(), event), [])
    assert.deepEqual(validateCiResults(evidence(false), event), [])
  }
})

test('a green aggregate cannot conceal any selected lane missing, cancelled or skipped', () => {
  const baseline = evidence()
  for (const name of Object.keys(baseline).filter(
    name => !['sonar-zero-findings', 'dependency-review'].includes(name)
  )) {
    for (const result of ['skipped', 'cancelled', 'failure', undefined]) {
      const needs = structuredClone(baseline)
      needs[name].result = result
      assert.ok(
        validateCiResults(needs, 'push').some(error => error.startsWith(`${name}:`)),
        `${name}: ${result}`
      )
    }
  }
})

test('missing or malformed scope cannot authorize skips', () => {
  for (const raw of [undefined, '', 'null', '{}', '"false"']) {
    const needs = evidence(false)
    needs.prepare.outputs.sdk = raw
    needs.prepare.outputs['standard-packages'] = raw
    const errors = validateCiResults(needs, 'push')
    assert.ok(errors.some(error => error.includes('prepare.sdk')))
    assert.ok(errors.some(error => error.includes('prepare.standard-packages')))
  }
})

test('PRs require real analysis and dependency review; out-of-scope failures still fail', () => {
  const needs = evidence(false)
  assert.equal(validateCiResults(needs, 'pull_request').length, 2)
  needs['sonar-zero-findings'].result = 'success'
  needs['dependency-review'].result = 'success'
  assert.deepEqual(validateCiResults(needs, 'pull_request'), [])
  needs['coverage-sdk'].result = 'failure'
  assert.match(validateCiResults(needs, 'pull_request').join('\n'), /coverage-sdk/)
})
