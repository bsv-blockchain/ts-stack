import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  partitionReceipt,
  combinePartitionEvidence,
  validateEvidencePaths
} from './mutation-partition-evidence.mjs'
import {
  identity,
  policy,
  evidence,
  report,
  executionFor
} from './ci-integration/fixtures/qualification-fixture.mjs'

const parts = ['src/api.ts', 'src/other.ts'].map((file, index) => ({
  id: `part-${index}`,
  evidence: {
    ...evidence,
    sources: new Map([[file, evidence.sources.get(file)]]),
    mutants: evidence.mutants.filter(mutant => mutant.fileName === file),
    config: { ...evidence.config, mutate: [evidence.config.mutate[index]] }
  }
}))
function packetFor(part, statuses = ['Killed'], mode = 'full') {
  const value = report()
  value.config = structuredClone(part.evidence.config)
  value.files = Object.fromEntries(
    Object.entries(value.files).filter(([file]) => part.evidence.sources.has(file))
  )
  let index = 0
  for (const file of Object.values(value.files))
    for (const mutant of file.mutants) {
      mutant.id = String(index)
      mutant.status = statuses[index++] ?? 'Killed'
    }
  const reportBytes = JSON.stringify(value)
  const execution = JSON.parse(executionFor(reportBytes))
  execution.partitionId = part.id
  const executionBytes = JSON.stringify(execution)
  return {
    reportBytes,
    executionBytes,
    receipt: partitionReceipt(
      identity,
      { targetId: 'one', partitionId: part.id, reportBytes, executionBytes },
      { policy, mode, evidence: part.evidence }
    )
  }
}
const combine = packets =>
  combinePartitionEvidence(identity, 'one', parts, packets, policy, 'full', evidence)

test('combined score uses the unchanged global denominator while retaining all disjoint canonical mutants', () => {
  const packets = [packetFor(parts[0], ['Survived']), packetFor(parts[1])]
  assert.equal(packets[0].receipt.metrics.score, 80)
  const result = combine(packets)
  assert.equal(result.receipt.metrics.score, 90)
  assert.equal(result.receipt.metrics.valid, 10)
  const ids = Object.values(JSON.parse(result.reportBytes).files).flatMap(file =>
    file.mutants.map(mutant => mutant.id)
  )
  assert.equal(new Set(ids).size, 10)
  assert.deepEqual(combine([...packets].reverse()), result)
  assert.throws(
    () => combine([packetFor(parts[0], ['Survived', 'Survived']), packetFor(parts[1])]),
    /below 90/
  )
})
test('missing, duplicate, unknown, stale, diagnostic and altered partition evidence cannot qualify', () => {
  const packets = parts.map(part => packetFor(part))
  assert.throws(() => combine(packets.slice(1)), /Missing/)
  assert.throws(() => combine([packets[0], packets[0], packets[1]]), /duplicate/)
  for (const mutate of [
    packet => {
      packet.receipt.partitionId = 'extra'
    },
    packet => {
      packet.receipt.identity.runAttempt = '3'
    },
    packet => {
      packet.receipt.mode = 'diagnostic'
    },
    packet => {
      packet.receipt.metrics.score = 0
    },
    packet => {
      packet.executionBytes = packet.executionBytes.replace('3242026', '1')
    },
    packet => {
      packet.reportBytes = packet.reportBytes.replace('Killed', 'Survived')
    }
  ]) {
    const changed = structuredClone(packets)
    mutate(changed[0])
    assert.throws(() => combine(changed))
  }
})
test('complete config/source/inventory proof, uncovered/invalid gates and identical property environments stay mandatory per part', () => {
  for (const status of ['NoCoverage', 'CompileError', 'RuntimeError'])
    assert.throws(() => packetFor(parts[0], [status]))
  const packets = parts.map(part => packetFor(part))
  const execution = JSON.parse(packets[0].executionBytes)
  execution.propertyEnvironment.FAST_CHECK_NUM_RUNS = '301'
  packets[0].executionBytes = JSON.stringify(execution)
  packets[0].receipt = partitionReceipt(
    identity,
    {
      targetId: 'one',
      partitionId: parts[0].id,
      reportBytes: packets[0].reportBytes,
      executionBytes: packets[0].executionBytes
    },
    { policy, mode: 'full', evidence: parts[0].evidence }
  )
  assert.throws(() => combine(packets), /different property/)
  const modified = JSON.parse(packets[0].reportBytes)
  modified.files['src/api.ts'].mutants.pop()
  const bytes = JSON.stringify(modified)
  execution.reportDigest = createHash('sha256').update(bytes).digest('hex')
  assert.throws(
    () =>
      partitionReceipt(
        identity,
        {
          targetId: 'one',
          partitionId: parts[0].id,
          reportBytes: bytes,
          executionBytes: JSON.stringify(execution)
        },
        { policy, mode: 'full', evidence: parts[0].evidence }
      ),
    /inventory/
  )
})

test('aggregate destinations cannot replace, contain or descend into raw evidence', () => {
  for (const output of [
    '/workspace/raw',
    '/workspace',
    '/workspace/raw/core',
    '/workspace/raw/core/aggregate'
  ])
    assert.throws(() => validateEvidencePaths('/workspace/raw', output), /disjoint/)
  for (const output of ['/workspace/result', '/workspace/raw-extra', '/other/aggregate'])
    assert.doesNotThrow(() => validateEvidencePaths('/workspace/raw', output))
  assert.throws(() => validateEvidencePaths('/workspace/raw', '/'), /disjoint/)
  assert.throws(() => validateEvidencePaths('/', '/workspace/result'), /disjoint/)
})
