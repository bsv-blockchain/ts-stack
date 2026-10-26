/**
 * FaucetController
 *
 * Provides an endpoint to request faucet payment for a user, returning existing
 * payment data if it already exists, or creating a new payment if it doesn't.
 */

import { Request, Response } from 'express'
import {
  FaucetAlreadyClaimedError,
  FaucetPaymentPendingError,
  UserService
} from '../services/UserService'
import { isHexIdentifier, snapshotRequestBody } from '../security/requestValidation'
import { log } from '../logger'
import { readFaucetAmount } from '../config/faucet'

export class FaucetController {
  /**
   * Request faucet. Body must include { presentationKey }.
   * Return the payment data if new or existing. Only one payment is made per user.
   */
  public static async requestFaucet(req: Request, res: Response) {
    try {
      const body = snapshotRequestBody(req.body)
      if (body == null) {
        return res.status(400).json({ message: 'Request body must be a JSON object.' })
      }
      const faucetEnabled = true // Hardcoded for demonstration
      const faucetAmount = readFaucetAmount()

      if (!faucetEnabled) {
        return res.status(403).json({ message: 'Faucet is disabled.' })
      }

      const { presentationKey } = body
      if (!isHexIdentifier(presentationKey)) {
        return res.status(400).json({ message: 'A 32-byte presentationKey is required.' })
      }

      const user = await UserService.getUserByPresentationKey(presentationKey)
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }

      // Check if any of the user's auth methods have already received faucet
      const authMethods = await UserService.getAuthMethodsByUserId(user.id)
      const hasReceivedFaucet = authMethods.some(am => am.receivedFaucet)

      // A ready payment is deliberately replayable to the same current
      // account so a lost HTTP response cannot strand its one-time
      // R-puzzle secret. An orphaned/relinked identity with no payment on
      // the current user remains ineligible for a second payout.
      const payment = await UserService.getOrCreateFaucetPayment(
        user.id,
        faucetAmount,
        !hasReceivedFaucet
      )

      res.json({
        success: true,
        paymentData: {
          amount: payment.amount,
          txid: payment.txid,
          outputIndex: payment.outputIndex,
          k: payment.k,
          tx: [...payment.beef]
        }
      })
    } catch (error: any) {
      if (error instanceof FaucetAlreadyClaimedError) {
        return res.status(403).json({
          message: 'This account has already received a faucet payment'
        })
      }
      if (error instanceof FaucetPaymentPendingError) {
        return res.status(503).json({
          message: 'Faucet payment is pending reconciliation. Retry later.'
        })
      }
      log.error(
        { operation: 'controller.faucet.request', err: error, outcome: 'error' },
        'requestFaucet failed'
      )
      return res.status(500).json({ message: 'An internal error occurred.' })
    }
  }
}
