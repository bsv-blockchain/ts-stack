/**
 * InfoController
 *
 * Provides a public endpoint with server info: supported Auth Methods, faucet info, etc.
 */

import { Request, Response } from 'express'
import { getSupportedAuthMethodTypes } from '../auth-methods/AuthMethodFactory'
import { readFaucetAmount } from '../config/faucet'

export class InfoController {
  /**
   * Return the WAB server info, including supported Auth Methods, faucet enablement, etc.
   */
  public static getInfo(req: Request, res: Response): void {
    // Hard-coded for demonstration
    const supportedAuthMethods = getSupportedAuthMethodTypes()
    const faucetEnabled = true
    const faucetAmount = readFaucetAmount()

    res.json({
      supportedAuthMethods,
      faucetEnabled,
      faucetAmount
    })
  }
}
