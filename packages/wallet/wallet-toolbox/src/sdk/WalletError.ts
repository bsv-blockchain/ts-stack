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
  isError = true as const

  constructor(
    name: string,
    message: string,
    stack?: string,
    public details?: Record<string, string>
  ) {
    super(message)
    this.name = name
    if (stack != null && stack !== '') this.stack = stack
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
  private static nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  private static objectErrorFields(error: Record<string, unknown>): {
    name: string
    message: string
    stack: string | undefined
    details: Record<string, string> | undefined
  } {
    const stringValue = WalletError.nonEmptyString
    const genericName = error.name === 'Error' || error.name === 'FetchError'
    const name = genericName
      ? (stringValue(error.code) ?? stringValue(error.status) ?? 'WERR_UNKNOWN')
      : (stringValue(error.name) ?? stringValue(error.code) ?? stringValue(error.status) ?? 'WERR_UNKNOWN')
    const message = stringValue(error.message) ?? stringValue(error.description) ?? ''
    const stack = typeof error.stack === 'string' ? error.stack : undefined
    const details: Record<string, string> = {}
    if (typeof error.sql === 'string') details.sql = error.sql
    if (typeof error.sqlMessage === 'string') details.sqlMessage = error.sqlMessage
    return {
      name,
      message,
      stack,
      details: Object.keys(details).length > 0 ? details : undefined
    }
  }

  private static copyPublicErrorFields(target: WalletError, source: Record<string, unknown>): void {
    const extensibleTarget = target as WalletError & Record<string, unknown>
    const baseFields = new Set(['status', 'name', 'code', 'message', 'description', 'stack', 'sql', 'sqlMessage'])
    for (const [key, value] of Object.entries(source)) {
      const supportedValue = typeof value === 'string' || typeof value === 'number' || Array.isArray(value)
      if (key === 'walletError') {
        extensibleTarget[key] = WalletError.fromUnknown(value)
      } else if (!baseFields.has(key) && supportedValue) {
        extensibleTarget[key] = value
      }
    }
  }

  static fromUnknown(err: unknown): WalletError {
    if (err instanceof WalletError) return err
    let message = ''
    if (typeof err === 'string') {
      message = err
    } else if (typeof err === 'number') {
      message = err.toString()
    }
    let fields = {
      name: 'WERR_UNKNOWN',
      message,
      stack: undefined as string | undefined,
      details: undefined as Record<string, string> | undefined
    }
    if (err !== null && typeof err === 'object') {
      fields = WalletError.objectErrorFields(err as Record<string, unknown>)
    }
    const e = new WalletError(fields.name, fields.message, fields.stack, fields.details)
    if (err !== null && typeof err === 'object') {
      WalletError.copyPublicErrorFields(e, err as Record<string, unknown>)
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
  static unknownToJson(error: unknown): string {
    let json: string | undefined
    let e: WalletError | undefined
    const t = typeof error
    const ctorName: unknown =
      t === 'object' && error !== null ? (error as Record<string, unknown>).constructor : undefined
    const ctor: string | undefined =
      ctorName != null && typeof (ctorName as Record<string, unknown>).name === 'string'
        ? ((ctorName as Record<string, unknown>).name as string)
        : undefined
    const name = t === 'object' && error !== null && typeof (error as any).name === 'string' ? (error as any).name : ''
    const message =
      t === 'object' && error !== null && typeof (error as any).message === 'string' ? (error as any).message : ''
    const hasToJson: boolean = t === 'object' && typeof (error as any)?.toJson === 'function'
    if (ctor != null && ctor !== '' && ctor.startsWith('WERR_') && hasToJson) {
      json = (error as WalletError).toJson()
    } else if (name !== '' && message !== '') {
      e = new WalletError(name, message)
      json = e.toJson()
    } else {
      e = new WalletError('WERR_UNKNOWN', String(error))
      json = e.toJson()
    }
    return json
  }
}
