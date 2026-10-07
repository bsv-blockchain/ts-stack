import assert from 'node:assert/strict'
import test from 'node:test'
import path, { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'
import { canonicalInventory, targetSources } from './mutation-final-qualification.mjs'
import {
  partitionMutationTarget,
  selectedMutationPartition,
  mutationExecutionMatrix
} from './mutation-partitions.mjs'

const semanticTargets = [
  'wallet-recovery-store',
  'wallet-recovery-plan',
  'lch-overlay-covenant-terms',
  'private-purchase-state',
  'private-purchase-coordination',
  'private-purchase-native-clock',
  'revenue-listing-purchase',
  'wallet-recovery-codec',
  'overlay-proposal-admission',
  'private-publication-coordination',
  'root-eviction-records',
  'root-eviction-journal',
  'root-eviction-storage',
  'overlay-private-publication-admission',
  'private-publication-state',
  'private-publication-service',
  'wallet-recovery-encoding',
  'private-purchase-http',
  'sdk-auth-http',
  'protected-ledger'
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
  const expectedCounts = [
    229, 131, 525, 1072, 580, 1553, 176, 264, 336, 1164, 484, 463, 357, 374, 943, 456, 167, 673,
    890, 889
  ]
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
      if (id === 'wallet-recovery-plan')
        assert.equal(
          inventory.length,
          { 'plan-1': 62, 'construction-1': 35, 'construction-2': 34 }[part.id]
        )
      if (id === 'wallet-recovery-store')
        assert.equal(inventory.length, [44, 9, 14, 16, 20, 10, 93, 13, 10][parts.indexOf(part)])
      observed.push(...inventory)
    }
    assert.deepEqual(
      observed.map(mutantIdentity).toSorted(compare),
      canonical.map(mutantIdentity).toSorted(compare)
    )
    assert.equal(new Set(observed.map(mutantIdentity)).size, canonical.length)
    assert.equal(selectedMutationPartition(id, original), original)
  }
  assert.equal(Object.keys(targets).length, 151)
  assert.equal(mutationExecutionMatrix(Object.keys(targets), targets).include.length, 398)
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
    assert.notEqual(configs[0].id, configs[1].id, id)
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
      assert.equal(original.cacheDirectory, undefined, id)
      assert.ok(!project.cacheDirectory.split(path.sep).includes('node_modules'), id)
      const mapped = source => {
        const entry = project.moduleNameMapper.find(([pattern]) => new RegExp(pattern).test(source))
        assert.ok(entry, `${id}: ${source}`)
        return source.replace(new RegExp(entry[0]), entry[1])
      }
      for (const [source, expected] of [
        ['../../../overlay/src/Engine.js', 'packages/overlays/overlay/src/Engine.ts'],
        [
          '../../../overlay/src/__tests/mongo/MongoReplicaFixture.js',
          'packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.ts'
        ],
        [
          '../../../../sdk/src/overlay-tools/OutputPaidLookupTransport.js',
          'packages/sdk/src/overlay-tools/OutputPaidLookupTransport.ts'
        ],
        [
          '../../../../content/lch/test/overlay-acquisition-covenant.fixture.js',
          'packages/content/lch/test/overlay-acquisition-covenant.fixture.ts'
        ],
        [
          '../../../../content/lch/src/overlayAcquisitionCovenantSeller.js',
          'packages/content/lch/src/overlayAcquisitionCovenantSeller.ts'
        ]
      ]) {
        assert.equal(mapped(source), resolve(REPOSITORY_ROOT, expected), `${id}: ${source}`)
        assert.ok(existsSync(mapped(source)), `${id}: ${source}`)
      }
      if (id.startsWith('private-')) {
        const source =
          '../../../../application/output-knowledge/src/private/PrivatePublicationLookupContext.js'
        assert.equal(
          mapped(source),
          resolve(
            REPOSITORY_ROOT,
            'packages/application/output-knowledge/src/private/PrivatePublicationLookupContext.ts'
          ),
          id
        )
        assert.ok(existsSync(mapped(source)), id)
      }
      assert.equal(mapped('../PrivatePurchaseRoutes.js'), '../PrivatePurchaseRoutes', id)
      assert.ok(existsSync(mapped('uuid')), id)
      const transform = project.transform.find(([pattern]) =>
        new RegExp(pattern).test('fixture.ts')
      )
      assert.ok(transform, id)
      assert.equal(transform[2].useESM, original.displayName === 'private-esm', id)
      assert.deepEqual(
        transform[2].tsconfig,
        original.transform[String.raw`^.+\.tsx?$`][1].tsconfig,
        id
      )
    }
  }
})

test('incremental overlay metadata leaves dependency linking free and preserves original compiler and emit options', () => {
  const directory = resolve(REPOSITORY_ROOT, 'packages/overlays/overlay-express')
  const ts = createRequire(resolve(directory, 'package.json'))('typescript')
  const profiles = {
    esm: { rootDir: './', outDir: './dist/esm', allowSyntheticDefaultImports: true },
    cjs: {
      target: 'es2019',
      module: 'commonjs',
      moduleResolution: 'bundler',
      rootDir: './',
      outDir: './dist/cjs',
      declaration: true,
      declarationMap: true
    },
    types: {
      rootDir: './',
      outDir: './dist/types',
      emitDeclarationOnly: true,
      declaration: true,
      declarationMap: true
    }
  }
  for (const [profile, originalOptions] of Object.entries(profiles)) {
    const file = resolve(directory, `tsconfig.${profile}.json`)
    const source = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(source, {
      extends: './tsconfig.base.json',
      compilerOptions: {
        ...originalOptions,
        tsBuildInfoFile: `./.cache/overlay-express-${profile}.tsbuildinfo`
      }
    })
    const parsed = ts.parseJsonConfigFileContent(source, ts.sys, directory, undefined, file)
    assert.deepEqual(parsed.errors, [])
    assert.equal(
      parsed.options.tsBuildInfoFile,
      resolve(directory, `.cache/overlay-express-${profile}.tsbuildinfo`)
    )
    assert.ok(!parsed.options.tsBuildInfoFile.split(path.sep).includes('node_modules'))
    assert.equal(parsed.options.outDir, resolve(directory, `dist/${profile}`))
    assert.equal(parsed.options.incremental, true)
  }
})
