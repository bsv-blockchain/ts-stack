import Transaction from '../transaction/Transaction.js'
import { WERR_REVIEW_ACTIONS } from '../wallet/WERR_REVIEW_ACTIONS.js'
import { ReviewActionResult } from '../wallet/Wallet.interfaces.js'
import TopicBroadcaster from './SHIPBroadcaster.js'

/**
 * Maximum number of retry attempts for double-spend resolution
 */
const MAX_DOUBLE_SPEND_RETRIES = 5

/**
 * Executes an operation with automatic retry logic for double-spend errors.
 * When a double-spend is detected, broadcasts the competing transaction to
 * update the overlay with missing state, then retries the operation.
 *
 * @param operation - The async operation to execute (e.g., createAction + signAction)
 * @param broadcaster - The TopicBroadcaster to use for syncing missing state
 * @param maxRetries - Maximum number of retry attempts (default: MAX_DOUBLE_SPEND_RETRIES)
 * @returns The result of the successful operation
 * @throws If max retries exceeded or non-double-spend error occurs
 */
export async function withDoubleSpendRetry<T> (
  operation: () => Promise<T>,
  broadcaster: TopicBroadcaster,
  maxRetries: number = MAX_DOUBLE_SPEND_RETRIES
): Promise<T> {
  let attempts = 0

  while (attempts < maxRetries) {
    attempts++

    try {
      return await operation()
    } catch (error) {
      // Only handle double-spend errors on non-final attempts
      if (attempts < maxRetries && error.name === 'WERR_REVIEW_ACTIONS') {
        const reviewError = error as WERR_REVIEW_ACTIONS

        // Check if any action in the batch has a double-spend
        const doubleSpendResult = reviewError.reviewActionResults.find(
          (result: ReviewActionResult) => result.status === 'doubleSpend'
        )

        if (doubleSpendResult?.competingBeef != null &&
          doubleSpendResult?.competingTxs != null &&
          doubleSpendResult?.competingTxs.length > 0) {
          const competingTx = Transaction.fromBEEF(
            doubleSpendResult.competingBeef,
            doubleSpendResult.competingTxs[0]
          )

          // Recursively handle double-spend errors during broadcast
          // The broadcast itself might fail if the competing tx depends on another missing tx
          await withDoubleSpendRetry(
            async () => await broadcaster.broadcast(competingTx),
            broadcaster,
            maxRetries - attempts // Reduce max retries based on attempts already used
          )

          continue
        }
      }

      // Non-double-spend error or max retries exceeded - rethrow
      throw error
    }
  }

  // This should never be reached, but TypeScript requires it
  throw new Error('Unexpected end of retry loop')
}
