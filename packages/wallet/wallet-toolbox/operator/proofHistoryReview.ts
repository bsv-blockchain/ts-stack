interface HistoryNote {
  [key: string]: unknown
  name?: unknown
  what?: unknown
}

export interface ProofHistoryReview {
  aggregate?: {
    doubleSpendCount: number
    serviceErrorCount: number
    statusErrorCount: number
    successCount: number
  }
  aggregateTotal: number
  finalStatus?: string
  providerOutcomes: {
    arc?: string
    bitails?: string
    whatsOnChain?: string
  }
  wasCompleted: boolean
  wasDoubleSpend: boolean
  wasInternalized: boolean
  wasInvalid: boolean
  wasUnmined: boolean
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function applyStatusNote(note: HistoryNote, review: ProofHistoryReview): void {
  if (note.what !== 'status' || typeof note.status_now !== 'string') return
  review.finalStatus = note.status_now
  if (note.status_now === 'completed') review.wasCompleted = true
  if (note.status_now === 'doubleSpend') review.wasDoubleSpend = true
  if (note.status_now === 'invalid') review.wasInvalid = true
  if (note.status_now === 'unmined') review.wasUnmined = true
}

function applyAggregateNote(note: HistoryNote, review: ProofHistoryReview): void {
  if (note.what !== 'aggregateResults') return
  review.aggregate = {
    successCount: number(note.successCount),
    doubleSpendCount: number(note.doubleSpendCount),
    statusErrorCount: number(note.statusErrorCount),
    serviceErrorCount: number(note.serviceErrorCount)
  }
  review.aggregateTotal = Object.values(review.aggregate).reduce((sum, value) => sum + value, 0)
}

function applyWhatsOnChainNote(note: HistoryNote, review: ProofHistoryReview): void {
  if (note.name === 'WoCpostRawTx') {
    if (note.what === 'postRawTxErrorMissingInputs') {
      review.providerOutcomes.whatsOnChain = 'missingInputs'
    } else if (note.what === 'postRawTxError' && note.status === 504) {
      review.providerOutcomes.whatsOnChain = 'serviceError'
    }
    return
  }
  if (note.name !== 'WoCpostBeef') return
  if (note.what === 'postBeefSuccess') {
    review.providerOutcomes.whatsOnChain = 'success'
  } else if (note.what === 'postBeefError' && review.providerOutcomes.whatsOnChain === undefined) {
    review.providerOutcomes.whatsOnChain = 'invalidTx'
  }
}

function applyArcNote(note: HistoryNote, review: ProofHistoryReview): void {
  if (note.name === 'ARCpostBeef' && note.what === 'postBeefGetTxDataSuccess' && note.txStatus === 'STORED') {
    review.providerOutcomes.arc = 'success'
    return
  }
  if (note.name !== 'ARCv1tx') return
  if (note.what === 'postRawTxDoubleSpend' && note.txStatus === 'DOUBLE_SPEND_ATTEMPTED') {
    review.providerOutcomes.arc = 'doubleSpend'
  } else if (note.what === 'postRawTxError' && note.status === 469) {
    review.providerOutcomes.arc = 'badRoots'
  } else if (note.what === 'postRawTxError' && note.status === 463) {
    review.providerOutcomes.arc = 'badBump'
  } else if (
    note.what === 'postRawTxSuccess' &&
    (note.txStatus === 'ANNOUNCED_TO_NETWORK' ||
      note.txStatus === 'SEEN_ON_NETWORK' ||
      note.txStatus === 'REQUESTED_BY_NETWORK')
  ) {
    review.providerOutcomes.arc = 'success'
  }
}

function applyBitailsNote(note: HistoryNote, review: ProofHistoryReview): void {
  if (note.name !== 'BitailsPostRawTx') return
  if (note.what === 'postRawsSuccess' || note.what === 'postRawsSuccessAlreadyInMempool') {
    review.providerOutcomes.bitails = 'success'
  } else if (note.what === 'postRawsErrorMissingInputs' || (note.what === 'postRawsError' && note.code === -26)) {
    review.providerOutcomes.bitails = 'invalidTx'
  } else if (note.what === 'postRawsError' && (note.code === -1 || note.code === 'ESOCKETTIMEDOUT')) {
    review.providerOutcomes.bitails = 'serviceError'
  }
}

export function reviewProofHistory(history: string): ProofHistoryReview {
  const parsed = JSON.parse(history) as { notes?: unknown }
  const notes = Array.isArray(parsed.notes) ? (parsed.notes as HistoryNote[]) : []
  const review: ProofHistoryReview = {
    aggregateTotal: 0,
    providerOutcomes: {},
    wasCompleted: false,
    wasDoubleSpend: false,
    wasInternalized: false,
    wasInvalid: false,
    wasUnmined: false
  }

  for (const note of notes) {
    applyStatusNote(note, review)
    applyAggregateNote(note, review)
    if (note.what === 'internalizeAction') review.wasInternalized = true
    applyWhatsOnChainNote(note, review)
    applyArcNote(note, review)
    applyBitailsNote(note, review)
  }

  return review
}

function classifyTransitions(review: ProofHistoryReview): string[] {
  const classifications: string[] = []
  if (review.finalStatus === 'completed' && review.wasDoubleSpend) {
    classifications.push('completed-after-double-spend')
  }
  if (review.finalStatus === 'completed' && review.wasInvalid) {
    classifications.push('completed-after-invalid')
  }
  if ((review.finalStatus === 'doubleSpend' || review.finalStatus === 'invalid') && review.wasCompleted) {
    classifications.push('failed-after-completed')
  }
  if ((review.finalStatus === 'doubleSpend' || review.finalStatus === 'invalid') && review.wasUnmined) {
    classifications.push(review.wasInternalized ? 'internalized-then-failed' : 'unmined-then-failed')
  }
  return classifications
}

function classifyAggregate(review: ProofHistoryReview): string[] {
  const classifications: string[] = []
  if (review.aggregate !== undefined && review.aggregate.successCount === 0 && review.finalStatus === 'completed') {
    classifications.push('completed-without-success')
  }
  if (review.aggregate !== undefined && review.aggregate.successCount > 0 && review.finalStatus === 'doubleSpend') {
    classifications.push('double-spend-after-success')
  }
  if (review.aggregate !== undefined && review.aggregate.successCount > 0 && review.finalStatus === 'invalid') {
    classifications.push('invalid-after-success')
  }
  return classifications
}

export function classifyProofHistory(review: ProofHistoryReview): string[] {
  return [...classifyTransitions(review), ...classifyAggregate(review)]
}
