export class WalletError extends Error {
  code: number
  isError: boolean = true

  constructor (message: string, code = 1, stack?: string) {
    super(message)
    this.code = code
    this.name = this.constructor.name

    if (stack !== undefined && stack !== null && stack !== '') {
      this.stack = stack
    } else {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  /**
   * Safely serializes a WalletError (including special cases), Error or unknown error to JSON.
   *
   * Safely means avoiding deep, large, circular issues.
   *
   * Example deserialization can be found in HTTPWalletJSON.ts of bsv ts-sdk.
   *
   * @param error
   * @returns stringified JSON representation of the error such that it can be deserialized to a WalletError.
   */
  static unknownToJson (error: any): string {
    let e: any | undefined
    if (error.isError === true && String(error.name).startsWith('WERR_')) {
      e = {
        name: error.name,
        message: error.message,
        isError: true
      }
      if (e.name === 'WERR_REVIEW_ACTIONS') {
        e.reviewActionResults = error.reviewActionResults
        e.sendWithResults = error.sendWithResults
        e.txid = error.txid
        e.tx = error.tx
        e.noSendChange = error.noSendChange
        e.code = 5
      } else if (e.name === 'WERR_INVALID_PARAMETER') {
        e.parameter = error.parameter
        e.code = 6
      } else if (e.name === 'WERR_INSUFFICIENT_FUNDS') {
        e.totalSatoshisNeeded = error.totalSatoshisNeeded
        e.moreSatoshisNeeded = error.moreSatoshisNeeded
        e.code = 7
      }
    } else if (error instanceof Error) {
      e = {
        name: error.constructor.name,
        message: error.message,
        isError: true
      }
    } else {
      e = {
        name: 'WERR_UNKNOWN',
        message: String(error),
        isError: true
      }
    }
    const json = JSON.stringify(e)
    return json
  }
}

// NOTE: Enum values must not exceed the UInt8 range (0–255)
export enum walletErrors {
  unknownError = 1,
  unsupportedAction = 2,
  invalidHmac = 3,
  invalidSignature = 4,
  reviewActions = 5,
  invalidParameter = 6,
  insufficientFunds = 7,
}

export type WalletErrorCode = keyof typeof walletErrors

export default WalletError
