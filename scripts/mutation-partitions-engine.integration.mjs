import { mutationExecutionBatches } from './mutation-execution-batches.mjs'
import assert from 'node:assert/strict'

import test from 'node:test'

import path, { join, resolve } from 'node:path'

import { createRequire } from 'node:module'

import fs, { existsSync, readFileSync } from 'node:fs'

import { REPOSITORY_ROOT } from './mutation-testing.mjs'

import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'

import { canonicalInventory, targetSources } from './mutation-final-qualification.mjs'

import {
  partitionMutationTarget,
  canonicalMutationPartitions,
  selectedMutationPartition,
  mutationExecutionMatrix,
  applyPartitionComponentTests
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

async function* serialResults(values, read) {
  for (const value of values) yield read(value)
}

test('declaration companions preserve the complete pinned-engine inventory without empty executions', async () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const targetsToCheck = serialResults(
    ['private-purchase-disclosure', 'root-eviction-coordination', 'private-purchase-buyer'],
    async id => {
      const original = targets[id],
        directory = path.join(REPOSITORY_ROOT, original.packageDirectory)
      return {
        id,
        original,
        directory,
        canonical: await canonicalInventory(
          directory,
          targetSources(REPOSITORY_ROOT, original),
          original.mutate
        )
      }
    }
  )
  for await (const { id, original, directory, canonical } of targetsToCheck) {
    const observed = []
    const parts = serialResults(partitionMutationTarget(id, original), async part => {
      assert.deepEqual({ ...part.target, mutate: original.mutate }, original)
      return {
        part,
        inventory: await canonicalInventory(
          directory,
          targetSources(REPOSITORY_ROOT, part.target),
          part.target.mutate
        )
      }
    })
    for await (const { part, inventory } of parts) {
      assert.ok(inventory.length > 0, `${id}/${part.id} cannot produce empty evidence`)
      observed.push(...inventory)
    }
    assert.deepEqual(
      observed.map(mutantIdentity).toSorted(compare),
      canonical.map(mutantIdentity).toSorted(compare)
    )
    assert.equal(new Set(observed.map(mutantIdentity)).size, canonical.length)
  }
})

test('semantic execution ranges preserve every actual pinned-engine mutant and all original qualification settings', async () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const expectedCounts = [
    229, 131, 525, 1082, 580, 1570, 176, 264, 336, 1164, 484, 463, 357, 374, 943, 456, 167, 673,
    890, 994
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
    // Preserve all twenty original golden totals and explicitly include every
    // new protected-envelope framing, retained-recovery and AuthFetch sites in the same complete partitions.
    const addedFramingSites =
      { 'protected-ledger': 29, 'wallet-recovery-plan': 4, 'sdk-auth-http': 33 }[id] ?? 0
    assert.equal(canonical.length, expectedCounts[index] + addedFramingSites)
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
          { 'plan-1': 62, 'construction-1': 35, 'construction-2': 38 }[part.id]
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
  assert.equal(Object.keys(targets).length, 216)
  assert.equal(mutationExecutionMatrix(Object.keys(targets), targets).include.length, 1678)
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

function lexicalCompare(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

async function* inventories(directory, parts) {
  for (const part of parts)
    yield canonicalInventory(
      directory,
      targetSources(REPOSITORY_ROOT, part.target),
      part.target.mutate
    )
}

test('primary sync execution retains every original file/range, full configuration and future helper', async () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-snapshot-sync']
  const parts = partitionMutationTarget('wallet-snapshot-sync', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['session', 'checkpoint', 'copy', 'storage', 'primary']
  )
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).toSorted(lexicalCompare),
    [...canonical.mutate].toSorted(lexicalCompare)
  )
  const owners = new Map()
  const tuples = []
  const directory = join(REPOSITORY_ROOT, canonical.packageDirectory)
  const tuple = mutant =>
    JSON.stringify({
      file: mutant.fileName,
      name: mutant.mutatorName,
      location: mutant.location,
      replacement: mutant.replacement
    })
  for (const part of parts) {
    assert.deepEqual(part.target, { ...canonical, mutate: part.target.mutate })
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
    for (const specification of part.target.mutate) {
      const file = specification.replace(/:\d+(?:-\d+)?$/, '')
      assert.ok(!owners.has(file) || owners.get(file) === part.id)
      owners.set(file, part.id)
    }
  }
  for await (const mutants of inventories(directory, parts)) tuples.push(...mutants.map(tuple))
  const original = (
    await canonicalInventory(directory, targetSources(REPOSITORY_ROOT, canonical), canonical.mutate)
  ).map(tuple)
  assert.ok(original.length > 0)
  assert.equal(new Set(tuples).size, tuples.length)
  assert.deepEqual(tuples.toSorted(lexicalCompare), original.toSorted(lexicalCompare))
  assert.equal(owners.get('src/storage/WalletStorageManager.ts'), 'primary')
  assert.equal(owners.get('src/storage/StorageKnex.ts'), 'storage')
  assert.equal(owners.get('src/storage/snapshot/SnapshotSync.ts'), 'session')
  const helper = 'src/storage/snapshot/FuturePrimaryHelper.ts'
  const future = partitionMutationTarget('wallet-snapshot-sync', {
    ...canonical,
    mutate: [...canonical.mutate, helper]
  })
  assert.deepEqual(future[0].target.mutate, [...parts[0].target.mutate, helper])
  assert.equal(selectedMutationPartition('wallet-snapshot-sync', canonical), canonical)
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  assert.ok(
    mutationExecutionBatches(mutationExecutionMatrix(Object.keys(targets), targets)).include.every(
      batch => batch.executionMatrix.include.length <= 256
    )
  )
})

test('installed mutation engine retains the complete canonical serializer inventory exactly once', async () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-portable-canonical-chunks']
  const parts = partitionMutationTarget('wallet-portable-canonical-chunks', canonical)
  const directory = join(REPOSITORY_ROOT, canonical.packageDirectory)
  const tuple = mutant =>
    JSON.stringify({
      file: mutant.fileName,
      name: mutant.mutatorName,
      location: mutant.location,
      replacement: mutant.replacement
    })
  const tuples = []
  for (const part of parts) {
    assert.deepEqual(part.target, { ...canonical, mutate: part.target.mutate })
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
  }
  for await (const mutants of inventories(directory, parts)) tuples.push(...mutants.map(tuple))
  const original = (
    await canonicalInventory(directory, targetSources(REPOSITORY_ROOT, canonical), canonical.mutate)
  ).map(tuple)
  assert.ok(original.length > 0)
  assert.equal(new Set(tuples).size, tuples.length)
  assert.deepEqual(tuples.toSorted(lexicalCompare), original.toSorted(lexicalCompare))
})

test('every generated refinement retains the actual full canonical inventory and identical complete runner exactly once', async () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT),
    plan = JSON.parse(
      fs.readFileSync(
        join(REPOSITORY_ROOT, 'governance/mutation-testing/execution-partitions.json'),
        'utf8'
      )
    ),
    tuple = mutant =>
      JSON.stringify({
        file: mutant.fileName,
        name: mutant.mutatorName,
        location: mutant.location,
        replacement: mutant.replacement
      })
  assert.equal(plan.schemaVersion, 1)
  assert.equal(plan.engine, '9.6.1')
  let count = 0
  for (const unit of plan.units) {
    const canonical = targets[unit.target],
      originalBase = canonicalMutationPartitions(unit.target, canonical).find(
        part => part.id === unit.existingPartition
      ),
      base =
        unit.target === 'wallet-retained-snapshot' && unit.existingPartition === 'sqlite-bootstrap'
          ? applyPartitionComponentTests(
              originalBase,
              canonical.componentTestPartitions['sqlite-bootstrap'],
              file => fs.readFileSync(join(REPOSITORY_ROOT, canonical.packageDirectory, file))
            )
          : originalBase,
      ids = new Set(unit.parts.map(part => part.id)),
      parts = partitionMutationTarget(unit.target, canonical).filter(part => ids.has(part.id)),
      directory = join(REPOSITORY_ROOT, canonical.packageDirectory),
      sources = targetSources(REPOSITORY_ROOT, base.target),
      expected = (await canonicalInventory(directory, sources, base.target.mutate)).map(tuple),
      actual = [],
      files = new Set()
    assert.equal(parts.length, unit.parts.length)
    for (const part of parts) {
      if (base === originalBase) assert.equal(part.target.runnerOptions, canonical.runnerOptions)
      else assert.deepEqual(part.target.runnerOptions, base.target.runnerOptions)
      assert.deepEqual(part.target, { ...base.target, mutate: part.target.mutate })
      const partSources = targetSources(REPOSITORY_ROOT, part.target)
      for (const [file, source] of partSources) {
        assert.equal(
          source,
          sources.get(file),
          'Complete source bytes changed inside an execution range'
        )
        files.add(file)
      }
      actual.push(
        ...(await canonicalInventory(directory, partSources, part.target.mutate)).map(tuple)
      )
    }
    assert.equal(new Set(actual).size, actual.length, 'Cross-part canonical mutant overlap')
    assert.deepEqual(actual.toSorted(lexicalCompare), expected.toSorted(lexicalCompare))
    assert.deepEqual([...files].sort(lexicalCompare), [...sources.keys()].sort(lexicalCompare))
    assert.equal(actual.length, unit.canonicalCount)
    count += actual.length
  }
  assert.equal(
    count,
    plan.units.reduce((sum, unit) => sum + unit.canonicalCount, 0)
  )
  const matrix = mutationExecutionMatrix(Object.keys(targets), targets)
  assert.equal(matrix.include.length, plan.executionRows)
  assert.ok(
    mutationExecutionBatches(matrix).include.every(
      batch => batch.executionMatrix.include.length <= 256
    )
  )
})
