import Random from '../../primitives/Random.js'
import * as Utils from '../../primitives/utils.js'
import { WalletError } from '../WalletError.js'
import { CallType } from './WalletWireCalls.js'
import { InvokableWalletBase } from './InvokableWalletBase.js'

export interface ReactNativeWebViewOptions {
  responseTimeoutMs?: number
  userReviewResponseTimeoutMs?: number
}

type ReactNativeWindow = Window & {
  ReactNativeWebView: {
    postMessage: (message: any) => void
  }
}

const DEFAULT_RESPONSE_TIMEOUT_MS = 45000
const DEFAULT_USER_REVIEW_RESPONSE_TIMEOUT_MS = 120000
const USER_REVIEW_CALLS = new Set<CallType>([
  'createAction',
  'signAction',
  'internalizeAction',
  'acquireCertificate',
  'proveCertificate'
])

/**
 * Facilitates wallet operations over cross-document messaging.
 */
export default class ReactNativeWebView extends InvokableWalletBase {
  private readonly domain: string
  private readonly responseTimeoutMs: number
  private readonly userReviewResponseTimeoutMs: number

  constructor (domain: string = '*', options: ReactNativeWebViewOptions = {}) {
    super()
    if (typeof globalThis.window !== 'object') {
      throw new TypeError('The XDM substrate requires a global window object.')
    }
    if (!Object.prototype.hasOwnProperty.call(globalThis.window, 'ReactNativeWebView')) {
      throw new Error(
        'The window object does not have a ReactNativeWebView property.'
      )
    }
    if (typeof (globalThis.window as unknown as ReactNativeWindow).ReactNativeWebView.postMessage !== 'function') {
      throw new TypeError(
        'The window.ReactNativeWebView property does not seem to support postMessage calls.'
      )
    }
    this.domain = domain
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS
    this.userReviewResponseTimeoutMs = options.userReviewResponseTimeoutMs ?? DEFAULT_USER_REVIEW_RESPONSE_TIMEOUT_MS
  }

  private getTimeoutMs (call: CallType): number {
    return USER_REVIEW_CALLS.has(call) ? this.userReviewResponseTimeoutMs : this.responseTimeoutMs
  }

  async invoke (call: CallType, args: any): Promise<any> {
    return await new Promise((resolve, reject) => {
      const id = Utils.toBase64(Random(12))
      const timeoutMs = this.getTimeoutMs(call)
      let settled = false

      const cleanup = (listener: (e: MessageEvent) => void): void => {
        settled = true
        clearTimeout(timeoutId)
        if (
          typeof globalThis.window === 'object' &&
          typeof globalThis.window.removeEventListener === 'function'
        ) {
          globalThis.window.removeEventListener('message', listener)
        }
      }

      const listener = (e: MessageEvent): void => {
        let data: any
        try {
          data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
        } catch {
          return
        }
        if (
          settled ||
          data.type !== 'CWI' ||
          data.id !== id ||
          data.isInvocation === true
        ) {
          return
        }
        cleanup(listener)
        if (data.status === 'error') {
          const err = new WalletError(data.description, data.code)
          reject(err)
        } else {
          resolve(data.result)
        }
      }
      globalThis.window.addEventListener('message', listener)
      const timeoutId = setTimeout(() => {
        if (settled) return
        cleanup(listener)
        reject(new WalletError(`React Native wallet request ${call} timed out after ${timeoutMs}ms.`, 1))
      }, timeoutMs)
      try {
        ;(globalThis.window as unknown as ReactNativeWindow).ReactNativeWebView.postMessage(
          JSON.stringify({
            type: 'CWI',
            isInvocation: true,
            id,
            call,
            args
          })
        )
      } catch (err) {
        cleanup(listener)
        reject(err)
      }
    })
  }
}
