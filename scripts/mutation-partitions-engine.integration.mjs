import assert from 'node:assert/strict'
import test from 'node:test'
import path, { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'
import { canonicalInventory, targetSources } from './mutation-final-qualification.mjs'
import {
  partitionMutationTarget,
  selectedMutationPartition,
  mutationExecutionMatrix
} from './mutation-partitions.mjs'

const semanticTargets = [
  'lch-overlay-covenant-terms',
  'private-purchase-state',
  'private-purchase-coordination',
  'private-purchase-native-clock',
  'revenue-listing-purchase',
  'wallet-recovery-codec',
  'overlay-proposal-admission',
  'private-publication-coordination'
]
const mutantIdentity = mutant =>
  JSON.stringify([
    mutant.fileName,
    mutant.location,
    mutant.mutatorName,
    mutant.replacement,
    mutant.ignored ?? null
  ])

function compare(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

// Yielding each promise waits for its result before starting another read. The
// pinned instrumenter and project normalizer retain serial resource ownership.
async function* serialResults(values, read) {
  for (const value of values) yield read(value)
}

test('semantic execution ranges preserve every actual pinned-engine mutant and all original qualification settings', async () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const expectedCounts = [503, 989, 521, 1428, 173, 264, 336, 1164]
  const inventories = serialResults(semanticTargets.entries(), async ([index, id]) => {
    const original = targets[id],
      sources = targetSources(REPOSITORY_ROOT, original),
      directory = path.join(REPOSITORY_ROOT, original.packageDirectory),
      canonical = await canonicalInventory(directory, sources, original.mutate)
    return { index, id, original, directory, canonical }
  })
  for await (const { index, id, original, directory, canonical } of inventories) {
    const parts = partitionMutationTarget(id, original),
      observed = []
    assert.equal(canonical.length, expectedCounts[index])
    assert.ok(parts.length > 1)
    assert.equal(new Set(parts.map(part => part.id)).size, parts.length)
    const partInventories = serialResults(parts, async part => {
      assert.deepEqual(
        { ...part.target, mutate: original.mutate },
        original,
        `${id}/${part.id} changed an original target setting`
      )
      assert.equal(part.target.runnerOptions, original.runnerOptions)
      assert.equal(part.target.additionalInputs, original.additionalInputs)
      const inventory = await canonicalInventory(
        directory,
        targetSources(REPOSITORY_ROOT, part.target),
        part.target.mutate
      )
      return { part, inventory }
    })
    for await (const { part, inventory } of partInventories) {
      assert.ok(inventory.length > 0, `${id}/${part.id} has no executable inventory`)
      observed.push(...inventory)
    }
    assert.deepEqual(
      observed.map(mutantIdentity).toSorted(compare),
      canonical.map(mutantIdentity).toSorted(compare)
    )
    assert.equal(new Set(observed.map(mutantIdentity)).size, canonical.length)
    assert.equal(selectedMutationPartition(id, original), original)
  }
  assert.equal(Object.keys(targets).length, 141)
  assert.equal(mutationExecutionMatrix(Object.keys(targets), targets).include.length, 246)
})

test('serialized mutation configuration preserves both original overlay module partitions', async () => {
  const packageDirectory = resolve(REPOSITORY_ROOT, 'packages/overlays/overlay-express')
  const requirePackage = createRequire(resolve(packageDirectory, 'package.json'))
  const requireJest = createRequire(requirePackage.resolve('jest'))
  const requireCLI = createRequire(requireJest.resolve('jest-cli'))
  const configuration = requireCLI('jest-config')
  const { config: base } = await configuration.readInitialOptions(
    resolve(packageDirectory, 'jest.config.js'),
    { skipMultipleConfigError: true }
  )
  const environment = resolve(
    REPOSITORY_ROOT,
    'node_modules/@stryker-mutator/jest-runner/dist/src/jest-plugins/jest-environment-generic.cjs'
  )
  const selectedTargets = Object.entries(buildMutationTargets(REPOSITORY_ROOT)).filter(
    ([, target]) => target.packageDirectory === 'packages/overlays/overlay-express'
  )
  const projects = serialResults(selectedTargets, async ([id, target]) => {
    const selected = target.runnerOptions.jest.config
    const serialized = {
      ...base,
      ...selected,
      collectCoverage: false,
      verbose: false,
      notify: false,
      bail: false,
      reporters: [],
      testEnvironment: environment,
      globals: { __strykerGlobalNamespace__: '__stryker__' }
    }
    const { configs } = await configuration.readConfigs(
      {
        $0: 'stryker',
        _: [],
        config: JSON.stringify(serialized),
        runInBand: true,
        silent: true,
        passWithNoTests: true
      },
      [packageDirectory]
    )
    return { id, selected, configs }
  })
  for await (const { id, selected, configs } of projects) {
    assert.equal(configs.length, 2, id)
    for (const project of configs) {
      const original = selected.projects.find(item => item.displayName === project.displayName.name)
      const expanded = values =>
        values.map(value => value.replaceAll('<rootDir>', packageDirectory))
      assert.deepEqual(
        project.testPathIgnorePatterns,
        expanded(original.testPathIgnorePatterns),
        id
      )
      assert.deepEqual(project.testMatch, expanded(original.testMatch), id)
      assert.deepEqual(project.extensionsToTreatAsEsm, original.extensionsToTreatAsEsm, id)
      assert.equal(project.testEnvironment, requirePackage.resolve(environment), id)
      assert.equal(project.globals.__strykerGlobalNamespace__, '__stryker__', id)
    }
  }
})
