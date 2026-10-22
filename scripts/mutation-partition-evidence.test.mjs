import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalInventory } from './mutation-final-qualification.mjs'
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
  value.projectRoot = part.evidence.projectRoot
  value.files = {}
  let index = 0
  for (const expected of part.evidence.mutants) {
    const { fileName, ...mutant } = expected
    const file = (value.files[fileName] ??= {
      source: part.evidence.sources.get(fileName),
      mutants: []
    })
    file.mutants.push({ ...mutant, id: String(index), status: statuses[index++] ?? 'Killed' })
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

async function rangedFixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-range-evidence-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const [file, source] of evidence.sources) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    fs.writeFileSync(path.join(directory, file), source)
  }
  const mutate = ['src/api.ts', 'src/other.ts', 'src/types.ts']
  const canonical = {
    ...evidence,
    projectRoot: directory,
    config: { ...evidence.config, mutate },
    mutants: await canonicalInventory(directory, evidence.sources, mutate)
  }
  const selections = [['src/api.ts:1-1'], ['src/api.ts:2-2'], ['src/other.ts', 'src/types.ts']]
  const ranged = []
  for (const [index, selection] of selections.entries()) {
    const files = new Set(selection.map(file => file.replace(/:\d+(?:-\d+)?$/, '')))
    const sources = new Map([...evidence.sources].filter(([file]) => files.has(file)))
    ranged.push({
      id: 'range-' + index,
      evidence: {
        ...canonical,
        sources,
        config: { ...canonical.config, mutate: selection },
        mutants: await canonicalInventory(directory, sources, selection)
      }
    })
  }
  return {
    canonical,
    ranged,
    combine: packets =>
      combinePartitionEvidence(identity, 'one', ranged, packets, policy, 'full', canonical)
  }
}

test('actual engine line ranges may join one unchanged complete source file only with a complete disjoint inventory', async context => {
  const fixture = await rangedFixture(context),
    packets = fixture.ranged.map(part => packetFor(part)),
    combined = fixture.combine(packets)
  assert.deepEqual(fixture.combine([...packets].reverse()), combined)
  const files = JSON.parse(combined.reportBytes).files
  assert.equal(files['src/api.ts'].source, evidence.sources.get('src/api.ts'))
  assert.equal(
    files['src/api.ts'].mutants.length,
    fixture.canonical.mutants.filter(mutant => mutant.fileName === 'src/api.ts').length
  )
  assert.equal(combined.receipt.metrics.valid, fixture.canonical.mutants.length)
  assert.equal(combined.receipt.metrics.score, 100)
  assert.throws(() => fixture.combine(packets.slice(1)), /Missing/)
  assert.throws(() => fixture.combine([packets[0], packets[0], ...packets.slice(1)]), /duplicate/)
})

test('joining a source file rejects cross-part canonical overlap and unequal complete source bytes', async context => {
  const fixture = await rangedFixture(context)
  const overlap = fixture.ranged.map(part => ({
    ...part,
    evidence: {
      ...part.evidence,
      sources: new Map(part.evidence.sources),
      mutants: [...part.evidence.mutants]
    }
  }))
  overlap[1].evidence.mutants.push(overlap[0].evidence.mutants[0])
  assert.throws(
    () =>
      combinePartitionEvidence(
        identity,
        'one',
        overlap,
        overlap.map(part => packetFor(part)),
        policy,
        'full',
        fixture.canonical
      ),
    /ownership overlaps/
  )
  const changed = fixture.ranged.map(part => ({
    ...part,
    evidence: { ...part.evidence, sources: new Map(part.evidence.sources) }
  }))
  changed[1].evidence.sources.set(
    'src/api.ts',
    evidence.sources.get('src/api.ts') + '// changed complete source\n'
  )
  assert.throws(
    () =>
      combinePartitionEvidence(
        identity,
        'one',
        changed,
        changed.map(part => packetFor(part)),
        policy,
        'full',
        fixture.canonical
      ),
    /different complete metadata or source/
  )
})

test('component-partition configuration is independently verified before canonical score aggregation', () => {
  const selected = parts.map((part, index) => ({
    ...part,
    evidence: {
      ...part.evidence,
      config: {
        ...part.evidence.config,
        jest: {
          config: { testMatch: [`<rootDir>/test/component-${index}.test.ts`] }
        }
      }
    }
  }))
  const packets = selected.map(part => packetFor(part))
  const combined = combinePartitionEvidence(
    identity,
    'one',
    selected,
    packets,
    policy,
    'full',
    evidence
  )
  assert.deepEqual(JSON.parse(combined.reportBytes).config, evidence.config)
  assert.equal(combined.receipt.metrics.valid, 10)
  assert.equal(combined.receipt.metrics.score, 100)
  const stale = selected.map(part => ({
    ...part,
    evidence: {
      ...part.evidence,
      config: {
        ...part.evidence.config,
        jest: {
          config: { testMatch: ['<rootDir>/test/another.test.ts'] }
        }
      }
    }
  }))
  assert.throws(
    () => combinePartitionEvidence(identity, 'one', stale, packets, policy, 'full', evidence),
    /configuration|config/
  )
})

test('line-split parts of one file merge into the exact canonical inventory and fail on gaps or duplicates', () => {
  const key = mutant =>
    JSON.stringify([
      mutant.location.start.line,
      mutant.location.start.column,
      mutant.mutatorName,
      mutant.replacement
    ])
  const api = evidence.mutants.filter(mutant => mutant.fileName === 'src/api.ts')
  assert.ok(api.length >= 2)
  const half = Math.floor(api.length / 2)
  const slice = (id, file, mutants) => ({
    id,
    evidence: {
      ...evidence,
      sources: new Map([[file, evidence.sources.get(file)]]),
      mutants,
      config: { ...evidence.config, mutate: [`${file}:${id}`] }
    }
  })
  const lineParts = [
    slice('api-1', 'src/api.ts', api.slice(0, half)),
    slice('api-2', 'src/api.ts', api.slice(half)),
    slice(
      'other',
      'src/other.ts',
      evidence.mutants.filter(mutant => mutant.fileName === 'src/other.ts')
    )
  ]
  const packet = part => {
    const value = report()
    value.config = structuredClone(part.evidence.config)
    const owned = new Set(part.evidence.mutants.map(key))
    value.files = Object.fromEntries(
      Object.entries(value.files)
        .filter(([file]) => part.evidence.sources.has(file))
        .map(([file, result]) => [
          file,
          { ...result, mutants: result.mutants.filter(mutant => owned.has(key(mutant))) }
        ])
    )
    let index = 0
    for (const file of Object.values(value.files))
      for (const mutant of file.mutants) {
        mutant.id = String(index++)
        mutant.status = 'Killed'
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
        { policy, mode: 'full', evidence: part.evidence }
      )
    }
  }
  const merge = (planned, packets) =>
    combinePartitionEvidence(identity, 'one', planned, packets, policy, 'full', evidence)
  const packets = lineParts.map(packet)
  const result = merge(lineParts, packets)
  assert.equal(result.receipt.metrics.valid, evidence.mutants.length)
  const merged = JSON.parse(result.reportBytes).files['src/api.ts'].mutants
  assert.equal(merged.length, api.length)
  assert.equal(new Set(merged.map(mutant => mutant.id)).size, api.length)
  assert.deepEqual(merge(lineParts, [...packets].reverse()).receipt, result.receipt)
  assert.throws(() => merge(lineParts, packets.slice(1)), /Missing/)

  // A part that re-tests a neighbour's mutant double-counts the file and fails.
  const overlapping = [
    slice('api-1', 'src/api.ts', api.slice(0, half + 1)),
    lineParts[1],
    lineParts[2]
  ]
  assert.throws(
    () => merge(overlapping, overlapping.map(packet)),
    /canonical mutant ownership overlaps/
  )
})
