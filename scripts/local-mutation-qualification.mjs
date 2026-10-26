#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { mutationExecutionMatrix, partitionMutationTarget } from './mutation-partitions.mjs'
import {
  makeTargetReceipt,
  targetEvidence,
  verifyFullCampaign
} from './mutation-final-qualification.mjs'
import {
  combinePartitionEvidence,
  partitionReceipt,
  validateEvidencePaths
} from './mutation-partition-evidence.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const digest = value => createHash('sha256').update(value).digest('hex')
const jsonDigest = value => digest(JSON.stringify(value))
// Receipt identities retain the original code-unit order, independent of locale.
function compareStrings(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const sorted = values => [...values].sort(compareStrings)
const sha256 = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const git = (root, ...args) => execFileSync('/usr/bin/git', args, { cwd: root }).toString()

export function trackedSourceDigest(root) {
  assert.equal(
    git(root, 'status', '--porcelain', '--untracked-files=no').trim(),
    '',
    'Local qualification requires committed, unchanged tracked source'
  )
  const names = sorted(git(root, 'ls-files', '-z').split('\0').filter(Boolean))
  assert.ok(names.length > 0, 'Local qualification requires complete tracked source')
  const files = names.map(name => {
    const file = path.join(root, name)
    const descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
    try {
      assert.ok(
        fs.fstatSync(descriptor).isFile(),
        'Tracked qualification source must be a regular file'
      )
      return [name, digest(fs.readFileSync(descriptor))]
    } finally {
      fs.closeSync(descriptor)
    }
  })
  assert.equal(
    git(root, 'status', '--porcelain', '--untracked-files=no').trim(),
    '',
    'Local qualification requires committed, unchanged tracked source'
  )
  return { trackedCount: files.length, sourceDigest: jsonDigest(files) }
}

export function validateLocalIdentity(identity) {
  assert.equal(identity.origin, 'local', 'A local receipt must explicitly name its origin')
  assert.equal(identity.runId, '', 'Local evidence cannot claim a GitHub run')
  assert.equal(identity.runAttempt, '', 'Local evidence cannot claim a GitHub attempt')
  assert.match(identity.localRunId, uuid, 'Local evidence requires a fresh UUID')
  assert.ok(Number.isSafeInteger(identity.localAttempt) && identity.localAttempt > 0)
  assert.match(identity.sourceSha, /^[a-f0-9]{40}$/)
  assert.match(identity.sourceTree, /^[a-f0-9]{40}$/)
  assert.match(identity.nodeVersion, /^v[1-9]\d*\.\d+\.\d+$/)
  assert.ok(path.isAbsolute(identity.nodeExecutable))
  for (const field of [
    'sourceDigest',
    'inputsDigest',
    'targetsDigest',
    'matrixDigest',
    'runtimeDigest',
    'nodeExecutableDigest'
  ])
    assert.match(identity[field], sha256, field)
  assert.ok(Number.isSafeInteger(identity.trackedCount) && identity.trackedCount > 0)
  assert.ok(Array.isArray(identity.targetIds) && identity.targetIds.length > 0)
  assert.ok(
    identity.targetIds.every(
      target => typeof target === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target)
    )
  )
  assert.deepEqual(identity.targetIds, sorted(new Set(identity.targetIds)))
  assert.equal(
    identity.inputsDigest,
    jsonDigest({
      trackedCount: identity.trackedCount,
      sourceDigest: identity.sourceDigest,
      runtimeDigest: identity.runtimeDigest
    }),
    'Local input closure binding differs'
  )
  assert.equal(identity.platform, 'linux', 'Target execution requires Linux')
  assert.ok(['arm64', 'x64'].includes(identity.arch))
  return identity
}

export function createLocalIdentity(root, targets, runtimeDigest, environment = process.env) {
  for (const field of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA'])
    assert.ok(!environment[field], 'Local qualification cannot inherit hosted identity')
  const source = trackedSourceDigest(root)
  const targetIds = sorted(Object.keys(targets))
  const matrix = mutationExecutionMatrix(targetIds, targets).include
  return validateLocalIdentity({
    origin: 'local',
    sourceSha: git(root, 'rev-parse', 'HEAD').trim(),
    sourceTree: git(root, 'rev-parse', 'HEAD^{tree}').trim(),
    runId: '',
    runAttempt: '',
    localRunId: randomUUID(),
    localAttempt: 1,
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    nodeExecutableDigest: digest(fs.readFileSync(process.execPath)),
    platform: process.platform,
    arch: process.arch,
    ...source,
    inputsDigest: jsonDigest({ ...source, runtimeDigest }),
    runtimeDigest,
    targetsDigest: jsonDigest(targets),
    matrixDigest: jsonDigest(matrix),
    targetIds
  })
}

// The existing runner truthfully writes empty hosted IDs outside GitHub. Its raw
// execution record is retained unchanged. A separate bounded Linux controller
// supplies the local run binding and physical drain/source/runtime observations.
export function assertLocalExecution(identity, row, observation, reportBytes, executionBytes) {
  validateLocalIdentity(identity)
  assert.equal(observation.kind, 'bounded-local-mutation-execution')
  for (const field of ['localRunId', 'localAttempt', 'sourceSha', 'sourceTree', 'nodeVersion'])
    assert.equal(observation[field], identity[field], field)
  assert.equal(observation.targetId, row.target)
  assert.equal(observation.partitionId, row.partition)
  assert.deepEqual(observation.argv, [
    identity.nodeExecutable,
    'scripts/mutation-testing.mjs',
    '--target',
    row.target,
    '--partition',
    row.partition
  ])
  assert.equal(observation.exitCode, 0)
  assert.equal(observation.signal, null)
  assert.equal(observation.processGroupGone, true)
  assert.ok(Number.isSafeInteger(observation.processGroup) && observation.processGroup > 0)
  for (const field of [
    'timedOut',
    'knownNativeFaultMarker',
    'boundedTriageExceeded',
    'testCaseTimeoutMarker',
    'rawPayloadPrinted'
  ])
    assert.equal(observation[field], false, field)
  assert.ok(Number.isFinite(observation.seconds) && observation.seconds >= 0)
  assert.ok(Number.isFinite(observation.deadlineSeconds) && observation.deadlineSeconds > 0)
  assert.ok(
    observation.seconds < observation.deadlineSeconds,
    'Local execution exceeded its deadline'
  )
  for (const field of ['beforeSourceDigest', 'afterSourceDigest'])
    assert.equal(observation[field], identity.sourceDigest)
  for (const field of ['beforeRuntimeDigest', 'afterRuntimeDigest'])
    assert.equal(observation[field], identity.runtimeDigest)
  assert.equal(observation.reportDigest, digest(reportBytes))
  assert.equal(observation.executionDigest, digest(executionBytes))
  const execution = JSON.parse(executionBytes)
  assert.equal(execution.targetId, row.target)
  assert.equal(execution.partitionId, row.partition)
  assert.equal(execution.runId, '')
  assert.equal(execution.runAttempt, '')
  return observation
}

export function verifyLocalRows(identity, matrix, packets, inspect) {
  validateLocalIdentity(identity)
  assert.equal(jsonDigest(matrix), identity.matrixDigest)
  const key = row => JSON.stringify([row.target, row.partition])
  const expected = new Map(matrix.map(row => [key(row), row]))
  assert.equal(expected.size, matrix.length, 'Duplicate canonical local execution row')
  const seen = new Set()
  for (const packet of packets) {
    const row = expected.get(key(packet.row))
    assert.ok(row && !seen.has(key(row)), 'Unknown or duplicate local execution row')
    assertLocalExecution(
      identity,
      row,
      packet.observation,
      packet.reportBytes,
      packet.executionBytes
    )
    inspect(row, packet)
    seen.add(key(row))
  }
  assert.equal(seen.size, expected.size, 'Incomplete local mutation execution matrix')
  assert.ok(seen.size > 0)
}

export function readLocalPackets(directory, matrix) {
  const base = path.resolve(directory)
  assert.ok(fs.lstatSync(base).isDirectory(), 'Local evidence root must be a regular directory')
  const expected = new Map(
    matrix.map(row => {
      for (const component of [row.target, row.partition])
        assert.match(
          component,
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          'Invalid canonical evidence component'
        )
      return [path.join(row.target, ...(row.partition === 'whole' ? [] : [row.partition])), row]
    })
  )
  const files = new Set(['mutation.json', 'execution.json', 'local-execution.json'])
  const inventory = new Set()
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(base, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      assert.ok(!entry.isSymbolicLink(), 'Symlinks cannot supply local evidence')
      if (entry.isDirectory()) {
        assert.ok(
          [...expected.keys()].some(
            location => location === name || location.startsWith(`${name}${path.sep}`)
          ),
          'Unknown local evidence directory or row'
        )
        walk(name)
      } else {
        assert.ok(
          entry.isFile() && expected.has(relative) && files.has(entry.name),
          'Unknown local evidence file or row'
        )
        inventory.add(name)
      }
    }
  }
  walk()
  return matrix.map(row => {
    const relative = path.join(row.target, ...(row.partition === 'whole' ? [] : [row.partition]))
    const read = name => {
      const member = path.join(relative, name)
      assert.ok(inventory.has(member), 'Missing local evidence file')
      const descriptor = fs.openSync(
        path.join(base, member),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      )
      try {
        assert.ok(fs.fstatSync(descriptor).isFile(), 'Local evidence must be a regular file')
        return fs.readFileSync(descriptor, 'utf8')
      } finally {
        fs.closeSync(descriptor)
      }
    }
    return {
      row,
      reportBytes: read('mutation.json'),
      executionBytes: read('execution.json'),
      observation: JSON.parse(read('local-execution.json'))
    }
  })
}

export async function verifyLocalCampaign(root, manifest, directory, runtimeDigest) {
  const { identity, matrix } = manifest
  validateLocalIdentity(identity)
  assert.equal(runtimeDigest, identity.runtimeDigest, 'Live runtime closure differs from the run')
  assert.equal(process.platform, identity.platform)
  assert.equal(process.arch, identity.arch)
  assert.equal(process.version, identity.nodeVersion)
  assert.equal(process.execPath, identity.nodeExecutable)
  assert.equal(digest(fs.readFileSync(process.execPath)), identity.nodeExecutableDigest)
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), identity.sourceSha)
  assert.equal(git(root, 'rev-parse', 'HEAD^{tree}').trim(), identity.sourceTree)
  assert.deepEqual(trackedSourceDigest(root), {
    trackedCount: identity.trackedCount,
    sourceDigest: identity.sourceDigest
  })
  const targets = buildMutationTargets(root)
  assert.equal(jsonDigest(targets), identity.targetsDigest)
  assert.deepEqual(sorted(Object.keys(targets)), identity.targetIds)
  assert.deepEqual(mutationExecutionMatrix(identity.targetIds, targets).include, matrix)
  const policy = JSON.parse(
    fs.readFileSync(path.join(root, 'governance/mutation-testing/policy.json'))
  )
  const packets = readLocalPackets(directory, matrix)
  verifyLocalRows(identity, matrix, packets, () => {})
  const complete = []
  const canonicalByTarget = new Map()
  await inSeries(identity.targetIds, async targetId => {
    const target = targets[targetId]
    const canonical = await targetEvidence(root, target, targetId)
    canonicalByTarget.set(targetId, canonical)
    const selected = packets.filter(packet => packet.row.target === targetId)
    const parts = partitionMutationTarget(targetId, target)
    if (parts.length === 1 && parts[0].id === 'whole') {
      assert.equal(selected.length, 1)
      const packet = selected[0]
      complete.push({
        ...packet,
        receipt: makeTargetReceipt(
          identity,
          targetId,
          packet.reportBytes,
          policy,
          'full',
          canonical,
          packet.executionBytes
        )
      })
    } else {
      const checkedParts = []
      await inSeries(parts, async part => {
        checkedParts.push({
          ...part,
          evidence: await targetEvidence(root, part.target, targetId, part.id)
        })
      })
      const checkedPackets = selected.map(packet => ({
        ...packet,
        receipt: partitionReceipt(
          identity,
          {
            targetId,
            partitionId: packet.row.partition,
            reportBytes: packet.reportBytes,
            executionBytes: packet.executionBytes
          },
          {
            policy,
            mode: 'full',
            evidence: checkedParts.find(part => part.id === packet.row.partition).evidence
          }
        )
      }))
      complete.push(
        combinePartitionEvidence(
          identity,
          targetId,
          checkedParts,
          checkedPackets,
          policy,
          'full',
          canonical
        )
      )
    }
  })
  const checked = verifyFullCampaign(identity, complete, policy, target =>
    canonicalByTarget.get(target)
  )
  assert.deepEqual(trackedSourceDigest(root), {
    trackedCount: identity.trackedCount,
    sourceDigest: identity.sourceDigest
  })
  return {
    ...checked,
    kind: 'local-full-mutation-qualification',
    hostedQualified: false,
    executionRowCount: matrix.length,
    rawDigests: packets.map(packet => ({
      ...packet.row,
      reportDigest: digest(packet.reportBytes),
      executionDigest: digest(packet.executionBytes),
      observationDigest: jsonDigest(packet.observation)
    }))
  }
}

/** Canonical instrumentation must remain exclusive and stop at the first failure. */
async function inSeries(values, visit) {
  const iterator = values[Symbol.iterator]()
  async function next() {
    const item = iterator.next()
    if (item.done) return
    try {
      await visit(item.value)
    } catch (error) {
      try {
        iterator.return?.()
      } catch {
        // Preserve the original body error, as a failing for-of body does.
      }
      throw error
    }
    await next()
  }
  await next()
}

function outputOutsideSource(root, file, evidence) {
  const output = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file))
  validateEvidencePaths(fs.realpathSync(root), output)
  if (evidence) validateEvidencePaths(fs.realpathSync(evidence), output)
  return output
}

async function main(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    assert.ok(
      ['--manifest', '--runtime-digest', '--directory', '--output'].includes(key) &&
        rest[index + 1] &&
        !Object.hasOwn(options, key),
      'Invalid local qualification arguments'
    )
    options[key] = rest[index + 1]
  }
  assert.ok(options['--manifest'])
  if (command === 'init') {
    assert.deepEqual(sorted(Object.keys(options)), ['--manifest', '--runtime-digest'])
    const targets = buildMutationTargets(ROOT)
    const identity = createLocalIdentity(ROOT, targets, options['--runtime-digest'])
    const manifest = {
      schemaVersion: 1,
      identity,
      matrix: mutationExecutionMatrix(identity.targetIds, targets).include
    }
    fs.writeFileSync(
      outputOutsideSource(ROOT, options['--manifest']),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx' }
    )
    console.log(
      `Local run ${identity.localRunId}: ${identity.targetIds.length} targets, ${manifest.matrix.length} rows`
    )
  } else {
    assert.equal(command, 'verify')
    assert.deepEqual(sorted(Object.keys(options)), [
      '--directory',
      '--manifest',
      '--output',
      '--runtime-digest'
    ])
    const manifest = JSON.parse(fs.readFileSync(options['--manifest']))
    assert.equal(manifest.schemaVersion, 1)
    const result = await verifyLocalCampaign(
      ROOT,
      manifest,
      options['--directory'],
      options['--runtime-digest']
    )
    fs.writeFileSync(
      outputOutsideSource(ROOT, options['--output'], options['--directory']),
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx' }
    )
    console.log(
      `Local mutation qualification: ${result.targetCount} targets, ${result.executionRowCount} rows; hosted qualification remains separate`
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main(process.argv.slice(2))
