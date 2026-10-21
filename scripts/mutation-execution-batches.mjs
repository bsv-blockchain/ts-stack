import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { mutationExecutionMatrix } from './mutation-partitions.mjs'
import { qualificationIdentity } from './mutation-final-qualification.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const MAX_EXECUTION_BATCH_ROWS = 256

function closed(value, fields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}`)
  const keys = Reflect.ownKeys(value)
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)))
    throw new Error(`Unexpected ${label} fields`)
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new Error(`Invalid ${label} field`)
  }
}

function executionRows(matrix) {
  closed(matrix, ['include'], 'execution matrix')
  if (!Array.isArray(matrix.include)) throw new Error('Missing execution rows')
  if (matrix.include.length > MAX_EXECUTION_BATCH_ROWS ** 2)
    throw new Error('Execution inventory exceeds bounded batch capacity')
  const seen = new Set()
  return Array.from(matrix.include, row => {
    closed(row, ['target', 'partition'], 'execution row')
    for (const name of [row.target, row.partition])
      if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        throw new Error('Invalid execution row identity')
    const identity = JSON.stringify([row.target, row.partition])
    if (seen.has(identity)) throw new Error('Duplicate execution row')
    seen.add(identity)
    return { target: row.target, partition: row.partition }
  })
}

/** Scheduling slices only: the canonical flat source/options matrix is unchanged. */
export function mutationExecutionBatches(matrix, maximumRows = MAX_EXECUTION_BATCH_ROWS) {
  if (
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > MAX_EXECUTION_BATCH_ROWS
  )
    throw new Error('Invalid execution batch capacity')
  const rows = executionRows(matrix)
  if (Math.ceil(rows.length / maximumRows) > MAX_EXECUTION_BATCH_ROWS)
    throw new Error('Execution inventory exceeds bounded batch capacity')
  const include = []
  for (let offset = 0; offset < rows.length; offset += maximumRows)
    include.push({
      batch: include.length + 1,
      executionMatrix: { include: rows.slice(offset, offset + maximumRows) }
    })
  return { include }
}

/** Reject omissions, extra batches, altered order and a different capacity. */
export function verifyMutationExecutionBatches(matrix, batches) {
  if (!isDeepStrictEqual(batches, mutationExecutionBatches(matrix)))
    throw new Error('Execution batches differ from the complete ordered matrix')
}

export function mutationExecutionDigest(matrix) {
  return createHash('sha256')
    .update(JSON.stringify({ include: executionRows(matrix) }))
    .digest('hex')
}

/** Bind every invocation to the original source, run, attempt and build archive. */
export function verifyMutationExecutionIdentity(request, actual) {
  if (actual.matrixDigest !== mutationExecutionDigest(actual.executionMatrix))
    throw new Error('Execution context has a different complete matrix digest')
  for (const [name, expression] of [
    ['sourceSha', /^[a-f0-9]{40}$/],
    ['runId', /^[1-9]\d*$/],
    ['runAttempt', /^[1-9]\d*$/],
    ['archiveDigest', /^[a-f0-9]{64}$/],
    ['matrixDigest', /^[a-f0-9]{64}$/]
  ]) {
    if (
      typeof request[name] !== 'string' ||
      !expression.test(request[name]) ||
      request[name] !== actual[name]
    )
      throw new Error(`Stale or malformed execution ${name}`)
  }
  const batches = mutationExecutionBatches(actual.executionMatrix)
  if (!Number.isSafeInteger(request.batch) || request.batch < 1)
    throw new Error('Invalid execution batch number')
  const batch = batches.include[request.batch - 1]
  if (!batch || !isDeepStrictEqual(request.executionMatrix, batch.executionMatrix))
    throw new Error('Execution batch differs from the original complete matrix')
}

async function archiveDigest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function checkedBuildIdentity(value) {
  const versioned =
    value !== null && typeof value === 'object' && Object.hasOwn(value, 'nodeVersion')
  closed(
    value,
    [
      'sourceSha',
      'runId',
      'runAttempt',
      'archiveDigest',
      'artifactId',
      'artifactName',
      ...(versioned ? ['nodeVersion'] : [])
    ],
    'build identity'
  )
  if (
    versioned &&
    (typeof value.nodeVersion !== 'string' ||
      !/^v[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.nodeVersion))
  )
    throw new Error('Invalid build identity runtime')
  for (const field of ['runId', 'runAttempt', 'artifactId'])
    if (typeof value[field] !== 'string' || !/^[1-9]\d*$/.test(value[field]))
      throw new Error('Invalid build identity number')
  if (
    typeof value.sourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.sourceSha) ||
    typeof value.archiveDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.archiveDigest)
  )
    throw new Error('Invalid build identity digest')
  if (
    !['build-outputs', `mutation-build-outputs-${value.runId}-${value.runAttempt}`].includes(
      value.artifactName
    )
  )
    throw new Error('Unexpected build artifact name')
  return value
}

/** Capture once after upload; later batches must use the same original archive. */
export async function mutationBuildIdentity(root, environment) {
  const identity = qualificationIdentity(root, environment, buildMutationTargets(root))
  return checkedBuildIdentity({
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    archiveDigest: await archiveDigest(resolve(root, 'build-outputs.tar.gz')),
    artifactId: environment.BUILD_ARTIFACT_ID,
    artifactName: environment.BUILD_ARTIFACT_NAME,
    nodeVersion: identity.nodeVersion
  })
}

function selectedTargets(input, targets) {
  if (!Array.isArray(input) || input.length === 0 || new Set(input).size !== input.length)
    throw new Error('Invalid execution target selection')
  for (const id of input)
    if (typeof id !== 'string' || !Object.hasOwn(targets, id))
      throw new Error('Unknown execution target')
  return input
}

/** Verification is read-only and precedes extraction and every mutation test. */
export async function verifySelectedExecution(root, environment) {
  const requestIdentity = checkedBuildIdentity(JSON.parse(environment.EXECUTION_IDENTITY))
  const targets = buildMutationTargets(root)
  const selected = selectedTargets(JSON.parse(environment.SELECTED_TARGETS), targets)
  const executionMatrix = mutationExecutionMatrix(selected, targets)
  const identity = qualificationIdentity(root, environment, targets)
  if (
    Object.hasOwn(requestIdentity, 'nodeVersion') &&
    requestIdentity.nodeVersion !== identity.nodeVersion
  )
    throw new Error('Stale execution runtime')
  const actual = {
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    archiveDigest: await archiveDigest(resolve(root, '.ci-artifacts/build-outputs.tar.gz')),
    matrixDigest: mutationExecutionDigest(executionMatrix),
    executionMatrix
  }
  if (!/^[1-9]\d*$/.test(environment.EXECUTION_BATCH ?? ''))
    throw new Error('Invalid execution batch number')
  verifyMutationExecutionIdentity(
    {
      sourceSha: requestIdentity.sourceSha,
      runId: requestIdentity.runId,
      runAttempt: requestIdentity.runAttempt,
      archiveDigest: requestIdentity.archiveDigest,
      matrixDigest: environment.MUTATION_MATRIX_DIGEST,
      batch: Number(environment.EXECUTION_BATCH),
      executionMatrix: JSON.parse(environment.EXECUTION_MATRIX)
    },
    actual
  )
}

async function main() {
  if (process.argv.length !== 3) throw new Error('One execution batch command is required')
  const command = process.argv[2]
  if (command === 'build-identity') {
    console.log(JSON.stringify(await mutationBuildIdentity(ROOT, process.env)))
    return
  }
  if (command === 'verify-execution') {
    await verifySelectedExecution(ROOT, process.env)
    return
  }
  const matrix = JSON.parse(process.env.MUTATION_MATRIX)
  if (command === 'plan') console.log(JSON.stringify(mutationExecutionBatches(matrix)))
  else if (command === 'digest') console.log(mutationExecutionDigest(matrix))
  else if (command === 'verify-batches')
    verifyMutationExecutionBatches(matrix, JSON.parse(process.env.MUTATION_BATCHES))
  else throw new Error('Unknown execution batch command')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
