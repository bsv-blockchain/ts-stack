import {
  canonicalOutputJSON,
  createClosedOutputObjectValidator,
  outputAssert,
  outputHex32,
  outputU64,
  ownOutputJSON
} from '@bsv/sdk'
import type { PrivatePurchaseOriginal } from './PrivatePurchaseContracts.js'
import {
  createPrivatePurchaseProgress,
  advancePrivatePurchaseProgress,
  parsePrivatePurchaseProgress,
  type PrivatePurchaseProgress
} from './PrivatePurchaseProgress.js'
import type { PrivatePurchaseAliasSnapshot } from './SQLitePrivatePurchaseAliases.js'
import type { ProtectedLedgerView } from './ProtectedLedgerCodec.js'

// Capture only fixed field definitions; validate every supplied value afresh.
const assertSelectionFields: ReturnType<typeof createClosedOutputObjectValidator> =
  createClosedOutputObjectValidator(['format', 'firstReservedAt', 'selectedAt', 'progress'])

/** Explicit new native-owner metadata. Existing progress/state schemas and
 * exact-txid owners are unchanged. This projection is not a domain, admission,
 * selected-chain or issuance verdict. The effect owner commits it only after
 * complete independent verification under the same authenticated writer. */
export interface PrivatePurchaseAliasSelection {
  format: 'private-purchase-alias-selection/1'
  /** Actual first economic-reservation time; never rewritten by an alias. */
  firstReservedAt: string | null
  /** Actual observation at which this pending projection was selected. */
  selectedAt: string
  /** Its per-txid decision retains the original native terminal time. */
  progress: PrivatePurchaseProgress
}
const PROFILE = 'full-purchase-commitment-v1' as const

export function parsePrivatePurchaseAliasSelection(
  input: unknown,
  original: PrivatePurchaseOriginal
): PrivatePurchaseAliasSelection {
  const value = ownOutputJSON(input, { bytes: 524288 + 8192 }).value
  assertSelectionFields(value)
  outputAssert(
    value.format === 'private-purchase-alias-selection/1',
    'Unsupported alias selection custody',
    'unsupported'
  )
  const firstReservedAt =
    value.firstReservedAt === null ? null : outputU64(value.firstReservedAt).toString()
  const selectedAt = outputU64(value.selectedAt).toString()
  const progress = parsePrivatePurchaseProgress(value.progress, original, PROFILE)
  outputAssert(
    (firstReservedAt === null) === (progress.txid === null) &&
      outputU64(selectedAt) >= outputU64(progress.updatedAt) &&
      (firstReservedAt === null ||
        (outputU64(firstReservedAt) >= outputU64(original.createdAt) &&
          outputU64(firstReservedAt) < outputU64(original.terms.body.recoveryUntil) &&
          outputU64(progress.updatedAt) >= outputU64(firstReservedAt))),
    'Alias selection reservation or observation differs',
    'unavailable'
  )
  return { format: value.format, firstReservedAt, selectedAt, progress }
}

/** Build a pre-release status from the actual SAME-ledger restored alias slots.
 * The caller has separately authenticated terms, every raw input/domain and
 * selected-chain placement. Neither a caller boolean nor a wire digest can
 * establish those premises here. Keep the historical signed result separately
 * after delivery: this function refuses to replace a completed release. */
export function projectPrivatePurchaseAliasSelection(
  original: PrivatePurchaseOriginal,
  aliases: PrivatePurchaseAliasSnapshot,
  firstReservedAtInput: string | null,
  selectedTxidInput: string | null,
  view: ProtectedLedgerView
): PrivatePurchaseAliasSelection {
  const method: unknown = Object.getOwnPropertyDescriptor(aliases, 'checkCurrent')?.value
  outputAssert(
    typeof method === 'function' && method.constructor.name !== 'AsyncFunction',
    'Alias selection needs its synchronous native custody guard'
  )
  const checked: unknown = method.call(aliases, view)
  if (checked instanceof Promise) void checked.catch(() => undefined)
  outputAssert(
    checked === undefined &&
      Object.getOwnPropertyDescriptor(aliases, 'checkCurrent')?.value === method,
    'Alias custody changed during selection',
    'context-changed'
  )
  const now = outputU64(view.observedAt).toString()
  outputAssert(
    aliases.state.acquisitionId === original.terms.body.acquisitionId &&
      aliases.state.requestDigest === original.terms.body.requestDigest &&
      aliases.state.historical === null,
    'Alias selection cannot reinterpret original or historical custody',
    'conflict'
  )
  let progress = createPrivatePurchaseProgress(original, PROFILE)
  if (aliases.state.original === null) {
    outputAssert(
      firstReservedAtInput === null && selectedTxidInput === null,
      'Unconstructed alias selection cannot claim a reservation'
    )
    if (outputU64(now) >= outputU64(original.terms.body.recoveryUntil))
      progress = advancePrivatePurchaseProgress(
        progress,
        original,
        { type: 'expire' },
        now,
        PROFILE
      )
    return parsePrivatePurchaseAliasSelection(
      {
        format: 'private-purchase-alias-selection/1',
        firstReservedAt: null,
        selectedAt: now,
        progress
      },
      original
    )
  }
  const firstReservedAt = outputU64(firstReservedAtInput).toString(),
    txid = outputHex32(selectedTxidInput),
    entries = [
      aliases.state.selected,
      ...aliases.state.unconfirmed,
      ...aliases.state.pending,
      aliases.state.original
    ],
    retained = entries.find(entry => entry?.txid === txid),
    exactCandidates = [...aliases.candidates].filter(([, candidate]) => candidate.txid === txid)
  outputAssert(
    retained && exactCandidates.length > 0 && aliases.state.purchaseCommitment !== null,
    'Selected exact alias is not retained',
    'unavailable'
  )
  progress = advancePrivatePurchaseProgress(
    progress,
    original,
    {
      type: 'pin',
      txid,
      purchaseCommitment: aliases.state.purchaseCommitment
    },
    firstReservedAt,
    PROFILE
  )
  if (retained.admission === 'admitted' || retained.admission === 'rejected') {
    const role = exactCandidates.find(([role]) => aliases.outcomes.has(role))?.[0]
    outputAssert(
      role !== undefined,
      'Selected exact alias has no retained terminal outcome',
      'unavailable'
    )
    const outcome = aliases.outcomes.get(role)!,
      completedAt = aliases.completedAt.get(role)
    outputAssert(
      completedAt !== undefined &&
        outcome.txid === txid &&
        outcome.operationId === retained.operationId &&
        outcome.status === retained.admission,
      'Selected alias outcome or native terminal time differs',
      'unavailable'
    )
    outputAssert(
      outcome.status === 'admitted' || outcome.status === 'rejected',
      'Selected alias terminal decision is incomplete',
      'unavailable'
    )
    progress = advancePrivatePurchaseProgress(
      progress,
      original,
      outcome.status === 'admitted'
        ? {
            type: 'admitted',
            steak: outcome.steak,
            acceptedAt: outcome.acceptedAt,
            assessmentContextId: outcome.assessmentContextId
          }
        : { type: 'admission-rejected', reason: outcome.reason, evidence: outcome.evidence },
      completedAt,
      PROFILE
    )
  } else
    outputAssert(
      !exactCandidates.some(([role]) => aliases.outcomes.has(role)),
      'Pending selected alias carries a terminal outcome',
      'unavailable'
    )
  return parsePrivatePurchaseAliasSelection(
    {
      format: 'private-purchase-alias-selection/1',
      firstReservedAt,
      selectedAt: now,
      progress
    },
    original
  )
}

/** Preserve the first financial time across pre-release selections. All other
 * comparisons still require fresh owned native/domain/currentness guards. */
export function samePrivatePurchaseAliasReservation(
  previous: PrivatePurchaseAliasSelection,
  next: PrivatePurchaseAliasSelection,
  original: PrivatePurchaseOriginal
): void {
  const prior = parsePrivatePurchaseAliasSelection(previous, original),
    proposed = parsePrivatePurchaseAliasSelection(next, original)
  outputAssert(
    prior.firstReservedAt === null ||
      (prior.firstReservedAt === proposed.firstReservedAt &&
        prior.progress.purchaseCommitment === proposed.progress.purchaseCommitment),
    'Alias selection changes the first economic reservation',
    'conflict'
  )
  outputAssert(
    outputU64(proposed.selectedAt) >= outputU64(prior.selectedAt),
    'Alias selection observation moved backwards',
    'context-changed'
  )
  if (prior.progress.status === 'delivered' || prior.progress.status === 'delivery-failed')
    outputAssert(
      canonicalOutputJSON(prior) === canonicalOutputJSON(proposed),
      'Alias selection cannot rewrite a completed private release',
      'conflict'
    )
}
