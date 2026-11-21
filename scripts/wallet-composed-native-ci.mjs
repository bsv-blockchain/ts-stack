#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const GIT_EXECUTABLE =
  process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git'

export const composedNativeTestFile =
  'packages/wallet/wallet-toolbox/src/storage/portable/Brc39ComposedNativeRecoveryNode.test.ts'

const phases = ['READY', 'DELETE_ACTIVATING', 'DELETE_ACTIVE', 'WAL_ACTIVATING', 'WAL', 'COMPLETED']
const retiredName = (phase, recovery) =>
  `actual retired ${phase} target resumes through ${recovery} without changing original limits`
const simpleCases = [
  [
    'customer',
    'actual occupied import, current restart and repeat import preserve a later full TEXT customer write'
  ],
  [
    'cancel-authenticated',
    'cancellation after drained AUTHENTICATED work preserves the serving wallet'
  ],
  ['cancel-import', 'cancellation after drained IMPORT work preserves the serving wallet'],
  [
    'failed-close',
    'failed READY target cleanup retains its concrete owner until retry, then named recovery completes'
  ],
  [
    'inactive-retry',
    'inactive composed retry withdraws the original copy and preserves its reservation, limits and semantic postimage'
  ],
  [
    'occupied-history',
    'retained occupied history callback replays independent legacy bytes and revokes escaped readers'
  ],
  ['request-writer', 'actual native request writer preserves omitted legacy broadcast counters'],
  [
    'physical-coordinate',
    'actual composed current transaction field selection preserves its physical coordinate'
  ],
  [
    'request-identity',
    'actual occupied native request identity reuses the original legacy archive spelling'
  ]
]
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const nativePairTestFile =
  'packages/wallet/wallet-toolbox/src/storage/snapshot/NativeSnapshotMergeContractsNode.test.ts'

// Each original case creates two independently authenticated full profiles.
// Setup measured 104s + 107s before selected effects; all18 do not fit one40m
// shard. One case per lane preserves original data, oracles and real expiry.
export const nativePairCohorts = Object.freeze(
  [
    [
      'proof',
      'actual native proof session retains independently constructed multichunk transaction and Merkle bytes'
    ],
    [
      'quarantine',
      'actual native target-winner merge quarantines separate previously spendable reclaim liquidity'
    ],
    [
      'rejected-proof',
      'actual occupied native proof refuses an invalid current header before destination or ACK mutation'
    ],
    [
      'scalar',
      'actual native scalar session preserves original occupied basket policy and one-use durable ACK'
    ],
    ...['transactions', 'outputs'].map(table => [
      `action-${table}`,
      `actual native ${table} session retains complete occupied action fields`
    ]),
    ...['certificates', 'certificateFields', 'commissions'].map(table => [
      `payload-${table}`,
      `actual native ${table} session retains full large logical payloads and parent mappings`
    ]),
    [
      'request',
      'actual native request session retains full history, proof, notify and atomic completion'
    ],
    [
      'packed-field',
      'actual retained source stages multichunk bytes into a fresh native pointer with rollback and content reuse'
    ],
    ['stale-proof', 'a real occupied proof update invalidates previously prepared native effects'],
    ['stale-parent', 'a real mapped-parent update invalidates prepared native output effects'],
    ...['certificates', 'certificateFields', 'commissions'].map(table => [
      `stale-${table}`,
      `a real occupied ${table} update refuses the old prepared payload and ACK`
    ]),
    ...['request', 'transaction'].map(kind => [
      `stale-current-${kind}`,
      `a real current ${kind} update invalidates prepared native request effects`
    ]),
    [
      'journal-field',
      'actual journal fields stage verified native bytes with rollback, consumed actors and content reuse'
    ],
    [
      'archive-native-cache',
      'actual authenticated field archive reuses freshly verified native content without downloading it again'
    ]
  ].map(([id, name]) => Object.freeze({ id, name, cases: 1, pattern: `^${escapePattern(name)}$` }))
)
export const nativePairCaseNames = Object.freeze(
  nativePairCohorts.map(cohort => cohort.name).sort((a, b) => Number(a > b) - Number(a < b))
)

export const nativeMergeTestFile =
  'packages/wallet/wallet-toolbox/src/storage/portable/Brc38NativeMergeContractsNode.test.ts'

// The three full cases alone measured 49.9 minutes, excluding installation,
// delivery and proof regressions. They cannot share an ordinary40m shard.
// One fresh one-hour case plus the existing two600s native delivery steps,
// installation, coverage and cleanup fits a bounded90m lane. Proof cases keep40m.
export const nativeMergeCohorts = Object.freeze(
  [
    ...[false, true].map(refold => ({
      id: refold ? 'runner-refold' : 'runner',
      name: `complete native runner drains scopes and independently compares all48 rows; refold=${refold}`,
      minutes: 90
    })),
    {
      id: 'lost-ack-refold',
      name: 'actual committed ACK loss reopens the same reservation and refolds without reusing incoming IDs',
      minutes: 90
    },
    ...['upper', 'lower', 'mixed'].map(spelling => ({
      id: `proof-${spelling}`,
      name: `actual occupied proof merge preserves the exact ${spelling} transaction identity without inserting a duplicate`,
      minutes: 40
    }))
  ].map(value => Object.freeze({ ...value, cases: 1, pattern: `^${escapePattern(value.name)}$` }))
)
export const nativeMergeCaseNames = Object.freeze(
  nativeMergeCohorts.map(cohort => cohort.name).sort((a, b) => Number(a > b) - Number(a < b))
)

export const nativeAuthenticatedMergeTestFile =
  'packages/wallet/wallet-toolbox/src/storage/portable/Brc38NativeAuthenticatedMergeContractsNode.test.ts'

// Preserve the six full public-entry cases and their original1200s owner/1230s
// Jest allowance. Separate lanes include the existing two600s delivery steps
// and bounded installation/build/coverage/cleanup within the90m setup envelope.
export const nativeAuthenticatedMergeCohorts = Object.freeze(
  ['repeat', 'lost-observer', 'wrong-password', 'truncated', 'corrupt', 'wrong-binding'].map(id => {
    const name = `authenticated native entry point automatically reserves IDs and preserves original custody: ${id}`
    return Object.freeze({ id, name, cases: 1, minutes: 90, pattern: `^${escapePattern(name)}$` })
  })
)
export const nativeAuthenticatedMergeCaseNames = Object.freeze(
  nativeAuthenticatedMergeCohorts
    .map(cohort => cohort.name)
    .sort((a, b) => Number(a > b) - Number(a < b))
)

// Mandatory per-case lanes retain the complete original read/user inventories
// and all original resource/lifetime limits. Their existing 40-minute job
// envelope also covers the two pinned delivery steps.
export const nativeReadTestFile =
  'packages/wallet/wallet-toolbox/src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts'
export const nativeReadCohorts = Object.freeze(
  [
    [
      'wal',
      'actual native WAL source retains original large history while foreground writing and archive provenance remain live'
    ],
    [
      'publication',
      'actual DELETE publication reaches WAL snapshot admission only through its original profile'
    ],
    [
      'fields',
      'actual native field metadata and packed hash windows preserve independent large bytes'
    ],
    ['scalar', 'all seventeen native scalar TEXT fields use exact bounded source windows'],
    [
      'capacity',
      'native portable measurement keeps foreground capacity while its dedicated export reader is retained'
    ],
    [
      'cache',
      'actual native catalog component verifies authenticated binary and UTF8 cache reuse, pointer rollback and consumed actors'
    ]
  ].map(([id, name]) => Object.freeze({ id, name, cases: 1, pattern: `^${escapePattern(name)}$` }))
)
export const nativeReadCaseNames = Object.freeze(
  nativeReadCohorts.map(value => value.name).sort((a, b) => Number(a > b) - Number(a < b))
)
export const nativeUserTestFile =
  'packages/wallet/wallet-toolbox/src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts'
export const nativeUserCohorts = Object.freeze(
  [
    [
      '2026-10-02',
      'actual user inventory preserves the second profile, enforces current NULL constraints and applies header date 2026-10-02'
    ],
    [
      '2026-10-03',
      'actual user inventory preserves the second profile, enforces current NULL constraints and applies header date 2026-10-03'
    ],
    [
      '2026-10-04',
      'actual user inventory preserves the second profile, enforces current NULL constraints and applies header date 2026-10-04'
    ]
  ].map(([id, name]) => Object.freeze({ id, name, cases: 1, pattern: `^${escapePattern(name)}$` }))
)
export const nativeUserCaseNames = Object.freeze(
  nativeUserCohorts.map(value => value.name).sort((a, b) => Number(a > b) - Number(a < b))
)

// COMPLETED has the same original name for live and expired admissions. Keep
// both in one cohort, with multiplicity two; neither original case is renamed.
export const composedNativeCohorts = Object.freeze(
  [
    ...simpleCases.map(([id, name]) => ({ id, name, cases: 1 })),
    ...phases.flatMap(phase =>
      phase === 'COMPLETED'
        ? [{ id: 'completed', name: retiredName(phase, 'COMPLETED_CURRENT'), cases: 2 }]
        : ['LIVE_PENDING', 'EXPIRED_PENDING'].map(recovery => ({
            id: `${phase.toLowerCase()}-${recovery.toLowerCase()}`,
            name: retiredName(phase, recovery),
            cases: 1
          }))
    )
  ].map(value => Object.freeze({ ...value, pattern: `^${escapePattern(value.name)}$` }))
)

export const composedNativeCaseNames = Object.freeze(
  composedNativeCohorts
    .flatMap(cohort => Array.from({ length: cohort.cases }, () => cohort.name))
    .sort((a, b) => Number(a > b) - Number(a < b))
)

// Every original comparison runs its complete fresh native fixture. Keep
// repeated names together: rawTx/merklePath and history/notify are distinct
// cases whose original full names intentionally have multiplicity two.
export const nativeIntegrityTestFile =
  'packages/wallet/wallet-toolbox/src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts'
export const nativeIntegrityCaseNames = Object.freeze(
  [
    'complete current comparison rejects metadata mutation in users',
    'complete current comparison rejects metadata mutation in settings',
    'complete current comparison rejects metadata mutation in proven_txs',
    'complete current comparison rejects metadata mutation in proven_tx_reqs',
    'complete current comparison rejects metadata mutation in output_baskets',
    'complete current comparison rejects metadata mutation in output_tags',
    'complete current comparison rejects metadata mutation in tx_labels',
    'complete current comparison rejects metadata mutation in transactions',
    'complete current comparison rejects metadata mutation in outputs',
    'complete current comparison rejects metadata mutation in commissions',
    'complete current comparison rejects metadata mutation in tx_labels_map',
    'complete current comparison rejects metadata mutation in output_tags_map',
    'complete current comparison rejects metadata mutation in certificates',
    'complete current comparison rejects metadata mutation in monitor_events',
    'complete current comparison rejects metadata mutation in prepared_beef_metadata',
    'complete current comparison rejects metadata mutation in auth_sessions',
    'complete current comparison rejects metadata mutation in auth_message_nonces',
    'complete current comparison rejects metadata mutation in snapshot_sync_sessions',
    'complete current comparison rejects metadata mutation in snapshot_sync_ids',
    'complete current comparison rejects metadata mutation in snapshot_sync_primary_epochs',
    'complete current comparison rejects metadata mutation in snapshot_reconciliation_window_progress',
    'complete current comparison rejects binary mutation in proven_txs',
    'complete current comparison rejects binary mutation in proven_txs',
    'complete current comparison rejects binary mutation in outputs',
    'complete current comparison rejects binary mutation in prepared_beefs',
    'complete current comparison rejects binary mutation in action_batch_blobs',
    'complete current comparison rejects binary mutation in sync_transfer_parts',
    'complete current comparison rejects binary mutation in snapshot_reconciliation_stage_pages',
    'complete current comparison rejects binary mutation in snapshot_reconciliation_provenance',
    'complete current comparison rejects text mutation in transactions',
    'complete current comparison rejects text mutation in certificate_fields',
    'complete current comparison rejects text mutation in certificates',
    'complete current comparison rejects text mutation in commissions',
    'complete current comparison rejects text mutation in proven_tx_reqs',
    'complete current comparison rejects text mutation in proven_tx_reqs',
    'complete current comparison rejects text mutation in sync_states',
    'complete current comparison rejects text mutation in monitor_events',
    'complete current comparison rejects text mutation in action_batches',
    'complete current comparison rejects text mutation in sync_transfers'
  ].sort((a, b) => Number(a > b) - Number(a < b))
)

function integrityCohorts() {
  const groups = []
  for (const name of new Set(nativeIntegrityCaseNames)) {
    const cases = nativeIntegrityCaseNames.filter(value => value === name).length
    let group = groups.at(-1)
    if (group === undefined || group.cases + cases > 7) {
      group = { id: `part-${groups.length + 1}`, names: [], cases: 0 }
      groups.push(group)
    }
    group.names.push(name)
    group.cases += cases
  }
  return groups.map(group =>
    Object.freeze({
      ...group,
      names: Object.freeze(group.names),
      pattern: `^(?:${group.names.map(escapePattern).join('|')})$`
    })
  )
}
export const nativeIntegrityCohorts = Object.freeze(integrityCohorts())
const integrityPlan = {
  testFile: nativeIntegrityTestFile,
  cohorts: nativeIntegrityCohorts,
  names: nativeIntegrityCaseNames
}

const composedPlan = {
  testFile: composedNativeTestFile,
  cohorts: composedNativeCohorts,
  names: composedNativeCaseNames
}
const pairPlan = {
  testFile: nativePairTestFile,
  cohorts: nativePairCohorts,
  names: nativePairCaseNames
}
const mergePlan = {
  testFile: nativeMergeTestFile,
  cohorts: nativeMergeCohorts,
  names: nativeMergeCaseNames
}
const authenticatedMergePlan = {
  testFile: nativeAuthenticatedMergeTestFile,
  cohorts: nativeAuthenticatedMergeCohorts,
  names: nativeAuthenticatedMergeCaseNames
}

const readPlan = {
  testFile: nativeReadTestFile,
  cohorts: nativeReadCohorts,
  names: nativeReadCaseNames
}
const userPlan = {
  testFile: nativeUserTestFile,
  cohorts: nativeUserCohorts,
  names: nativeUserCaseNames
}

export function walletCoverageMatrix() {
  return {
    include: [
      ...[1, 2, 3, 4, 5, 6].map(shard => ({ id: `shard-${shard}`, shard })),
      ...[0, 1000].map(latency => ({ id: `sync-http-${latency}`, latency })),
      ...composedNativeCohorts.map(cohort => ({
        id: `native-${cohort.id}`,
        native_cohort: cohort.id
      })),
      ...nativePairCohorts.map(cohort => ({
        id: `native-pair-${cohort.id}`,
        native_pair_cohort: cohort.id
      })),
      ...nativeMergeCohorts.map(cohort => ({
        id: `native-merge-${cohort.id}`,
        native_merge_cohort: cohort.id,
        native_merge_minutes: cohort.minutes
      })),
      ...nativeAuthenticatedMergeCohorts.map(cohort => ({
        id: `native-auth-${cohort.id}`,
        native_auth_cohort: cohort.id,
        native_auth_minutes: cohort.minutes
      })),
      ...nativeReadCohorts.map(cohort => ({
        id: `native-read-${cohort.id}`,
        native_read_cohort: cohort.id
      })),
      ...nativeUserCohorts.map(cohort => ({
        id: `native-user-${cohort.id}`,
        native_user_cohort: cohort.id
      })),
      ...nativeIntegrityCohorts.map(cohort => ({
        id: `native-integrity-${cohort.id}`,
        native_integrity_cohort: cohort.id
      }))
    ]
  }
}

function nativeCohort(id, plan) {
  const cohort = plan.cohorts.find(value => value.id === id)
  if (cohort === undefined) throw new Error('Unknown native cohort')
  return cohort
}

function validateNativeReport(report, cohortId, plan) {
  const cohort = nativeCohort(cohortId, plan)
  const suite = report?.testResults?.[0]
  const assertions = suite?.assertionResults
  if (
    report?.success !== true ||
    report.numTotalTestSuites !== 1 ||
    report.numPassedTestSuites !== 1 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0 ||
    report.testResults.length !== 1 ||
    !suite.name?.replaceAll('\\', '/').endsWith('/' + plan.testFile) ||
    !Array.isArray(assertions) ||
    assertions.length !== plan.names.length ||
    !isDeepStrictEqual(
      assertions.map(value => value.fullName).sort((a, b) => Number(a > b) - Number(a < b)),
      plan.names
    )
  )
    throw new Error('Native report lacks the complete original case inventory')
  for (const value of assertions) {
    const selected =
      cohort.names === undefined
        ? value.fullName === cohort.name
        : cohort.names.includes(value.fullName)
    if (value.status !== (selected ? 'passed' : 'pending') || value.failureMessages?.length !== 0)
      throw new Error('Native selected case failed, skipped or differs from its cohort')
  }
  if (
    report.numTotalTests !== plan.names.length ||
    report.numPassedTests !== cohort.cases ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== plan.names.length - cohort.cases ||
    report.numTodoTests !== 0 ||
    assertions.filter(value => value.status === 'passed').length !== cohort.cases
  )
    throw new Error('Native selected execution count differs')
  return {
    cohort: cohort.id,
    passedCases: cohort.cases,
    originalCaseCount: plan.names.length
  }
}

function validateNativeReceipts(receipts, identity, plan) {
  if (!Array.isArray(receipts) || receipts.length !== plan.cohorts.length)
    throw new Error('Missing complete native cohort receipts')
  const seen = new Set()
  let total = 0
  for (const receipt of receipts) {
    const cohort = nativeCohort(receipt.cohort, plan)
    if (
      seen.has(cohort.id) ||
      !isDeepStrictEqual(receipt.identity, identity) ||
      receipt.passedCases !== cohort.cases ||
      receipt.originalCaseCount !== plan.names.length ||
      typeof receipt.reportSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(receipt.reportSha256)
    )
      throw new Error('Duplicate, stale or incomplete native cohort receipt')
    seen.add(cohort.id)
    total += receipt.passedCases
  }
  if (total !== plan.names.length) throw new Error('Native case union differs')
  return total
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function validateNativeReceiptReport(receipt, bytes, plan) {
  if (receipt.reportSha256 !== digest(bytes)) throw new Error('Native runtime report changed')
  const actual = validateNativeReport(JSON.parse(bytes.toString('utf8')), receipt.cohort, plan)
  if (
    actual.passedCases !== receipt.passedCases ||
    actual.originalCaseCount !== receipt.originalCaseCount
  )
    throw new Error('Native receipt differs from actual runtime report')
  return actual
}
export const composedNativeCohort = id => nativeCohort(id, composedPlan)
export const nativePairCohort = id => nativeCohort(id, pairPlan)
export const nativeMergeCohort = id => nativeCohort(id, mergePlan)
export const nativeAuthenticatedMergeCohort = id => nativeCohort(id, authenticatedMergePlan)
export const validateComposedNativeReport = (report, id) =>
  validateNativeReport(report, id, composedPlan)
export const validateNativePairReport = (report, id) => validateNativeReport(report, id, pairPlan)
export const validateNativeMergeReport = (report, id) => validateNativeReport(report, id, mergePlan)
export const validateNativeAuthenticatedMergeReport = (report, id) =>
  validateNativeReport(report, id, authenticatedMergePlan)
export const validateComposedNativeReceipts = (receipts, identity) =>
  validateNativeReceipts(receipts, identity, composedPlan)
export const validateNativePairReceipts = (receipts, identity) =>
  validateNativeReceipts(receipts, identity, pairPlan)
export const validateNativeMergeReceipts = (receipts, identity) =>
  validateNativeReceipts(receipts, identity, mergePlan)
export const validateNativeAuthenticatedMergeReceipts = (receipts, identity) =>
  validateNativeReceipts(receipts, identity, authenticatedMergePlan)
export const validateComposedNativeReceiptReport = (receipt, bytes) =>
  validateNativeReceiptReport(receipt, bytes, composedPlan)
export const validateNativePairReceiptReport = (receipt, bytes) =>
  validateNativeReceiptReport(receipt, bytes, pairPlan)
export const validateNativeMergeReceiptReport = (receipt, bytes) =>
  validateNativeReceiptReport(receipt, bytes, mergePlan)
export const validateNativeAuthenticatedMergeReceiptReport = (receipt, bytes) =>
  validateNativeReceiptReport(receipt, bytes, authenticatedMergePlan)
export const nativeReadCohort = id => nativeCohort(id, readPlan)
export const validateNativeReadReport = (report, id) => validateNativeReport(report, id, readPlan)
export const validateNativeReadReceipts = (receipts, identity) =>
  validateNativeReceipts(receipts, identity, readPlan)
export const validateNativeReadReceiptReport = (receipt, bytes) =>
  validateNativeReceiptReport(receipt, bytes, readPlan)
export const nativeUserCohort = id => nativeCohort(id, userPlan)
export const validateNativeUserReport = (report, id) => validateNativeReport(report, id, userPlan)
export const validateNativeUserReceipts = (receipts, identity) =>
  validateNativeReceipts(receipts, identity, userPlan)
export const validateNativeUserReceiptReport = (receipt, bytes) =>
  validateNativeReceiptReport(receipt, bytes, userPlan)

export const nativeIntegrityCohort = id => nativeCohort(id, integrityPlan)
export const validateNativeIntegrityReport = (report, id) =>
  validateNativeReport(report, id, integrityPlan)
export const validateNativeIntegrityReceipts = (receipts, identity) =>
  validateNativeReceipts(receipts, identity, integrityPlan)
export const validateNativeIntegrityReceiptReport = (receipt, bytes) =>
  validateNativeReceiptReport(receipt, bytes, integrityPlan)

function identity(root, plan) {
  return {
    head: execFileSync(GIT_EXECUTABLE, ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim(),
    testFileSha256: digest(fs.readFileSync(path.join(root, plan.testFile))),
    planSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url)))
  }
}
function receiptFiles(directory, suffix) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return receiptFiles(filename, suffix)
    return entry.isFile() && entry.name.endsWith(suffix) ? [filename] : []
  })
}

function commandFamily(command) {
  if (command?.startsWith('integrity-'))
    return {
      prefix: 'integrity-',
      plan: integrityPlan,
      suffix: '.native-integrity.json',
      label: 'native integrity'
    }

  if (command?.startsWith('read-'))
    return { prefix: 'read-', plan: readPlan, suffix: '.native-read.json', label: 'native read' }
  if (command?.startsWith('user-'))
    return { prefix: 'user-', plan: userPlan, suffix: '.native-user.json', label: 'native user' }
  if (command?.startsWith('auth-'))
    return {
      prefix: 'auth-',
      plan: authenticatedMergePlan,
      suffix: '.native-auth.json',
      label: 'authenticated native merge'
    }
  if (command?.startsWith('pair-'))
    return { prefix: 'pair-', plan: pairPlan, suffix: '.native-pair.json', label: 'native pair' }
  if (command?.startsWith('merge-'))
    return {
      prefix: 'merge-',
      plan: mergePlan,
      suffix: '.native-merge.json',
      label: 'native merge'
    }
  return {
    prefix: '',
    plan: composedPlan,
    suffix: '.composed-native.json',
    label: 'composed native'
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [requestedCommand, ...args] = process.argv.slice(2)
    const family = commandFamily(requestedCommand)
    const command = requestedCommand?.slice(family.prefix.length)
    const { plan, suffix } = family
    const root = fileURLToPath(new URL('..', import.meta.url))
    if (command === 'matrix' && family.prefix === '' && args.length === 0) {
      console.log(JSON.stringify(walletCoverageMatrix()))
    } else if (command === 'pattern' && args.length === 1) {
      console.log(nativeCohort(args[0], plan).pattern)
    } else if (command === 'capture' && args.length === 3) {
      const bytes = fs.readFileSync(args[1])
      const report = JSON.parse(bytes.toString('utf8'))
      const verified = validateNativeReport(report, args[0], plan)
      fs.writeFileSync(args[2] + '.jest.json', bytes, { flag: 'wx' })
      fs.writeFileSync(
        args[2],
        JSON.stringify(
          { ...verified, identity: identity(root, plan), reportSha256: digest(bytes) },
          null,
          2
        ) + '\n',
        { flag: 'wx' }
      )
    } else if (command === 'verify' && args.length === 1) {
      const receipts = receiptFiles(args[0], suffix).map(filename => {
        const receipt = JSON.parse(fs.readFileSync(filename, 'utf8'))
        validateNativeReceiptReport(receipt, fs.readFileSync(filename + '.jest.json'), plan)
        return receipt
      })
      console.log(
        `All ${validateNativeReceipts(receipts, identity(root, plan), plan)} original ${family.label} cases passed`
      )
    } else
      throw new Error(
        'Expected matrix, pattern <cohort>, capture <cohort> <report> <receipt>, or verify <directory>; prefix pattern/capture/verify with pair- for native pairs, merge- for native merge contracts, auth- for authenticated native merge contracts, read- for native readers, user- for native users, or integrity- for full native comparisons'
      )
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
