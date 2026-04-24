import { Beef, CreateActionArgs, WalletInterface, WalletLoggerInterface, WalletLoggerLog } from '@bsv/sdk'
import { WalletError } from './sdk/WalletError'

export class WalletLogger implements WalletLoggerInterface {
  indent: number = 0
  logs: WalletLoggerLog[] = []
  isOrigin: boolean = true
  isError: boolean = false
  level?: WalletLoggerLevel
  flushFormat?: 'json'

  constructor(log?: string | WalletLoggerInterface) {
    if (log) {
      const lo = typeof log === 'string' ? JSON.parse(log) : log
      this.indent = lo.indent || 0
      this.logs = lo.logs || []
      this.isOrigin = this.indent === 0
      this.level = lo.level
    }
  }

  private logAny(message?: any): string {
    if (!message) return ''
    if (typeof message === 'string') return message
    if (typeof message === 'object') return JSON.stringify(message)
    return ''
  }

  private toAdd(
    isBegin: boolean,
    isEnd: boolean,
    isError: boolean,
    message?: any,
    optionalParams?: any[]
  ): WalletLoggerLog {
    let add = ''
    if (message) add += this.logAny(message)
    if (optionalParams) for (const p of optionalParams) add += this.logAny(p)
    let log = {
      when: Date.now(),
      indent: this.indent,
      isBegin,
      isEnd,
      isError,
      log: add
    }
    return log
  }

  private stampLog(isBegin: boolean, isEnd: boolean, isError: boolean, message?: any, optionalParams?: any[]) {
    const add = this.toAdd(isBegin, isEnd, isError, message, optionalParams)
    this.logs.push(add)
  }

  group(...label: any[]): void {
    this.stampLog(true, false, false, undefined, label)
    this.indent++
  }

  groupEnd(): void {
    this.indent--
    if (this.indent < 0) this.indent = 0
    this.stampLog(false, true, false)
  }

  log(message?: any, ...optionalParams: any[]): void {
    this.stampLog(false, false, false, message, optionalParams)
  }
  error(message?: any, ...optionalParams: any[]): void {
    this.stampLog(false, false, true, message, optionalParams)
    this.isError = true
  }

  toWalletLoggerJson(): object {
    const json: object = {
      isWalletLoggerJson: true,
      indent: this.indent,
      logs: this.logs,
      isError: this.isError
    }
    return json
  }

  toLogString(): string {
    let log = ''
    if (this.logs.length > 0) {
      const first = this.logs[0]
      const last = this.logs.slice(-1)[0]
      const msecs = last.when - first.when
      log += `   msecs WalletLogger ${new Date(first.when).toISOString()} logged ${msecs / 1000} seconds\n`
      let prev = first
      const begins: WalletLoggerLog[] = []
      for (const d of this.logs) {
        let df = (d.when - prev.when).toString()
        df = `${' '.repeat(8 - df.length)}${df}`
        const what = d.isBegin ? ' begin' : d.isEnd ? ' end' : d.isError ? ' ERROR' : ''
        if (d.isBegin) begins.push(d)
        let m = d.log
        if (!m && d.isEnd && begins.length > 0) {
          const begin = begins.pop()!
          m = begin.log
        }
        log += `${df}${'  '.repeat(d.indent)}${what} ${m}\n`
        prev = d
      }
    }
    return log
  }

  flush(): object | undefined {
    if (this.logs.length > 0) {
      const trace = this.toLogString()
      const output = this.isError ? console.error : console.log
      if (this.flushFormat === 'json') {
        const name = this.logs[0].log
        const log = {
          name,
          trace
        }
        output(JSON.stringify(log))
      } else {
        output(trace)
      }
    }
    const r = this.isOrigin ? undefined : this.toWalletLoggerJson()
    return r
  }

  merge(log: WalletLoggerInterface): void {
    if (log.logs) {
      this.logs.push(...log.logs)
    }
  }
}

export function logWalletError(eu: unknown, logger?: WalletLoggerInterface, label?: string): void {
  if (!logger) return
  logger.error(label || 'WalletError', WalletError.unknownToJson(eu))
}

export function logCreateActionArgs(args: CreateActionArgs): object {
  const o: any = {
    description: args.description
  }
  if (args.labels) o.labels = args.labels
  if (args.inputBEEF) o.inputBEEF = Beef.fromBinary(args.inputBEEF).toLogString()
  if (args.lockTime !== undefined) o.lockTime = args.lockTime
  if (args.version !== undefined) o.version = args.version
  /*
    if (args.inputs) {

    }
    if (args.outputs) {

    }
    options: validateCreateActionOptions(args.options),
    isSendWith: false,
    isDelayed: false,
    isNoSend: false,
    isNewTx: false,
    isRemixChange: false,
    isSignAction: false,
    randomVals: undefined,
    includeAllSourceTransactions: false,
    isTestWerrReviewActions: false
  */
  return o
}

/**
 * Optional. Logging levels that may influence what is logged.
 *
 * 'error' Only requests resulting in an exception should be logged.
 * 'warn' Also log requests that succeed but with an abnormal condition.
 * 'info' Also log normal successful requests.
 * 'debug' Add input parm and result details where possible.
 * 'trace' Instead of adding debug details, focus on execution path and timing.
 */
export type WalletLoggerLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

/**
 * Constructor properties available to `WalletLogger`
 */
export interface WalletLoggerArgs {
  /**
   * Optional. Logging levels that may influence what is logged.
   *
   * 'error' Only requests resulting in an exception should be logged.
   * 'warn' Also log requests that succeed but with an abnormal condition.
   * 'info' Also log normal successful requests.
   * 'debug' Add input parm and result details where possible.
   * 'trace' Instead of adding debug details, focus on execution path and timing.
   */
  level?: 'error' | 'warn' | 'info' | 'debug' | 'trace'

  /**
   * Valid if an accumulating logger. Count of `group` calls without matching `groupEnd`.
   */
  indent?: number
  /**
   * True if this is an accumulating logger and the logger belongs to the object servicing the initial request.
   */
  isOrigin?: boolean
  /**
   * True if this is an accumulating logger and an error was logged.
   */
  isError?: boolean

  /**
   * Optional array of accumulated logged data and errors.
   */
  logs?: WalletLoggerLog[]
}
