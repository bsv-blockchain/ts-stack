#!/usr/bin/env node
import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'

export function validateMutationClassification(classification, selected, targets, policy) {
  const errors = []
  const all = []
  const risks = new Map(policy.targets.map(target => [target.id, target.risk]))
  for (const key of ['required', 'deferred', 'outside']) {
    if (
      !Array.isArray(classification?.[key]) ||
      classification[key].some(id => typeof id !== 'string')
    ) {
      errors.push(`mutation classification lacks valid ${key} inventory`)
      continue
    }
    all.push(...classification[key])
  }
  const canonical = Object.keys(targets)
  if (
    all.length !== canonical.length ||
    new Set(all).size !== all.length ||
    all.some(id => !canonical.includes(id))
  )
    errors.push('mutation classification is not a complete disjoint canonical partition')
  if (JSON.stringify(classification?.required) !== JSON.stringify(selected))
    errors.push('selected mutation targets differ from required classification')
  if (classification?.deferred?.some(id => risks.get(id) !== 'high'))
    errors.push('critical or unknown mutation risk cannot defer to final qualification')
  if (classification?.outside?.some(id => risks.get(id) !== 'critical'))
    errors.push('only unaffected critical targets may be outside the current PR scope')
  return errors
}

// A selected lane must succeed even when a PR-only ancestor is skipped on main.
// Missing scope outputs fail closed; they must never turn into an empty selection.
export function validateCiResults(needs, event) {
  const errors = []
  const expectResult = (name, required) => {
    const result = needs[name]?.result
    if (result !== 'success' && (required || result !== 'skipped')) {
      errors.push(
        `${name}: expected ${required ? 'success' : 'success or scoped skip'}, got ${result ?? 'missing'}`
      )
    }
  }
  const output = (job, key, type) => {
    const raw = needs[job]?.outputs?.[key]
    try {
      const value = JSON.parse(raw)
      if (type === 'array' ? !Array.isArray(value) : typeof value !== 'boolean')
        throw new Error('type')
      return type === 'array' ? value.length > 0 : value
    } catch {
      errors.push(`${job}.${key}: missing or invalid ${type} scope`)
      return true
    }
  }
  for (const name of [
    'repository-health',
    'scope',
    'prepare',
    'package-artifacts',
    'infra-scope',
    'build-and-test',
    'mutation-quality'
  ]) {
    expectResult(name, true)
  }
  for (const [name, key, type] of [
    ['standard-tests', 'standard-packages', 'array'],
    ['dependent-tests', 'dependent-test-packages', 'array'],
    ['browser-packages', 'browser-packages', 'array'],
    ['wallet-browser-platform', 'wallet_client', 'boolean'],
    ['wallet-mobile-platform', 'wallet_mobile', 'boolean'],
    ['coverage-sdk', 'sdk', 'boolean'],
    ['coverage-did', 'did', 'boolean'],
    ['coverage-wallet', 'wallet', 'boolean'],
    ['coverage-wallet-monitor', 'wallet', 'boolean'],
    ['coverage-verifast', 'verifast', 'boolean'],
    ['coverage-other', 'coverage-other-packages', 'array'],
    ['coverage-upload', 'coverage-required', 'boolean'],
    ['mutation-tests', 'mutation-targets', 'array']
  ]) {
    expectResult(name, output('prepare', key, type))
  }
  expectResult('infra', output('infra-scope', 'has-infra', 'boolean'))
  expectResult('docs-validate', output('scope', 'docs', 'boolean'))
  expectResult('conformance', output('scope', 'conformance', 'boolean'))
  expectResult('sonar-zero-findings', event === 'pull_request')
  expectResult('dependency-review', event === 'pull_request')
  return errors
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const needs = JSON.parse(process.env.CI_NEEDS ?? '')
    const root = fileURLToPath(new URL('..', import.meta.url))
    const classification = JSON.parse(needs.prepare?.outputs?.['mutation-classification'] ?? '')
    const selected = JSON.parse(needs.prepare?.outputs?.['mutation-targets'] ?? '')
    const policy = JSON.parse(
      fs.readFileSync(path.join(root, 'governance/mutation-testing/policy.json'), 'utf8')
    )
    const errors = [
      ...validateCiResults(needs, process.env.CI_EVENT),
      ...validateMutationClassification(
        classification,
        selected,
        buildMutationTargets(root),
        policy
      )
    ]
    if (errors.length > 0) throw new Error(errors.join('\n'))
    console.log('Every selected CI lane completed successfully; remaining skips match scope.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid CI result evidence')
    process.exitCode = 1
  }
}
