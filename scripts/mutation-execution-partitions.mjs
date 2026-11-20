#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { canonicalInventory, targetSources, mutantTuple } from './mutation-final-qualification.mjs'
import { canonicalMutationPartitions, schedulingTopology } from './mutation-partitions.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUTPUT = 'governance/mutation-testing/execution-partitions.json'
// The first twenty original units passed their initial run, then exhausted
// their existing job envelopes in run39466463041. The retirement unit also
// exhausted an unchanged 45-minute local envelope after its 108-case dry run.
// The bootstrap unit now passes its original 300-second initial run, but its
// complete 499-mutant diagnostic exceeded a shorter 900-second observer cap.
// Its explicit hint bounds scheduling work while retaining the complete corpus.
// Only execution placement changes here; final hosted qualification is required.
const reviewedUnits = [
  ['wallet-snapshot-remote-reader', 'lease'],
  ['wallet-snapshot-remote-reader', 'admission'],
  ['wallet-snapshot-remote-reader', 'page'],
  ['wallet-snapshot-remote-reader', 'rows'],
  ['wallet-portable-packed-row', 'whole'],
  ['wallet-portable-source-stream', 'whole'],
  ['wallet-portable-json-stream', 'whole'],
  ['wallet-portable-knex-source', 'whole'],
  ['wallet-portable-brc39-frame', 'whole'],
  ['wallet-current-brc38-import-existing-rows', 'whole'],
  ['wallet-current-brc38-import-history', 'whole'],
  ['wallet-current-brc38-import-merge-checkpoint-node', 'whole'],
  ['wallet-current-brc38-import-page', 'whole'],
  ['wallet-current-brc38-import-target-indexes', 'whole'],
  ['wallet-current-brc38-portable-rows', 'whole'],
  ['wallet-current-brc38-profile-physical-identity-node', 'whole'],
  ['wallet-current-knex-database-system', 'whole'],
  ['wallet-current-snapshot-journal-delta-frame', 'whole'],
  ['wallet-current-snapshot-journal-delta-page', 'whole'],
  ['wallet-current-snapshot-journal-destination-stage', 'whole'],
  ['wallet-current-snapshot-journal-identity-retirements', 'whole'],
  ['wallet-retained-snapshot', 'sqlite-bootstrap', 100]
]
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
const tuple = mutant => mutantTuple(mutant.fileName, mutant)
const sourceFile = specification => specification.replace(/:\d+(?:-\d+)?$/, '')

export async function buildExecutionPartitionPlan(root = ROOT) {
  const targets = buildMutationTargets(root),
    units = []
  for (const [targetId, existingPartition, reviewedPackingHint] of reviewedUnits) {
    const target = targets[targetId]
    assert.ok(target, `Missing original execution target ${targetId}`)
    const base = canonicalMutationPartitions(targetId, target, false).find(
      part => part.id === existingPartition
    )
    assert.ok(base, `Missing original execution unit ${targetId}/${existingPartition}`)
    const directory = path.join(root, target.packageDirectory)
    const sources = targetSources(root, base.target)
    const inventory = await canonicalInventory(directory, sources, base.target.mutate)
    assert.ok(inventory.length > 0, 'Execution refinements require an actual canonical inventory')
    const byFile = new Map()
    for (const mutant of inventory) {
      const values = byFile.get(mutant.fileName) ?? []
      values.push(mutant)
      byFile.set(mutant.fileName, values)
    }
    const components = []
    // Canonical path and position ordering makes generation independent of the
    // host filesystem's directory enumeration and instrumentation ID order.
    for (const file of [...byFile.keys()].sort(lexical)) {
      const mutants = byFile
        .get(file)
        .sort(
          (left, right) =>
            left.location.start.line - right.location.start.line ||
            left.location.end.line - right.location.end.line
        )
      let component
      for (const mutant of mutants) {
        const start = mutant.location.start.line,
          end = mutant.location.end.line
        if (component === undefined || start > component.end) {
          component = { file, start, end, count: 0 }
          components.push(component)
        }
        component.end = Math.max(component.end, end)
        component.count++
      }
    }
    // Packing is a scheduling hint, never a runtime/test/quality allowance.
    // An indivisible parent span remains whole even when larger than the hint.
    const packingHint = reviewedPackingHint ?? (inventory.length <= 300 ? 100 : 250)
    const parts = []
    let pack = { mutate: [], count: 0 }
    for (const component of components) {
      if (pack.count > 0 && pack.count + component.count > packingHint) {
        parts.push(pack)
        pack = { mutate: [], count: 0 }
      }
      pack.mutate.push(`${component.file}:${component.start}-${component.end}`)
      pack.count += component.count
    }
    if (pack.count > 0) parts.push(pack)
    for (const specification of base.target.mutate)
      if (!byFile.has(sourceFile(specification))) parts[0].mutate.push(specification)
    const actual = []
    for (const [index, part] of parts.entries()) {
      const prefix = existingPartition === 'whole' ? 'range' : existingPartition
      part.id = `${prefix}-${String(index + 1).padStart(3, '0')}`
      const mutants = await canonicalInventory(directory, sources, part.mutate)
      assert.equal(mutants.length, part.count, 'Execution range changed canonical mutant count')
      actual.push(...mutants.map(tuple))
    }
    const expected = inventory.map(tuple)
    assert.equal(
      new Set(expected).size,
      expected.length,
      'Canonical mutant tuple collision requires review'
    )
    assert.equal(new Set(actual).size, actual.length, 'Execution mutant ownership overlaps')
    assert.deepEqual(
      actual.sort(lexical),
      expected.sort(lexical),
      'Execution union differs from complete canonical inventory'
    )
    units.push({
      target: targetId,
      existingPartition,
      packageDirectory: target.packageDirectory,
      originalMutate: base.target.mutate,
      sourceHashes: Object.fromEntries(
        [...sources.keys()].sort(lexical).map(file => [
          file,
          createHash('sha256')
            .update(fs.readFileSync(path.join(directory, file)))
            .digest('hex')
        ])
      ),
      canonicalCount: inventory.length,
      packingHint,
      parts
    })
  }
  const { executionRows } = schedulingTopology(targets, units)
  assert.ok(executionRows <= 256, 'Complete execution matrix exceeds the original 256-row ceiling')
  return {
    schemaVersion: 1,
    engine: '9.6.1',
    canonicalTargets: Object.keys(targets).length,
    executionRows,
    units
  }
}

export async function executionPartitionContent(root = ROOT) {
  const { format, resolveConfig } = await import('prettier')
  const output = path.join(root, OUTPUT)
  return await format(JSON.stringify(await buildExecutionPartitionPlan(root)), {
    ...(await resolveConfig(output)),
    filepath: output
  })
}

async function run() {
  const args = process.argv.slice(2)
  if (args.some(argument => argument !== '--check') || args.length > 1)
    throw new Error('Usage: node scripts/mutation-execution-partitions.mjs [--check]')
  const content = await executionPartitionContent()
  const output = path.join(ROOT, OUTPUT)
  if (args.includes('--check')) {
    assert.equal(fs.readFileSync(output, 'utf8'), content, 'Execution refinement manifest is stale')
    console.log('Verified complete source-bound execution plan with the pinned canonical engine')
  } else {
    fs.writeFileSync(output, content)
    console.log('Generated complete source-bound execution plan with the pinned canonical engine')
  }
}
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await run()
