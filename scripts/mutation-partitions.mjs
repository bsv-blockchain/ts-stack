import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const executionPlanPath = 'governance/mutation-testing/execution-partitions.json'

const partitionFile = specification => specification.replace(/:\d+(?:-\d+)?$/, '')
const plans = new Map([
  [
    'wallet-portable-canonical-chunks',
    {
      fallback: 'helpers',
      files: new Map([
        ['src/storage/portable/CanonicalPortableBounds.ts', 'bounds'],
        ['src/storage/portable/CanonicalPortableValue.ts', 'value'],
        ['src/storage/portable/CanonicalPortableParts.ts', 'parts'],
        ['src/storage/portable/CanonicalPortableChunks.ts', 'writer']
      ])
    }
  ],
  [
    'sdk-auth-http',
    {
      fallback: 'core',
      files: new Map([
        ['src/auth/clients/AuthFetch.ts', 'client'],
        ['src/auth/transports/SimplifiedFetchTransport.ts', 'transport']
      ])
    }
  ],
  [
    'wallet-snapshot-sync',
    {
      fallback: 'session',
      files: new Map([
        ['src/utility/runInSeries.ts', 'session'],
        ['src/storage/sync/syncSession.ts', 'session'],
        ['src/storage/snapshot/SnapshotSync.ts', 'session'],
        ['src/storage/sync/syncCheckpoint.ts', 'checkpoint'],
        ['src/storage/snapshot/runSnapshotSyncSession.ts', 'copy'],
        ['src/storage/StorageKnex.ts', 'storage'],
        ['src/storage/WalletStorageManager.ts', 'primary']
      ])
    }
  ],
  [
    'wallet-retained-snapshot',
    {
      fallback: 'lifecycle',
      files: new Map([
        ['src/storage/snapshot/KnexWalletReadSnapshot.ts', 'reader'],
        ['src/storage/schema/snapshotProfileIndexMigration.ts', 'profile-index'],
        ['src/storage/schema/snapshotRelationIndexMigration.ts', 'relation-index'],
        ['src/storage/schema/snapshotCertificateIndexMigration.ts', 'certificate-index'],
        ['src/storage/schema/snapshotGlobalIndexMigration.ts', 'global-index'],
        ['src/storage/schema/snapshotGlobalIndexModel.ts', 'global-index'],
        ['src/storage/schema/snapshotGlobalIndexMysql.ts', 'global-mysql'],
        ['src/storage/schema/snapshotGlobalIndexSqlite.ts', 'global-sqlite'],
        ['src/storage/schema/snapshotSqliteSchemaObservations.ts', 'global-sqlite'],
        ['src/storage/schema/snapshotGlobalIndexBootstrap.ts', 'global-bootstrap'],
        ['src/storage/schema/snapshotGlobalIndexTriggers.ts', 'global-triggers'],
        ['src/storage/schema/snapshotSqliteIdentity.ts', 'sqlite-identity'],
        ['src/storage/schema/snapshotSqliteIdentityObservations.ts', 'sqlite-identity'],
        ['src/storage/schema/snapshotSqliteMembership.ts', 'sqlite-membership'],
        ['src/storage/schema/snapshotSqliteIndexGeneration.ts', 'sqlite-generation'],
        ['src/storage/schema/snapshotSqliteIndexBootstrap.ts', 'sqlite-bootstrap'],
        ['src/storage/schema/snapshotSqliteIndexState.ts', 'sqlite-bootstrap'],
        ['src/storage/schema/snapshotSqliteIndexRetirement.ts', 'sqlite-retirement'],
        ['src/storage/schema/snapshotSqliteLegacyOwnership.ts', 'sqlite-generation'],
        ['src/storage/schema/snapshotSqliteIndexMigration.ts', 'sqlite-retirement'],
        ['src/storage/StorageKnex.ts', 'storage'],
        ['src/storage/StorageProvider.ts', 'storage']
      ])
    }
  ],
  [
    'wallet-snapshot-journal',
    {
      fallback: 'revision',
      files: new Map([
        ['src/storage/snapshot/journal/SnapshotJournalRevision.ts', 'revision'],
        ['src/storage/snapshot/journal/SnapshotJournalRevisionSql.ts', 'revision'],
        ['src/storage/snapshot/journal/SnapshotJournalPage.ts', 'page'],
        ['src/storage/snapshot/journal/SnapshotJournalSqliteClock.ts', 'clock'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlClock.ts', 'clock'],
        ['src/storage/snapshot/journal/SnapshotJournalSqliteObservers.ts', 'sqlite-observers'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlObservers.ts', 'mysql-observers'],
        ['src/storage/snapshot/journal/SnapshotJournalBootstrap.ts', 'bootstrap'],
        ['src/storage/snapshot/journal/SnapshotJournalHighWater.ts', 'high-water'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlSource.ts', 'mysql-source'],
        ['src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.ts', 'sqlite-generation'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlIntent.ts', 'mysql-intent'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.ts', 'mysql-generation'],
        ['src/storage/snapshot/journal/SnapshotJournalReceipt.ts', 'receipts'],
        ['src/storage/snapshot/journal/SnapshotJournalCaptureFence.ts', 'capture-fence'],
        ['src/storage/snapshot/journal/SnapshotJournalConnections.ts', 'connections'],
        ['src/storage/snapshot/journal/SnapshotJournalCaptureBackend.ts', 'capture-backend'],
        ['src/storage/snapshot/journal/SnapshotJournalCapture.ts', 'capture'],
        ['src/storage/snapshot/journal/SnapshotJournalCollection.ts', 'collection'],
        ['src/storage/snapshot/journal/SnapshotJournalMaintenance.ts', 'maintenance'],
        ['src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.ts', 'maintenance-fence'],
        ['src/storage/snapshot/journal/SnapshotJournalMaintenanceTask.ts', 'maintenance-task']
      ])
    }
  ],
  [
    'wallet-snapshot-archive',
    {
      fallback: 'capture',
      files: new Map([
        ['src/storage/snapshot/archive/KnexSnapshotArchiveStore.ts', 'store'],
        ['src/storage/schema/snapshotArchiveMigration.ts', 'store'],
        ['src/storage/snapshot/archive/KnexSnapshotArchiveSource.ts', 'source'],
        ['src/storage/snapshot/archive/KnexSnapshotArchiveClosure.ts', 'source']
      ])
    }
  ],
  [
    'wallet-snapshot-remote-http',
    {
      fallback: 'protocol',
      files: new Map([
        ['src/storage/remoting/StorageServer.ts', 'server'],
        ['src/storage/remoting/StorageClientBase.ts', 'client']
      ])
    }
  ],
  [
    'wallet-snapshot-remote-service',
    {
      fallback: 'persistence',
      files: new Map([
        ['src/storage/snapshot/archive/KnexSnapshotArchiveService.ts', 'controller'],
        ['src/storage/snapshot/archive/SnapshotArchiveGuard.ts', 'guard'],
        ['src/storage/snapshot/archive/SnapshotArchiveGuardRegistry.ts', 'guard'],
        ['src/storage/snapshot/archive/SnapshotArchiveGuardBackend.ts', 'backend']
      ])
    }
  ],
  [
    'wallet-snapshot-remote-reader',
    {
      fallback: 'admission',
      files: new Map([
        ['src/storage/snapshot/archive/RemoteSnapshotLease.ts', 'lease'],
        ['src/storage/snapshot/archive/RemoteSnapshotRows.ts', 'rows'],
        ['src/storage/snapshot/archive/RemoteSnapshotPageReader.ts', 'page'],
        ['src/storage/snapshot/archive/openRemoteSnapshot.ts', 'page'],
        ['src/storage/snapshot/SnapshotCursor.ts', 'page']
      ])
    }
  ]
])

const upstreamPlans = new Map([
  [
    'sdk-auth-http',
    {
      fallback: 'core',
      files: new Map([
        ['src/auth/Peer.ts', 'peer'],
        ['src/auth/clients/AuthFetch.ts', 'client'],
        ['src/auth/transports/SimplifiedFetchTransport.ts', 'transport']
      ]),
      lines: new Map([
        [
          'src/auth/AuthMessageValidation.ts',
          [
            ['core', null],
            ['core-snapshot', 'export function snapshotAuthMessage('],
            ['core-policy', '  const isGeneral =']
          ]
        ]
      ])
    }
  ],
  [
    'wallet-retained-snapshot',
    {
      fallback: 'lifecycle',
      files: new Map([
        ['src/storage/snapshot/KnexWalletReadSnapshot.ts', 'reader'],
        ['src/storage/StorageKnex.ts', 'storage'],
        ['src/storage/StorageProvider.ts', 'storage']
      ])
    }
  ],
  [
    'brc52-envelope',
    {
      fallback: 'envelope-1',
      lines: new Map([
        [
          'src/brc52/envelope.ts',
          [
            ['envelope-1', null],
            ['envelope-2', 'function exactKeys('],
            ['envelope-3', 'function strictSignature('],
            ['envelope-4', 'function graph('],
            ['envelope-5', 'export function validateBRC52Disclosure('],
            ['envelope-6', 'export function parseBRC52Envelope(']
          ]
        ]
      ])
    }
  ],
  [
    'brc52-status',
    {
      fallback: 'status-1',
      lines: new Map([
        [
          'src/brc52/status.ts',
          [
            ['status-1', null],
            ['status-2', 'function snapshotObservation(']
          ]
        ]
      ])
    }
  ],
  [
    'brc52-disclosure',
    {
      fallback: 'disclosure-1',
      lines: new Map([
        [
          'src/brc52/disclosure.ts',
          [
            ['disclosure-1', null],
            ['disclosure-2', 'function validateReceipt(']
          ]
        ]
      ])
    }
  ],
  [
    'air-gap-codec',
    {
      fallback: 'support',
      files: new Map([['src/encoder.ts', 'encoder']]),
      lines: new Map([
        [
          'src/decoder.ts',
          [
            ['decoder-1', null],
            ['decoder-2', '  private enterSession(']
          ]
        ]
      ])
    }
  ],
  [
    'mandala-encoding',
    {
      fallback: 'mandala',
      files: new Map([
        ['src/strictCbor.ts', 'cbor'],
        ['src/Bsv21Binary.ts', 'bsv21']
      ])
    }
  ],
  [
    'webrtpay-frames',
    {
      fallback: 'frames-1',
      lines: new Map([
        [
          'src/channel/frames.ts',
          [
            ['frames-1', null],
            ['frames-2', 'class StructureCounts {']
          ]
        ]
      ])
    }
  ],
  [
    'webrtpay-codes',
    {
      fallback: 'codes',
      files: new Map([['src/codec/sdp.ts', 'sdp']])
    }
  ]
])

function specificationLines(specification, lineCount) {
  const range = /:(\d+)(?:-(\d+))?$/.exec(specification)
  if (!range) return [1, lineCount]
  return [Number(range[1]), Number(range[2] ?? range[1])]
}

// A line plan cuts one file at explicit declaration markers. Each marker must
// start exactly one source line, so an edit that moves or duplicates it fails
// closed instead of silently shifting mutants between execution parts.
function lineSegments(target, file, cuts) {
  if (typeof target.packageDirectory !== 'string')
    throw new Error('Line-split mutation partition requires a package directory')
  const lines = fs
    .readFileSync(path.resolve(ROOT, target.packageDirectory, file), 'utf8')
    .split('\n')
  if (cuts.length < 2 || cuts[0][1] !== null)
    throw new Error('Line-split mutation partition must start at the first source line')
  const starts = cuts.map(([id, marker]) => {
    if (marker === null) return { id, line: 1 }
    const matches = lines.flatMap((line, index) => (line.startsWith(marker) ? [index + 1] : []))
    if (matches.length !== 1)
      throw new Error(`Mutation partition marker must start exactly one line in ${file}: ${marker}`)
    return { id, line: matches[0] }
  })
  for (let index = 1; index < starts.length; index += 1)
    if (starts[index].line <= starts[index - 1].line)
      throw new Error(`Mutation partition markers are out of order in ${file}`)
  return {
    lineCount: lines.length,
    segments: starts.map((start, index) => ({
      id: start.id,
      first: start.line,
      last: index + 1 < starts.length ? starts[index + 1].line - 1 : lines.length
    }))
  }
}

// Keep each file's complete original range union across its execution parts.
// File plans keep a whole file in one part; line plans intersect every original
// range with contiguous segments that cover the file. New canonical files join
// the target's fallback; a future helper cannot disappear.
// Targets without an explicit plan split by file automatically once they are
// slow. Mutant count does not predict time (tests dominate: 676 auth mutants
// take under two minutes while 358 envelope mutants took fifteen), so the
// estimate is the target's measured hosted seconds. A target never measured
// uses a deliberately pessimistic code-line estimate: an unneeded split costs
// one job's setup, a missed split holds the whole campaign.
const AUTO_PART_SECONDS = 240
const UNMEASURED_SECONDS_PER_CODE_LINE = 1
let measuredSeconds
function measuredTargetSeconds(targetId) {
  measuredSeconds ??= JSON.parse(
    fs.readFileSync(path.join(ROOT, 'governance/mutation-testing/durations.json'), 'utf8')
  ).seconds
  const parts = Object.entries(measuredSeconds).filter(([key]) => key.startsWith(`${targetId}/`))
  return parts.length === 0 ? undefined : parts.reduce((sum, [, value]) => sum + value, 0)
}

const DECLARATION_MODIFIERS = new Set(['export', 'default', 'declare', 'async', 'abstract'])
const DECLARATION_KEYWORDS = new Set([
  'function',
  'function*',
  'class',
  'const',
  'let',
  'var',
  'interface',
  'type',
  'enum'
])

// A top-level declaration starts at column zero with optional modifiers.
function isTopLevelDeclaration(line) {
  if (/^\s/.test(line)) return false
  const words = line.split(/[\s(<{=:]+/)
  let index = 0
  while (DECLARATION_MODIFIERS.has(words[index])) index += 1
  return DECLARATION_KEYWORDS.has(words[index])
}

function isCode(line) {
  const text = line.trim()
  return text !== '' && !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')
}

// Per-line weight of a file: 1 for a code line inside any of the target's
// original ranges for that file, else 0.
function fileLineWeights(target, file, specifications) {
  const lines = fs
    .readFileSync(path.resolve(ROOT, target.packageDirectory, file), 'utf8')
    .split('\n')
  const weights = Array.from({ length: lines.length }, () => 0)
  for (const specification of specifications) {
    const [first, last] = specificationLines(specification, lines.length)
    for (let index = first - 1; index < Math.min(last, lines.length); index += 1)
      if (isCode(lines[index])) weights[index] = 1
  }
  return { lines, weights }
}

// Cut a file into `pieces` contiguous segments at top-level declaration lines,
// balancing code weight. A mutant cannot span two top-level statements, and a
// cut line must be a unique line prefix so lineSegments can re-find it.
function fileSegments(lines, weights, pieces) {
  const before = [0]
  for (const weight of weights) before.push(before.at(-1) + weight)
  const total = before.at(-1)
  const candidates = lines
    .map((line, index) => index)
    .filter(
      index =>
        index > 0 &&
        isTopLevelDeclaration(lines[index]) &&
        lines.filter(other => other.startsWith(lines[index])).length === 1
    )
  // For each boundary pick the candidate whose preceding weight is nearest its
  // even share, keeping cuts strictly increasing.
  const starts = [0]
  for (let piece = 1; piece < pieces; piece += 1) {
    const goal = (total * piece) / pieces
    let best
    for (const index of candidates) {
      if (index <= starts.at(-1)) continue
      if (best === undefined || Math.abs(before[index] - goal) < Math.abs(before[best] - goal))
        best = index
    }
    if (best === undefined) break
    starts.push(best)
  }
  return starts
    .map((start, position) => {
      const end = position + 1 < starts.length ? starts[position + 1] : lines.length
      return { marker: position === 0 ? null : lines[start], weight: before[end] - before[start] }
    })
    .filter((segment, position) => position === 0 || segment.weight > 0)
}

function filesOf(target) {
  const byFile = new Map()
  for (const specification of target.mutate) {
    const file = partitionFile(specification)
    if (/[!*?{}[\]]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..'))
      return undefined
    byFile.set(file, [...(byFile.get(file) ?? []), specification])
  }
  return byFile
}

const sum = values => values.reduce((total, value) => total + value, 0)
const unitOrder = unit => `${unit.file}\u0000${String(unit.position).padStart(6, '0')}`

// Heaviest unit first into the lightest group; ties keep source order. Groups
// are then numbered by their first unit so the plan is stable.
function groupUnits(units, count) {
  const groups = Array.from({ length: count }, () => ({ weight: 0, units: [] }))
  const ordered = [...units].sort(
    (left, right) => right.weight - left.weight || unitOrder(left).localeCompare(unitOrder(right))
  )
  for (const unit of ordered) {
    const lightest = groups.reduce(
      (best, group) => (group.weight < best.weight ? group : best),
      groups[0]
    )
    lightest.units.push(unit)
    lightest.weight += unit.weight
  }
  for (const group of groups)
    group.units.sort((left, right) => unitOrder(left).localeCompare(unitOrder(right)))
  return groups
    .filter(group => group.units.length !== 0)
    .sort((left, right) => unitOrder(left.units[0]).localeCompare(unitOrder(right.units[0])))
}

function planFromGroups(files, units, groups) {
  const owner = new Map()
  groups.forEach((group, index) => {
    for (const unit of group.units) owner.set(`${unit.file}#${unit.position}`, `auto-${index + 1}`)
  })
  const plan = { fallback: 'auto-1', files: new Map(), lines: new Map() }
  for (const file of files) {
    const segments = units.filter(unit => unit.file === file)
    if (segments.length === 1) plan.files.set(file, owner.get(`${file}#0`))
    else
      plan.lines.set(
        file,
        segments.map(segment => [owner.get(`${file}#${segment.position}`), segment.marker])
      )
  }
  return plan
}

export function automaticPlan(targetId, target, measured = measuredTargetSeconds(targetId)) {
  if (typeof target.packageDirectory !== 'string') return undefined
  const byFile = filesOf(target)
  if (!byFile) return undefined
  const files = [...byFile].map(([file, specifications]) => ({
    file,
    ...fileLineWeights(target, file, specifications)
  }))
  const total = sum(files.map(entry => sum(entry.weights)))
  if (total === 0) return undefined
  const estimate = measured ?? total * UNMEASURED_SECONDS_PER_CODE_LINE
  // A file whose share of the estimate exceeds one part is cut inside.
  const units = files.flatMap(entry => {
    const share = (estimate * sum(entry.weights)) / total
    const pieces = Math.max(1, Math.ceil(share / AUTO_PART_SECONDS))
    return fileSegments(entry.lines, entry.weights, pieces).map((segment, position) => ({
      file: entry.file,
      position,
      ...segment
    }))
  })
  const count = Math.min(units.length, Math.ceil(estimate / AUTO_PART_SECONDS))
  if (count < 2) return undefined
  return planFromGroups(byFile.keys(), units, groupUnits(units, count))
}

// Keep each file's complete original range union in exactly one execution part.
// New canonical files join the target's fallback; a future helper cannot disappear.
export function canonicalMutationPartitions(targetId, target, scheduled = true) {
  const plan = plans.get(targetId) ?? (scheduled ? scheduledPlan(targetId, target) : undefined)
  if (!plan) return [{ id: 'whole', target }]
  return partitionsWithPlan(target, plan)
}

function partitionsWithPlan(target, plan) {
  const groups = new Map()
  const add = (id, specification) => {
    const mutate = groups.get(id) ?? []
    mutate.push(specification)
    groups.set(id, mutate)
  }
  const split = new Map()
  for (const specification of target.mutate) {
    const file = partitionFile(specification)
    if (/[!*?{}[\]]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..'))
      throw new Error('Mutation partition requires explicit canonical source paths')
    const cuts = plan.lines?.get(file)
    if (!cuts) {
      add(plan.files?.get(file) ?? plan.fallback, specification)
      continue
    }
    if (!split.has(file)) split.set(file, lineSegments(target, file, cuts))
    const { lineCount, segments } = split.get(file)
    const [first, last] = specificationLines(specification, lineCount)
    for (const segment of segments) {
      const from = Math.max(first, segment.first)
      const to = Math.min(last, segment.last)
      if (from <= to) add(segment.id, `${file}:${from}-${to}`)
    }
  }
  if (groups.size === 0) throw new Error('Empty canonical mutation source union')
  return [...groups].map(([id, mutate]) => ({ id, target: { ...target, mutate } }))
}

function sourceSpecification(specification) {
  if (typeof specification !== 'string') throw new Error('Invalid execution source specification')
  const match = /^(.*?)(?::([1-9]\d*)(?:-([1-9]\d*))?)?$/.exec(specification)
  const file = match?.[1]
  if (
    !file ||
    file.includes('\\') ||
    /[!*?{}[\]:]/.test(file) ||
    path.posix.isAbsolute(file) ||
    file.split('/').includes('..')
  )
    throw new Error('Execution refinements require explicit canonical source paths')
  const start = match[2] === undefined ? 1 : Number(match[2])
  const end = match[2] === undefined ? Infinity : Number(match[3] ?? match[2])
  if (
    !Number.isSafeInteger(start) ||
    start < 1 ||
    (end !== Infinity && !Number.isSafeInteger(end)) ||
    end < start
  )
    throw new Error('Invalid execution source range')
  return { file, start, end }
}

// Configuration validation only. The installed-engine replay and unchanged
// complete canonical aggregate prove mutant ownership, not these line numbers.
export function refineMutationPartition(base, unit, readSource) {
  if (
    unit.packageDirectory !== base.target.packageDirectory ||
    !Array.isArray(unit.originalMutate) ||
    !unit.sourceHashes ||
    typeof unit.sourceHashes !== 'object' ||
    Array.isArray(unit.sourceHashes) ||
    !Array.isArray(unit.parts) ||
    unit.parts.length === 0 ||
    !Number.isSafeInteger(unit.canonicalCount) ||
    unit.canonicalCount < 1
  )
    throw new Error('Invalid source-bound execution refinement')
  const known = new Set(
    unit.originalMutate.map(specification => sourceSpecification(specification).file)
  )
  if (
    !isDeepStrictEqual(
      [...known].sort((left, right) => left.localeCompare(right)),
      Object.keys(unit.sourceHashes).sort((left, right) => left.localeCompare(right))
    )
  )
    throw new Error('Execution source hash inventory differs from original specifications')
  const actual = base.target.mutate.map(specification => ({
    specification,
    ...sourceSpecification(specification)
  }))
  if (
    !isDeepStrictEqual(
      actual.filter(value => known.has(value.file)).map(value => value.specification),
      unit.originalMutate
    )
  )
    throw new Error(
      'Canonical execution specifications changed; regenerate the reviewed execution plan'
    )
  const lines = new Map()
  for (const file of known) {
    const bytes = readSource(file),
      expected = unit.sourceHashes[file]
    if (
      typeof expected !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      createHash('sha256').update(bytes).digest('hex') !== expected
    )
      throw new Error(`Execution source changed: ${file}; regenerate the reviewed execution plan`)
    lines.set(file, bytes.toString('utf8').split('\n').length)
  }
  const owners = new Map(),
    ids = new Set(),
    covered = new Set()
  let count = 0
  const parts = unit.parts.map(part => {
    if (
      typeof part.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(part.id) ||
      part.id === 'whole' ||
      ids.has(part.id) ||
      !Array.isArray(part.mutate) ||
      part.mutate.length === 0 ||
      !Number.isSafeInteger(part.count) ||
      part.count < 1
    )
      throw new Error('Missing or duplicate execution refinement identity')
    ids.add(part.id)
    count += part.count
    for (const specification of part.mutate) {
      const { file, start, end } = sourceSpecification(specification)
      if (
        !known.has(file) ||
        start > lines.get(file) ||
        (end !== Infinity && end > lines.get(file))
      )
        throw new Error('Execution range lies outside its complete canonical source')
      const previous = owners.get(file) ?? []
      if (previous.some(value => value.id !== part.id && start <= value.end && value.start <= end))
        throw new Error('Execution source ranges overlap across partitions')
      previous.push({ start, end, id: part.id })
      owners.set(file, previous)
      covered.add(file)
    }
    return { id: part.id, target: { ...base.target, mutate: [...part.mutate] } }
  })
  if (count !== unit.canonicalCount || covered.size !== known.size)
    throw new Error('Execution refinement omits canonical source or mutant inventory')
  // Future canonical helpers remain owned in full; they cannot silently vanish.
  parts[0].target.mutate.push(
    ...actual.filter(value => !known.has(value.file)).map(value => value.specification)
  )
  return parts
}

// A component selection is bound to one complete original source partition.
// The canonical target keeps its entire test universe for affected selection and
// independent CI; only this partition's repeated mutation execution changes.
export function applyPartitionComponentTests(base, selection, readSource) {
  const target = base.target
  if (
    !selection ||
    typeof selection !== 'object' ||
    !isDeepStrictEqual(selection.mutate, target.mutate) ||
    !selection.sourceHashes ||
    typeof selection.sourceHashes !== 'object' ||
    Array.isArray(selection.sourceHashes) ||
    !Array.isArray(selection.tests) ||
    selection.tests.length === 0 ||
    new Set(selection.tests).size !== selection.tests.length
  )
    throw new Error('Invalid source-bound component selection')
  const files = [...new Set(target.mutate.map(value => sourceSpecification(value).file))].sort(
    (left, right) => left.localeCompare(right)
  )
  if (
    !isDeepStrictEqual(
      files,
      Object.keys(selection.sourceHashes).sort((left, right) => left.localeCompare(right))
    )
  )
    throw new Error('Component source inventory differs')
  for (const file of files) {
    const expected = selection.sourceHashes[file]
    if (
      typeof expected !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      createHash('sha256').update(readSource(file)).digest('hex') !== expected
    )
      throw new Error('Component source changed; review its selection and coverage')
  }
  const config = target.runnerOptions?.jest?.config
  const property = target.propertyTest?.slice(target.packageDirectory.length + 1)
  if (
    !config ||
    !Array.isArray(config.testMatch) ||
    !selection.tests.includes(property) ||
    selection.tests.some(
      file =>
        typeof file !== 'string' ||
        file.includes('\\') ||
        path.posix.isAbsolute(file) ||
        /[!*?{}[\]:]/.test(file) ||
        file.split('/').some(part => part === '.' || part === '..') ||
        target.requiredFunctionalTests?.includes(file) ||
        !config.testMatch.some(pattern => path.matchesGlob('<rootDir>/' + file, pattern))
    )
  )
    throw new Error('Component tests omit a property or escape the original universe')
  return {
    ...base,
    target: {
      ...target,
      runnerOptions: {
        ...target.runnerOptions,
        jest: {
          ...target.runnerOptions.jest,
          config: {
            ...config,
            testMatch: selection.tests.map(file => '<rootDir>/' + file)
          }
        }
      }
    }
  }
}

function executionPartitions(targetId, target, scheduled) {
  const original = canonicalMutationPartitions(targetId, target, scheduled)
  const selections = target.componentTestPartitions ?? {}
  if (
    typeof selections !== 'object' ||
    Array.isArray(selections) ||
    Object.keys(selections).some(id => !original.some(part => part.id === id))
  )
    throw new Error('Unknown component execution partition')
  const base = original.map(part =>
    selections[part.id] === undefined
      ? part
      : applyPartitionComponentTests(part, selections[part.id], file =>
          fs.readFileSync(path.join(ROOT, target.packageDirectory, file))
        )
  )
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, executionPlanPath), 'utf8'))
  if (plan.schemaVersion !== 1 || plan.engine !== '9.6.1' || !Array.isArray(plan.units))
    throw new Error('Missing reviewed execution refinement manifest')
  const units = plan.units.filter(unit => unit.target === targetId)
  const identities = new Set(units.map(unit => unit.existingPartition))
  if (
    identities.size !== units.length ||
    units.some(unit => !base.some(part => part.id === unit.existingPartition))
  )
    throw new Error('Unknown or duplicate original execution partition')
  const parts = base.flatMap(part => {
    const unit = units.find(value => value.existingPartition === part.id)
    return unit === undefined
      ? [part]
      : refineMutationPartition(part, unit, file =>
          fs.readFileSync(path.join(ROOT, target.packageDirectory, file))
        )
  })
  if (new Set(parts.map(part => part.id)).size !== parts.length)
    throw new Error('Execution refinement identities collide')
  return parts
}

// Plan against the complete registry, never a PR's selected subset. Reviewed
// file/span ownership is fixed first. Optional upstream scheduling refinements
// are admitted only while the original matrix ceiling has room. A target that
// does not fit still runs its complete original canonical source and tests.
// This changes scheduling, not the quality denominator or execution limits.
export function admitSchedulingPlans(baseRows, candidates, ceiling = 256) {
  if (!Number.isSafeInteger(baseRows) || baseRows < 0 || baseRows > ceiling)
    throw new Error('Required mutation execution topology exceeds the matrix ceiling')
  const admitted = new Map()
  let rows = baseRows
  const seen = new Set()
  for (const { targetId, plan, parts } of candidates) {
    if (!Number.isSafeInteger(parts) || parts < 1 || seen.has(targetId))
      throw new Error('Invalid optional mutation scheduling candidate')
    seen.add(targetId)
    if (rows + parts - 1 > ceiling) continue
    admitted.set(targetId, plan)
    rows += parts - 1
  }
  return admitted
}
// Scheduling can be regenerated while source hashes in the previous manifest
// are stale. Count required topology here; actual execution still validates
// every source hash and range in executionPartitions/refineMutationPartition.
export function schedulingTopology(targets, units) {
  if (!Array.isArray(units)) throw new Error('Missing reviewed scheduling units')
  const required = new Map(
    Object.entries(targets).map(([id, target]) => [
      id,
      canonicalMutationPartitions(id, target, false)
    ])
  )
  let rows = [...required.values()].reduce((count, parts) => count + parts.length, 0)
  const protectedTargets = new Set()
  const seen = new Set()
  for (const unit of units) {
    const key = `${unit.target}/${unit.existingPartition}`
    if (
      seen.has(key) ||
      !required.get(unit.target)?.some(part => part.id === unit.existingPartition) ||
      !Array.isArray(unit.parts) ||
      unit.parts.length === 0
    )
      throw new Error('Unknown or duplicate required scheduling unit')
    seen.add(key)
    protectedTargets.add(unit.target)
    rows += unit.parts.length - 1
  }
  const candidates = []
  for (const [id, target] of Object.entries(targets)) {
    if (plans.has(id) || protectedTargets.has(id)) continue
    const plan = upstreamPlans.get(id) ?? automaticPlan(id, target)
    if (!plan) continue
    candidates.push({ targetId: id, plan, parts: partitionsWithPlan(target, plan).length })
  }
  const admitted = admitSchedulingPlans(rows, candidates)
  return {
    admitted,
    executionRows:
      rows +
      candidates.reduce(
        (extra, candidate) => extra + (admitted.has(candidate.targetId) ? candidate.parts - 1 : 0),
        0
      )
  }
}
let registryScheduling
function scheduledPlan(targetId, target) {
  if (registryScheduling === undefined) {
    const targets = buildMutationTargets(ROOT)
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, executionPlanPath), 'utf8'))
    registryScheduling = { targets, ...schedulingTopology(targets, manifest.units) }
  }
  const registered = registryScheduling.targets[targetId]
  if (
    registered &&
    registered.packageDirectory === target.packageDirectory &&
    isDeepStrictEqual(registered.mutate, target.mutate)
  )
    return registryScheduling.admitted.get(targetId)
  return upstreamPlans.get(targetId) ?? automaticPlan(targetId, target)
}
export function partitionMutationTarget(targetId, target) {
  return executionPartitions(targetId, target, true)
}

export function partitionedMutationTargets(selected, targets) {
  return [
    ...new Set(
      mutationExecutionMatrix(selected, targets)
        .include.filter(value => value.partition !== 'whole')
        .map(value => value.target)
    )
  ]
}

export function selectedMutationPartition(targetId, target, partition = 'whole') {
  if (partition === 'whole') return target
  const selected = partitionMutationTarget(targetId, target).find(value => value.id === partition)
  if (!selected) throw new Error(`Unknown mutation execution partition ${targetId}/${partition}`)
  return selected.target
}

export function mutationExecutionMatrix(selected, targets) {
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length)
    throw new Error('Missing or duplicate canonical target selection')
  return {
    include: selected.flatMap(targetId => {
      if (!Object.hasOwn(targets, targetId)) throw new Error('Unknown canonical mutation target')
      return partitionMutationTarget(targetId, targets[targetId]).map(({ id }) => ({
        target: targetId,
        partition: id,
        ...(targets[targetId].packageDirectory === 'packages/wallet/wallet-toolbox'
          ? { wallet_native: true }
          : {})
      }))
    })
  }
}

// Longest-processing-time-first scheduling: GitHub starts matrix jobs in listed
// order up to the concurrency limit, so list the slowest measured parts first
// and the short ones fill the remaining slots. Order only changes when a part
// starts, never which parts run. A part without a measurement (new or renamed)
// sorts first, so it can never be left as an unplanned tail.
export function longestFirst(matrix, seconds) {
  const cost = row => seconds[`${row.target}/${row.partition}`] ?? Number.MAX_SAFE_INTEGER
  return {
    include: matrix.include
      .map((row, index) => ({ row, index }))
      .sort((left, right) => cost(right.row) - cost(left.row) || left.index - right.index)
      .map(({ row }) => row)
  }
}
