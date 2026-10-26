import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const partitionFile = specification => specification.replace(/:\d+(?:-\d+)?$/, '')
const plans = new Map([
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
  const lines = readFileSync(path.resolve(ROOT, target.packageDirectory, file), 'utf8').split('\n')
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
const AUTO_PART_SECONDS = 180
const UNMEASURED_SECONDS_PER_CODE_LINE = 1
let measuredSeconds
function measuredTargetSeconds(targetId) {
  measuredSeconds ??= JSON.parse(
    readFileSync(path.join(ROOT, 'governance/mutation-testing/durations.json'), 'utf8')
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

const MEMBER_MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'async',
  'override',
  'get',
  'set'
])

// A method, constructor or accessor at exactly the class body indent.
function isMemberDeclaration(line) {
  if (!/^ {2}\S/.test(line)) return false
  const words = line.trim().split(/ +/)
  let index = 0
  while (MEMBER_MODIFIERS.has(words[index])) index += 1
  return /^(?:\* ?)?[#A-Za-z_$][\w$]* ?[(<]/.test(words.slice(index).join(' '))
}

// Keywords after which `/` starts a regular expression rather than division.
const EXPRESSION_KEYWORDS = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'case',
  'catch',
  'class',
  'const',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'of',
  'override',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'set',
  'static',
  'switch',
  'throw',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'yield'
])

function declarationKeyword(line) {
  return line.split(/[\s(<{=:]+/).find(word => !DECLARATION_MODIFIERS.has(word))
}

function scanState() {
  return {
    depth: 0,
    classDepth: 0,
    pendingClass: false,
    expectExpression: true,
    lineComment: false,
    modes: ['code'],
    interpolations: [],
    regexClass: false
  }
}

const currentMode = state => state.modes.at(-1)

function isClassBodyMember(state, line) {
  return (
    currentMode(state) === 'code' &&
    state.classDepth > 0 &&
    state.depth === state.classDepth &&
    isMemberDeclaration(line)
  )
}

// A block mutant covers its whole method, including a template that looks like
// another member, so a cut is safe only while the braces are still at the
// class body.
function classMemberLines(lines) {
  const members = new Set()
  const state = scanState()
  lines.forEach((line, index) => {
    if (isClassBodyMember(state, line)) members.add(index)
    scanLine(state, line)
  })
  return members
}

function scanLine(state, line) {
  if (currentMode(state) === 'code' && state.depth === 0 && isTopLevelDeclaration(line))
    state.pendingClass = declarationKeyword(line) === 'class'
  let index = 0
  while (index < line.length && !state.lineComment) index = scanAt(state, line, index) + 1
  state.lineComment = false
}

function scanAt(state, line, index) {
  const mode = currentMode(state)
  if (mode === 'block') return scanBlock(state, line, index)
  if (mode === 'single' || mode === 'double') return scanQuoted(state, line, index)
  if (mode === 'template') return scanTemplate(state, line, index)
  if (mode === 'regex') return scanRegex(state, line, index)
  return scanCode(state, line, index)
}

function scanCode(state, line, index) {
  const char = line[index]
  const next = line[index + 1]
  if (char === '/' && next === '/') {
    state.lineComment = true
    return index + 1
  }
  if (char === '/' && next === '*') {
    state.modes.push('block')
    return index + 1
  }
  if (char === '/' && state.expectExpression) {
    state.modes.push('regex')
    state.regexClass = false
    return index
  }
  if (char === '/') {
    state.expectExpression = true
    return index
  }
  if (char === "'" || char === '"') {
    pushQuote(state, char)
    return index
  }
  if (char === '`') {
    state.modes.push('template')
    return index
  }
  if (char === '{') return openBrace(state, index)
  if (char === '}') return closeBrace(state, index)
  if (/[A-Za-z_$]/.test(char)) return scanWord(state, line, index)
  if (/\d/.test(char)) return scanNumber(state, line, index)
  if (char === ' ' || char === '\t') return index
  return scanPunctuation(state, char, next, index)
}

function pushQuote(state, char) {
  state.modes.push(char === "'" ? 'single' : 'double')
}

function openBrace(state, index) {
  state.depth += 1
  if (state.pendingClass && state.depth === 1) {
    state.classDepth = state.depth
    state.pendingClass = false
  }
  state.expectExpression = true
  return index
}

function closeBrace(state, index) {
  const interpolation = state.interpolations.at(-1)
  if (interpolation !== undefined && state.depth === interpolation) {
    state.depth -= 1
    state.interpolations.pop()
    state.modes.pop()
    return index
  }
  state.depth -= 1
  if (state.classDepth > 0 && state.depth < state.classDepth) state.classDepth = 0
  state.expectExpression = false
  return index
}

function scanWord(state, line, index) {
  let end = index + 1
  while (end < line.length && /[A-Za-z0-9_$]/.test(line[end])) end += 1
  state.expectExpression = EXPRESSION_KEYWORDS.has(line.slice(index, end))
  return end - 1
}

function scanNumber(state, line, index) {
  let end = index + 1
  while (end < line.length && /[0-9A-Za-z_.]/.test(line[end])) end += 1
  state.expectExpression = false
  return end - 1
}

function scanPunctuation(state, char, next, index) {
  if ((char === '+' && next === '+') || (char === '-' && next === '-')) return index + 1
  if (char === '(' || char === '[') {
    state.expectExpression = true
    return index
  }
  if (char === ')' || char === ']') {
    state.expectExpression = false
    return index
  }
  if (char === '.') {
    state.expectExpression = false
    return index
  }
  if ('=+-*%&|^~!?:;,<>'.includes(char)) state.expectExpression = true
  return index
}

function scanBlock(state, line, index) {
  if (line[index] === '*' && line[index + 1] === '/') {
    state.modes.pop()
    return index + 1
  }
  return index
}

function scanQuoted(state, line, index) {
  const char = line[index]
  if (char === '\\') return Math.min(index + 1, line.length - 1)
  const quote = currentMode(state) === 'single' ? "'" : '"'
  if (char === quote) {
    state.modes.pop()
    state.expectExpression = false
  }
  return index
}

function scanTemplate(state, line, index) {
  const char = line[index]
  const next = line[index + 1]
  if (char === '\\') return Math.min(index + 1, line.length - 1)
  if (char === '`') {
    state.modes.pop()
    state.expectExpression = false
    return index
  }
  if (char === '$' && next === '{') {
    state.modes.push('code')
    state.depth += 1
    state.interpolations.push(state.depth)
    state.expectExpression = true
    return index + 1
  }
  return index
}

function scanRegex(state, line, index) {
  const char = line[index]
  if (char === '\\') return Math.min(index + 1, line.length - 1)
  if (char === '[' && !state.regexClass) {
    state.regexClass = true
    return index
  }
  if (char === ']' && state.regexClass) {
    state.regexClass = false
    return index
  }
  if (char === '/' && !state.regexClass) {
    state.modes.pop()
    state.expectExpression = false
  }
  return index
}

function isCode(line) {
  const text = line.trim()
  return text !== '' && !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')
}

// Per-line weight of a file: 1 for a code line inside any of the target's
// original ranges for that file, else 0.
function fileLineWeights(target, file, specifications) {
  const lines = readFileSync(path.resolve(ROOT, target.packageDirectory, file), 'utf8').split('\n')
  const weights = Array.from({ length: lines.length }, () => 0)
  for (const specification of specifications) {
    const [first, last] = specificationLines(specification, lines.length)
    for (let index = first - 1; index < Math.min(last, lines.length); index += 1)
      if (isCode(lines[index])) weights[index] = 1
  }
  return { lines, weights }
}

// Cut a file into `pieces` contiguous segments at top-level declaration or
// class member lines, balancing code weight. A mutant cannot span two
// top-level statements or two class members, and a cut line must be a unique
// line prefix so lineSegments can re-find it.
function fileSegments(lines, weights, pieces) {
  const before = [0]
  for (const weight of weights) before.push(before.at(-1) + weight)
  const total = before.at(-1)
  const members = classMemberLines(lines)
  const candidates = lines
    .map((line, index) => index)
    .filter(
      index =>
        index > 0 &&
        (isTopLevelDeclaration(lines[index]) || members.has(index)) &&
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
  return groups.sort((left, right) =>
    unitOrder(left.units[0]).localeCompare(unitOrder(right.units[0]))
  )
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

export function partitionMutationTarget(targetId, target) {
  const plan = plans.get(targetId) ?? automaticPlan(targetId, target)
  if (!plan) return [{ id: 'whole', target }]
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
        partition: id
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
