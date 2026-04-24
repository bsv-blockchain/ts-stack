import { ErrorCodeString10To40Bytes, ErrorDescriptionString20To200Bytes, WalletErrorObject } from '@bsv/sdk'

/**
 * Derived class constructors should use the derived class name as the value for `name`,
 * and an internationalizable constant string for `message`.
 *
 * If a derived class intends to wrap another WalletError, the public property should
 * be named `walletError` and will be recovered by `fromUnknown`.
 *
 * Optionaly, the derived class `message` can include template parameters passed in
 * to the constructor. See WERR_MISSING_PARAMETER for an example.
 *
 * To avoid derived class name colisions, packages should include a package specific
 * identifier after the 'WERR_' prefix. e.g. 'WERR_FOO_' as the prefix for Foo package error
 * classes.
 */
export class WalletError extends Error implements WalletErrorObject {
  // Facilitates detection of Error objects from non-error return values.
  isError: true = true

  constructor(
    name: string,
    message: string,
    stack?: string,
    public details?: Record<string, string>
  ) {
    super(message)
    this.name = name
    if (stack) this.stack = stack
  }

  /**
   * Error class compatible accessor for  `code`.
   */
  get code(): ErrorCodeString10To40Bytes {
    return this.name
  }
  set code(v: ErrorCodeString10To40Bytes) {
    this.name = v
  }

  /**
   * Error class compatible accessor for `description`.
   */
  get description(): ErrorDescriptionString20To200Bytes {
    return this.message
  }
  set description(v: ErrorDescriptionString20To200Bytes) {
    this.message = v
  }

  /**
   * Recovers all public fields from WalletError derived error classes and relevant Error derived errors.
   *
   */
  static fromUnknown(err: unknown): WalletError {
    if (err instanceof WalletError) return err
    let name = 'WERR_UNKNOWN'
    let message = typeof err === 'string' ? err : typeof err === 'number' ? err.toString() : ''
    let stack: string | undefined
    const details: Record<string, string> = {}
    if (err !== null && typeof err === 'object') {
      if (err['name'] === 'Error' || err['name'] === 'FetchError') name = err['code'] || err['status'] || 'WERR_UNKNOWN'
      else name = err['name'] || err['code'] || err['status'] || 'WERR_UNKNOWN'
      if (typeof name !== 'string') name = 'WERR_UNKNOWN'

      message = err['message'] || err['description'] || ''
      if (typeof message !== 'string') message = 'WERR_UNKNOWN'

      if (typeof err['stack'] === 'string') stack = err['stack']

      if (typeof err['sql'] === 'string') details.sql = err['sql']
      if (typeof err['sqlMessage'] === 'string') details.sqlMessage = err['sqlMessage']
    }
    const e = new WalletError(name, message, stack, Object.keys(details).length > 0 ? details : undefined)
    if (err !== null && typeof err === 'object') {
      for (const [key, value] of Object.entries(err)) {
        if (key !== 'walletError' && typeof value !== 'string' && typeof value !== 'number' && !Array.isArray(value))
          continue
        switch (key) {
          case 'walletError':
            e[key] = WalletError.fromUnknown(value)
            break
          case 'status':
            break
          case 'name':
            break
          case 'code':
            break
          case 'message':
            break
          case 'description':
            break
          case 'stack':
            break
          case 'sql':
            break
          case 'sqlMessage':
            break
          default:
            e[key] = value
            break
        }
      }
    }
    return e
  }

  /**
   * @returns standard HTTP error status object with status property set to 'error'.
   */
  asStatus(): { status: string; code: string; description: string } {
    return {
      status: 'error',
      code: this.name,
      description: this.message
    }
  }

  /**
   * Base class default JSON serialization.
   * Captures just the name and message properties.
   *
   * Override this method to safely (avoid deep, large, circular issues) serialize
   * derived class properties.
   *
   * @returns stringified JSON representation of the WalletError.
   */
  protected toJson(): string {
    const e = new WalletError(this.name, this.message)
    const json = JSON.stringify({
      isError: true,
      name: e.name,
      message: e.message
    })
    return json
  }

  /**
   * Safely serializes a WalletError derived, WERR_REVIEW_ACTIONS (special case), Error or unknown error to JSON.
   *
   * Safely means avoiding deep, large, circular issues.
   *
   * @param error
   * @returns stringified JSON representation of the error such that it can be desirialized to a WalletError.
   */
  static unknownToJson(error: unknown | WalletError): string {
    let json: string | undefined
    let e: WalletError | undefined
    const t = typeof error
    const ctor = t === 'object' && error !== null ? (error as any).constructor?.name : undefined
    const name = t === 'object' && error !== null && typeof (error as any).name === 'string' ? (error as any).name : ''
    const message =
      t === 'object' && error !== null && typeof (error as any).message === 'string' ? (error as any).message : ''
    const toJson =
      t === 'object' && error !== null && typeof (error as any).toJson === 'function'
        ? (error as any).toJson
        : undefined
    if (ctor && ctor.startsWith('WERR_') && toJson !== undefined) {
      json = (error as WalletError).toJson()
    } else if (name && message) {
      e = new WalletError(name, message)
      json = e.toJson()
    } else {
      e = new WalletError('WERR_UNKNOWN', String(error))
      json = e.toJson()
    }
    return json
  }
}
