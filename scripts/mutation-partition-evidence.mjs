#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import {
  partitionMutationTarget,
  partitionedMutationTargets,
  selectedMutationPartition,
  mutationExecutionMatrix
} from './mutation-partitions.mjs'
import {
  inspectMutationEvidence,
  makeTargetReceipt,
  qualificationIdentity,
  targetEvidence
} from './mutation-final-qualification.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
function compare(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function partitionReceipt(
  identity,
  { targetId, partitionId, reportBytes, executionBytes },
  { policy, mode, evidence }
) {
  const execution = JSON.parse(executionBytes)
  if (partitionId === 'whole' || execution.partitionId !== partitionId)
    throw new Error('Partition execution has a different or complete-target identity')
  const metrics = inspectMutationEvidence({
    identity,
    targetId,
    reportBytes,
    policy,
    mode,
    evidence,
    executionBytes,
    requireScore: false
  })
  return {
    schemaVersion: 1,
    kind: 'mutation-execution-partition',
    mode,
    targetId,
    partitionId,
    identity,
    reportDigest: digest(reportBytes),
    executionDigest: digest(executionBytes),
    metrics
  }
}

function checkedPartition(identity, targetId, expected, seen, packet, policy, mode) {
  const { receipt, reportBytes, executionBytes } = packet
  const part = expected.get(receipt.partitionId)
  if (!part || receipt.targetId !== targetId || seen.has(part.id))
    throw new Error('Unknown, duplicate or mismatched partition receipt')
  const checked = partitionReceipt(
    identity,
    { targetId, partitionId: part.id, reportBytes, executionBytes },
    { policy, mode, evidence: part.evidence }
  )
  if (!isDeepStrictEqual(receipt, checked))
    throw new Error('Partition receipt changed or has stale identity')
  seen.add(part.id)
  const execution = JSON.parse(executionBytes)
  return { part, checked, execution }
}
function addPartitionFiles(files, partitionId, reportBytes) {
  for (const [file, value] of Object.entries(JSON.parse(reportBytes).files)) {
    if (Object.hasOwn(files, file)) throw new Error('Partition source files overlap')
    files[file] = {
      ...value,
      mutants: value.mutants.map(mutant => ({ ...mutant, id: `${partitionId}/${mutant.id}` }))
    }
  }
}

export function combinePartitionEvidence(
  identity,
  targetId,
  parts,
  packets,
  policy,
  mode,
  canonical
) {
  const expected = new Map(parts.map(part => [part.id, part]))
  if (expected.size !== parts.length || expected.has('whole') || expected.size === 0)
    throw new Error('Missing disjoint execution partition plan')
  const seen = new Set()
  const files = {}
  let properties
  const bindings = []
  for (const packet of packets) {
    const { part, checked, execution } = checkedPartition(
      identity,
      targetId,
      expected,
      seen,
      packet,
      policy,
      mode
    )
    if (properties && !isDeepStrictEqual(properties, execution.propertyEnvironment))
      throw new Error('Partitions use different property settings')
    properties = execution.propertyEnvironment
    bindings.push({
      partitionId: part.id,
      reportDigest: checked.reportDigest,
      executionDigest: checked.executionDigest
    })
    addPartitionFiles(files, part.id, packet.reportBytes)
  }
  if (seen.size !== expected.size) throw new Error('Missing canonical execution partition')
  // Normalize execution ordering only; the original canonical inventory/config
  // and global score are rechecked by makeTargetReceipt below.
  const reportBytes = JSON.stringify({
    schemaVersion: '1.0',
    framework: { name: 'StrykerJS', version: '9.6.1' },
    projectRoot: canonical.projectRoot,
    config: canonical.config,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => compare(left, right)))
  })
  bindings.sort((left, right) => compare(left.partitionId, right.partitionId))
  const executionBytes = JSON.stringify({
    kind: 'verified-partition-aggregate',
    targetId,
    partitionId: 'whole',
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    nodeVersion: identity.nodeVersion,
    propertyEnvironment: properties,
    reportDigest: digest(reportBytes),
    partitions: bindings
  })
  const receipt = makeTargetReceipt(
    identity,
    targetId,
    reportBytes,
    policy,
    mode,
    canonical,
    executionBytes
  )
  return { receipt, reportBytes, executionBytes }
}

export function validateEvidencePaths(directory, destination) {
  const input = path.resolve(directory),
    output = path.resolve(destination)
  const inputPrefix = input.endsWith(path.sep) ? input : `${input}${path.sep}`
  const outputPrefix = output.endsWith(path.sep) ? output : `${output}${path.sep}`
  if (input === output || input.startsWith(outputPrefix) || output.startsWith(inputPrefix))
    throw new Error('Aggregate output and raw input evidence must be disjoint')
}

function packetIn(directory, file = 'partition-receipt.json') {
  return {
    receipt: JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')),
    reportBytes: fs.readFileSync(path.join(directory, 'mutation.json'), 'utf8'),
    executionBytes: fs.readFileSync(path.join(directory, 'execution.json'), 'utf8')
  }
}
function packetDirectories(directory, file) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const location = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Symlink cannot supply partition evidence')
    if (entry.isDirectory()) return packetDirectories(location, file)
    return entry.name === file ? [directory] : []
  })
}
function parseArguments(argv) {
  const [command, ...rest] = argv
  if (!['matrix', 'targets', 'capture', 'verify', 'recheck'].includes(command))
    throw new Error('Unknown partition command')
  const options = { command }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].replace(/^--/, '')
    if (
      !['selected', 'target', 'partition', 'directory', 'output', 'mode'].includes(key) ||
      !rest[index + 1] ||
      Object.hasOwn(options, key)
    )
      throw new Error('Invalid partition arguments')
    options[key] = rest[index + 1]
  }
  return options
}
async function context(targetId, mode, targets) {
  if (!['full', 'diagnostic'].includes(mode) || !Object.hasOwn(targets, targetId))
    throw new Error('Missing canonical partition target or mode')
  const identity = qualificationIdentity(ROOT, process.env, targets)
  const policy = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  const parts = await Promise.all(
    partitionMutationTarget(targetId, targets[targetId]).map(async part => ({
      ...part,
      evidence: await targetEvidence(ROOT, part.target, targetId, part.id)
    }))
  )
  return {
    identity,
    policy,
    parts,
    canonical: await targetEvidence(ROOT, targets[targetId], targetId)
  }
}
async function main(argv) {
  const options = parseArguments(argv)
  const targets = buildMutationTargets(ROOT)
  if (options.command === 'matrix') {
    console.log(JSON.stringify(mutationExecutionMatrix(JSON.parse(options.selected), targets)))
    return
  }
  if (options.command === 'targets') {
    console.log(JSON.stringify(partitionedMutationTargets(JSON.parse(options.selected), targets)))
    return
  }
  const { identity, policy, parts, canonical } = await context(
    options.target,
    options.mode,
    targets
  )
  if (options.command === 'capture') {
    const target = selectedMutationPartition(
      options.target,
      targets[options.target],
      options.partition
    )
    const evidence = await targetEvidence(ROOT, target, options.target, options.partition)
    const reportBytes = fs.readFileSync(path.join(options.directory, 'mutation.json'), 'utf8')
    const executionBytes = fs.readFileSync(path.join(options.directory, 'execution.json'), 'utf8')
    const receipt = partitionReceipt(
      identity,
      { targetId: options.target, partitionId: options.partition, reportBytes, executionBytes },
      { policy, mode: options.mode, evidence }
    )
    fs.writeFileSync(
      path.join(options.directory, 'partition-receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n'
    )
    return
  }
  if (options.command === 'recheck') {
    const directories = packetDirectories(options.directory, 'receipt.json').filter(
      directory => packetIn(directory, 'receipt.json').receipt.targetId === options.target
    )
    if (directories.length !== 1) throw new Error('Missing or duplicate combined canonical report')
    const current = packetIn(directories[0], 'receipt.json')
    const packets = packetDirectories(
      path.join(directories[0], 'parts'),
      'partition-receipt.json'
    ).map(directory => packetIn(directory))
    const combined = combinePartitionEvidence(
      identity,
      options.target,
      parts,
      packets,
      policy,
      options.mode,
      canonical
    )
    if (!isDeepStrictEqual(combined, current))
      throw new Error('Canonical aggregate differs from its complete raw partition evidence')
    console.log('Canonical partition aggregate independently rechecked.')
    return
  }
  const directories = packetDirectories(options.directory, 'partition-receipt.json')
  const packets = directories.map(directory => packetIn(directory))
  const combined = combinePartitionEvidence(
    identity,
    options.target,
    parts,
    packets,
    policy,
    options.mode,
    canonical
  )
  if (!options.output) throw new Error('Combined report output is required')
  validateEvidencePaths(options.directory, options.output)
  fs.rmSync(options.output, { recursive: true, force: true })
  fs.mkdirSync(options.output, { recursive: true })
  fs.writeFileSync(path.join(options.output, 'mutation.json'), combined.reportBytes)
  fs.writeFileSync(path.join(options.output, 'execution.json'), combined.executionBytes)
  fs.writeFileSync(
    path.join(options.output, 'receipt.json'),
    JSON.stringify(combined.receipt, null, 2) + '\n'
  )
  for (const directory of directories) {
    const { partitionId } = packetIn(directory).receipt
    fs.cpSync(directory, path.join(options.output, 'parts', partitionId), {
      recursive: true,
      errorOnExist: true
    })
  }
  console.log(
    `Canonical ${options.target} mutation gate passed from every partition; score ${combined.receipt.metrics.score.toFixed(2)}, mode=${options.mode}. No full-campaign output issued here.`
  )
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
