import { classifyProofHistory, reviewProofHistory } from './proofHistoryReview'

describe('proof-history review', () => {
  test('tracks transitions, aggregate results, and provider outcomes', () => {
    const review = reviewProofHistory(
      JSON.stringify({
        notes: [
          { what: 'status', status_now: 'unmined' },
          { what: 'status', status_now: 'doubleSpend' },
          {
            what: 'aggregateResults',
            successCount: 1,
            doubleSpendCount: 2,
            statusErrorCount: 3,
            serviceErrorCount: 4
          },
          {
            name: 'ARCv1tx',
            what: 'postRawTxDoubleSpend',
            txStatus: 'DOUBLE_SPEND_ATTEMPTED'
          },
          {
            name: 'WoCpostRawTx',
            what: 'postRawTxErrorMissingInputs'
          }
        ]
      })
    )

    expect(review).toMatchObject({
      finalStatus: 'doubleSpend',
      wasUnmined: true,
      wasDoubleSpend: true,
      aggregateTotal: 10,
      providerOutcomes: {
        arc: 'doubleSpend',
        whatsOnChain: 'missingInputs'
      }
    })
    expect(classifyProofHistory(review)).toEqual(['unmined-then-failed', 'double-spend-after-success'])
  })

  test('treats missing notes as an empty review', () => {
    expect(reviewProofHistory('{}')).toEqual({
      aggregateTotal: 0,
      providerOutcomes: {},
      wasCompleted: false,
      wasDoubleSpend: false,
      wasInternalized: false,
      wasInvalid: false,
      wasUnmined: false
    })
  })
})
