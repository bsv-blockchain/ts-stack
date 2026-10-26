/** eslint-env jest */
import { withDoubleSpendRetry } from '../withDoubleSpendRetry'
import { WERR_REVIEW_ACTIONS } from '../../wallet/WERR_REVIEW_ACTIONS'
import Transaction from '../../transaction/Transaction'
import { ReviewActionResult } from '../../wallet/Wallet.interfaces'
import TopicBroadcaster from '../SHIPBroadcaster'

// --- Module mocks -----------------------------------------------------------

jest.mock('../../transaction/Transaction.js', () => ({
  fromBEEF: jest.fn()
}))

jest.mock('../SHIPBroadcaster.js', () => {
  return jest.fn().mockImplementation(() => ({
    broadcast: jest.fn()
  }))
})

// --- Typed mock refs --------------------------------------------------------

const MockedTransaction = Transaction as jest.Mocked<typeof Transaction>

// --- Helpers ----------------------------------------------------------------

const MAX_DOUBLE_SPEND_RETRIES = 5
const ORIGINAL_TXID = 'cc'.repeat(32)
const COMPETING_TXID_A = 'aa'.repeat(32)
const COMPETING_TXID_B = 'bb'.repeat(32)

function makeMockBroadcaster(): jest.Mocked<TopicBroadcaster> {
  return {
    broadcast: jest.fn()
  } as unknown as jest.Mocked<TopicBroadcaster>
}

function makeDoubleSpendError(
  competingBeef: number[] | null = [0x01, 0x02],
  competingTxs: string[] | null = [COMPETING_TXID_A]
): WERR_REVIEW_ACTIONS {
  const result: ReviewActionResult = {
    txid: ORIGINAL_TXID,
    status: 'doubleSpend',
    ...(competingBeef != null && { competingBeef }),
    ...(competingTxs != null && { competingTxs })
  }
  return new WERR_REVIEW_ACTIONS([result], [])
}

function makeNonDoubleSpendError(name: string = 'WERR_REVIEW_ACTIONS'): WERR_REVIEW_ACTIONS {
  const result: ReviewActionResult = {
    txid: ORIGINAL_TXID,
    status: 'serviceError'
  }
  const err = new WERR_REVIEW_ACTIONS([result], [])
  err.name = name
  return err
}

// --- Tests ------------------------------------------------------------------

describe('withDoubleSpendRetry', () => {
  let broadcaster: jest.Mocked<TopicBroadcaster>
  let mockCompetingTx: Partial<Transaction>

  beforeEach(() => {
    jest.clearAllMocks()
    broadcaster = makeMockBroadcaster()
    mockCompetingTx = {}
    ;(MockedTransaction.fromBEEF as jest.Mock).mockImplementation(
      (_beef: number[], txid: string) => {
        const transaction = { id: jest.fn().mockReturnValue(txid) }
        if (txid === COMPETING_TXID_A) mockCompetingTx = transaction
        return transaction
      }
    )
    broadcaster.broadcast.mockImplementation(async transaction => ({
      status: 'success',
      txid: transaction.id('hex'),
      message: 'Competing transaction synchronized.'
    }))
  })

  // --- Happy path -----------------------------------------------------------

  describe('succeeds without retry', () => {
    it('returns operation result immediately on first successful attempt', async () => {
      const expectedResult = { success: true }
      const operation = jest.fn().mockResolvedValue(expectedResult)

      const result = await withDoubleSpendRetry(operation, broadcaster)

      expect(result).toBe(expectedResult)
      expect(operation).toHaveBeenCalledTimes(1)
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
    })

    it('returns operation result for non-object results (string)', async () => {
      const operation = jest.fn().mockResolvedValue('done')

      const result = await withDoubleSpendRetry(operation, broadcaster)

      expect(result).toBe('done')
      expect(operation).toHaveBeenCalledTimes(1)
    })

    it('returns operation result for undefined', async () => {
      const operation = jest.fn().mockResolvedValue(undefined)

      const result = await withDoubleSpendRetry(operation, broadcaster)

      expect(result).toBeUndefined()
      expect(operation).toHaveBeenCalledTimes(1)
    })
  })

  // --- Non-double-spend errors rethrown immediately -------------------------

  describe('rethrows non-WERR_REVIEW_ACTIONS errors immediately', () => {
    it('rethrows a plain Error without retrying', async () => {
      const plainError = new Error('Network error')
      const operation = jest.fn().mockRejectedValue(plainError)

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow('Network error')
      expect(operation).toHaveBeenCalledTimes(1)
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
    })

    it('rethrows errors with other error names without retrying', async () => {
      const otherError = new Error('other error')
      otherError.name = 'SOME_OTHER_ERROR'
      const operation = jest.fn().mockRejectedValue(otherError)

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow('other error')
      expect(operation).toHaveBeenCalledTimes(1)
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
    })

    it('rethrows a name-spoofed plain object without inspecting attacker fields', async () => {
      const spoof = {
        name: 'WERR_REVIEW_ACTIONS',
        reviewActionResults: [
          { status: 'doubleSpend', competingBeef: [1], competingTxs: [COMPETING_TXID_A] }
        ]
      }
      const operation = jest.fn().mockRejectedValue(spoof)

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toBe(spoof)
      expect(operation).toHaveBeenCalledTimes(1)
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
    })

    it('rethrows null without masking the original rejection', async () => {
      const operation = jest.fn().mockRejectedValue(null)
      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toBeNull()
      expect(operation).toHaveBeenCalledTimes(1)
    })
  })

  // --- WERR_REVIEW_ACTIONS without doubleSpend rethrown immediately ---------

  describe('rethrows WERR_REVIEW_ACTIONS that do not represent a valid doubleSpend', () => {
    it('rethrows WERR_REVIEW_ACTIONS with no doubleSpend result in reviewActionResults', async () => {
      const error = makeNonDoubleSpendError()
      const operation = jest.fn().mockRejectedValue(error)

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow(error)
      expect(operation).toHaveBeenCalledTimes(1)
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
    })

    it('rethrows WERR_REVIEW_ACTIONS where doubleSpend result has no competingBeef', async () => {
      const error = makeDoubleSpendError(null, [COMPETING_TXID_A])
      const operation = jest.fn().mockRejectedValue(error)

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow(error)
      expect(operation).toHaveBeenCalledTimes(1)
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
    })

    it('rethrows sparse competing transaction arrays', async () => {
      const competingTxs: string[] = []
      competingTxs.length = 1
      const error = makeDoubleSpendError([1, 2], competingTxs)
      const operation = jest.fn().mockRejectedValue(error)

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow(error)
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
    })

    it('rethrows malformed or sparse BEEF bytes', async () => {
      const beef: number[] = []
      beef.length = 2
      beef[1] = 256
      const error = makeDoubleSpendError(beef, [COMPETING_TXID_A])
      const operation = jest.fn().mockRejectedValue(error)

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow(error)
      expect(MockedTransaction.fromBEEF).not.toHaveBeenCalled()
    })

    it('rethrows WERR_REVIEW_ACTIONS where doubleSpend result has no competingTxs', async () => {
      const error = makeDoubleSpendError([0x01, 0x02], null)
      const operation = jest.fn().mockRejectedValue(error)

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow(error)
      expect(operation).toHaveBeenCalledTimes(1)
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
    })

    it('rethrows WERR_REVIEW_ACTIONS where competingTxs is an empty array', async () => {
      const error = makeDoubleSpendError([0x01, 0x02], [])
      const operation = jest.fn().mockRejectedValue(error)

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow(error)
      expect(operation).toHaveBeenCalledTimes(1)
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
    })
  })

  // --- Retry on doubleSpend -------------------------------------------------

  describe('retries after broadcasting the competing transaction', () => {
    it('broadcasts the competing tx and retries the operation when doubleSpend is detected', async () => {
      const competingBeef = [0xbe, 0xef]
      const competingTxId = COMPETING_TXID_A
      const doubleSpendError = makeDoubleSpendError(competingBeef, [competingTxId])

      const expectedResult = { done: true }
      const operation = jest
        .fn()
        .mockRejectedValueOnce(doubleSpendError) // first attempt: double-spend
        .mockResolvedValueOnce(expectedResult) // second attempt: success

      const result = await withDoubleSpendRetry(operation, broadcaster)

      expect(result).toBe(expectedResult)
      expect(operation).toHaveBeenCalledTimes(2)
      expect(MockedTransaction.fromBEEF).toHaveBeenCalledWith(competingBeef, competingTxId)
      expect(broadcaster.broadcast).toHaveBeenCalledTimes(1)
      expect(broadcaster.broadcast).toHaveBeenCalledWith(mockCompetingTx)
    })

    it('authenticates and broadcasts every unique competing transaction', async () => {
      const competingBeef = [0x01, 0x02, 0x03]
      const firstTxId = COMPETING_TXID_A
      const secondTxId = COMPETING_TXID_B
      const doubleSpendError = makeDoubleSpendError(competingBeef, [firstTxId, secondTxId])

      const operation = jest
        .fn()
        .mockRejectedValueOnce(doubleSpendError)
        .mockResolvedValueOnce('ok')

      await withDoubleSpendRetry(operation, broadcaster)

      expect(MockedTransaction.fromBEEF).toHaveBeenCalledWith(competingBeef, firstTxId)
      expect(MockedTransaction.fromBEEF).toHaveBeenCalledWith(competingBeef, secondTxId)
      expect(broadcaster.broadcast).toHaveBeenCalledTimes(2)
    })

    it('retries multiple times until success', async () => {
      const doubleSpendError = makeDoubleSpendError()

      const operation = jest
        .fn()
        .mockRejectedValueOnce(doubleSpendError) // attempt 1
        .mockRejectedValueOnce(doubleSpendError) // attempt 2
        .mockRejectedValueOnce(doubleSpendError) // attempt 3
        .mockResolvedValueOnce('finally succeeded') // attempt 4

      const result = await withDoubleSpendRetry(operation, broadcaster)

      expect(result).toBe('finally succeeded')
      expect(operation).toHaveBeenCalledTimes(4)
      expect(broadcaster.broadcast).toHaveBeenCalledTimes(3)
    })
  })

  // --- MAX_DOUBLE_SPEND_RETRIES enforcement ----------------------------------

  describe('throws after MAX_DOUBLE_SPEND_RETRIES is exceeded', () => {
    it('throws the error after MAX_DOUBLE_SPEND_RETRIES (5) failed attempts', async () => {
      const doubleSpendError = makeDoubleSpendError()

      // Operation always double-spends — should fail after maxRetries
      const operation = jest.fn().mockRejectedValue(doubleSpendError)

      await expect(
        withDoubleSpendRetry(operation, broadcaster, MAX_DOUBLE_SPEND_RETRIES)
      ).rejects.toThrow(doubleSpendError)

      // Called maxRetries times; the last attempt's error is rethrown without broadcasting
      expect(operation).toHaveBeenCalledTimes(MAX_DOUBLE_SPEND_RETRIES)
      // Broadcast is called for all but the final attempt (last error is rethrown directly)
      expect(broadcaster.broadcast).toHaveBeenCalledTimes(MAX_DOUBLE_SPEND_RETRIES - 1)
    })

    it('throws after custom maxRetries value is exceeded', async () => {
      const doubleSpendError = makeDoubleSpendError()
      const operation = jest.fn().mockRejectedValue(doubleSpendError)

      await expect(withDoubleSpendRetry(operation, broadcaster, 2)).rejects.toThrow(
        doubleSpendError
      )

      expect(operation).toHaveBeenCalledTimes(2)
      expect(broadcaster.broadcast).toHaveBeenCalledTimes(1)
    })

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101])(
      'rejects unsafe maxRetries value %s before invoking the operation',
      async maxRetries => {
        const operation = jest.fn().mockResolvedValue('no')
        await expect(withDoubleSpendRetry(operation, broadcaster, maxRetries)).rejects.toThrow(
          'maxRetries must be an integer'
        )
        expect(operation).not.toHaveBeenCalled()
      }
    )
  })

  // --- Broadcaster interaction -----------------------------------------------

  describe('broadcaster.broadcast is called with the correct transaction', () => {
    it('passes the Transaction.fromBEEF result to broadcaster.broadcast', async () => {
      const competingTxMock = { id: jest.fn().mockReturnValue(COMPETING_TXID_A) }
      ;(MockedTransaction.fromBEEF as jest.Mock).mockReturnValue(competingTxMock)

      const doubleSpendError = makeDoubleSpendError([0xaa, 0xbb], [COMPETING_TXID_A])

      const operation = jest
        .fn()
        .mockRejectedValueOnce(doubleSpendError)
        .mockResolvedValueOnce('done')

      await withDoubleSpendRetry(operation, broadcaster)

      expect(broadcaster.broadcast).toHaveBeenCalledWith(competingTxMock)
    })

    it('does not retry the operation when the overlay rejects conflict synchronization', async () => {
      broadcaster.broadcast.mockResolvedValue({
        status: 'error',
        code: 'ERR_REJECTED',
        description: 'The host rejected the transaction.'
      })
      const operation = jest.fn().mockRejectedValue(makeDoubleSpendError())

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow(
        'Failed to synchronize competing transaction'
      )
      expect(operation).toHaveBeenCalledTimes(1)
    })

    it('does not retry after a mismatched synchronization acknowledgment', async () => {
      broadcaster.broadcast.mockResolvedValue({
        status: 'success',
        txid: COMPETING_TXID_B,
        message: 'Wrong transaction.'
      })
      const operation = jest.fn().mockRejectedValue(makeDoubleSpendError())

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow(
        'ERR_INVALID_RESPONSE'
      )
      expect(operation).toHaveBeenCalledTimes(1)
    })

    it('does not broadcast evidence whose parsed transaction ID differs', async () => {
      ;(MockedTransaction.fromBEEF as jest.Mock).mockReturnValue({
        id: jest.fn().mockReturnValue(COMPETING_TXID_B)
      })
      const operation = jest.fn().mockRejectedValue(makeDoubleSpendError())

      await expect(withDoubleSpendRetry(operation, broadcaster)).rejects.toThrow(
        'does not match its transaction ID'
      )
      expect(broadcaster.broadcast).not.toHaveBeenCalled()
      expect(operation).toHaveBeenCalledTimes(1)
    })
  })
})
