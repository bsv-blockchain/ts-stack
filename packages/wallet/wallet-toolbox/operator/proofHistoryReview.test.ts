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

  test('normalizes provider outcomes across known success and failure responses', () => {
    expect(
      reviewProofHistory(
        JSON.stringify({
          notes: [
            { name: 'WoCpostRawTx', what: 'postRawTxError', status: 504 },
            { name: 'ARCv1tx', what: 'postRawTxError', status: 469 },
            { name: 'BitailsPostRawTx', what: 'postRawsError', code: -26 }
          ]
        })
      ).providerOutcomes
    ).toEqual({
      whatsOnChain: 'serviceError',
      arc: 'badRoots',
      bitails: 'invalidTx'
    })

    expect(
      reviewProofHistory(
        JSON.stringify({
          notes: [
            { name: 'WoCpostBeef', what: 'postBeefError' },
            { name: 'WoCpostBeef', what: 'postBeefSuccess' },
            { name: 'ARCv1tx', what: 'postRawTxError', status: 463 },
            { name: 'ARCv1tx', what: 'postRawTxSuccess', txStatus: 'SEEN_ON_NETWORK' },
            { name: 'BitailsPostRawTx', what: 'postRawsError', code: 'ESOCKETTIMEDOUT' },
            { name: 'BitailsPostRawTx', what: 'postRawsSuccessAlreadyInMempool' }
          ]
        })
      ).providerOutcomes
    ).toEqual({
      whatsOnChain: 'success',
      arc: 'success',
      bitails: 'success'
    })

    expect(
      reviewProofHistory(
        JSON.stringify({
          notes: [
            {
              name: 'ARCpostBeef',
              what: 'postBeefGetTxDataSuccess',
              txStatus: 'STORED'
            }
          ]
        })
      ).providerOutcomes
    ).toEqual({ arc: 'success' })
  })

  test('classifies completed and failed transition combinations', () => {
    const completed = reviewProofHistory(
      JSON.stringify({
        notes: [
          { what: 'status', status_now: 'doubleSpend' },
          { what: 'status', status_now: 'invalid' },
          { what: 'aggregateResults', successCount: 0 },
          { what: 'status', status_now: 'completed' }
        ]
      })
    )
    expect(classifyProofHistory(completed)).toEqual([
      'completed-after-double-spend',
      'completed-after-invalid',
      'completed-without-success'
    ])

    const failed = reviewProofHistory(
      JSON.stringify({
        notes: [
          { what: 'status', status_now: 'completed' },
          { what: 'status', status_now: 'unmined' },
          { what: 'internalizeAction' },
          { what: 'aggregateResults', successCount: 1 },
          { what: 'status', status_now: 'invalid' }
        ]
      })
    )
    expect(classifyProofHistory(failed)).toEqual([
      'failed-after-completed',
      'internalized-then-failed',
      'invalid-after-success'
    ])
  })
})
