import { classifyArcadeRejection } from '../arcadeStatus'

describe('classifyArcadeRejection', () => {
  test.each(['DOUBLE_SPEND_ATTEMPTED', 'SEEN_IN_ORPHAN_MEMPOOL'])('%s is durable input-conflict evidence', txStatus => {
    expect(classifyArcadeRejection({ txStatus })).toMatchObject({
      terminal: true,
      inputConflict: true,
      reqStatus: 'doubleSpend'
    })
  })

  test('provider uncertainty and retryable parent rejection remain non-terminal', () => {
    expect(classifyArcadeRejection({ txStatus: 'REJECTED' }).terminal).toBe(false)
    expect(
      classifyArcadeRejection({
        txStatus: 'REJECTED',
        extraInfo: 'parent rejected while retrying'
      }).terminal
    ).toBe(false)
  })

  test('terminal validation evidence is invalid without falsely claiming an input conflict', () => {
    expect(classifyArcadeRejection({ txStatus: 'MALFORMED' })).toMatchObject({
      terminal: true,
      inputConflict: false,
      reqStatus: 'invalid'
    })
  })
})
