import Random from '../../primitives/Random.js'
import * as Utils from '../../primitives/utils.js'
import { WalletError } from '../WalletError.js'
import { CallType } from './WalletWireCalls.js'
import { InvokableWalletBase } from './InvokableWalletBase.js'
import { normalizeBRC100WalletByteFields, stringifyBRC100 } from '../BRC100ByteEncoding.js'

type ReactNativeWindow = Window & {
  ReactNativeWebView: {
    postMessage: (message: any) => void
  }
}

/**
 * Facilitates wallet operations over cross-document messaging.
 */
export default class ReactNativeWebView extends InvokableWalletBase {
  private readonly domain: string
  private readonly responseTimeout?: number

  constructor(domain: string = '*', responseTimeout?: number) {
    super()
    if (typeof globalThis.window !== 'object') {
      throw new TypeError('The XDM substrate requires a global window object.')
    }
    if (!(globalThis.window as unknown as ReactNativeWindow).hasOwnProperty('ReactNativeWebView')) {
      throw new Error('The window object does not have a ReactNativeWebView property.')
    }
    if (
      typeof (globalThis.window as unknown as ReactNativeWindow).ReactNativeWebView.postMessage !==
      'function'
    ) {
      throw new TypeError(
        'The window.ReactNativeWebView property does not seem to support postMessage calls.'
      )
    }
    this.domain = normalizeOrigin(domain)
    this.responseTimeout = responseTimeout
  }

  async invoke(call: CallType, args: any): Promise<any> {
    return await new Promise((resolve, reject) => {
      const id = Utils.toBase64(Random(12))
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        if (typeof globalThis.window.removeEventListener === 'function') {
          globalThis.window.removeEventListener('message', listener)
        }
      }
      const listener = (e: MessageEvent): void => {
        let data: any
        try {
          data = JSON.parse(e.data)
        } catch {
          return
        }
        if (data?.type !== 'CWI' || data.id !== id || data.isInvocation === true) {
          return
        }
        if (
          this.domain !== '*' &&
          e.origin != null &&
          e.origin !== '' &&
          e.origin !== this.domain
        ) {
          cleanup()
          reject(
            new Error(
              `React Native wallet response origin ${e.origin} did not match ${this.domain}.`
            )
          )
          return
        }
        cleanup()
        normalizeBRC100WalletByteFields(data.result)
        if (data.status === 'error') {
          const err = new WalletError(data.description, data.code)
          reject(err)
        } else {
          resolve(data.result)
        }
      }
      globalThis.window.addEventListener('message', listener)
      if (this.responseTimeout !== undefined) {
        timeoutHandle = setTimeout(() => {
          cleanup()
          reject(new Error('React Native wallet response timed out.'))
        }, this.responseTimeout)
      }
      try {
        const message = stringifyBRC100({
          type: 'CWI',
          isInvocation: true,
          id,
          call,
          args
        })
        ;(globalThis.window as unknown as ReactNativeWindow).ReactNativeWebView.postMessage(message)
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }
}

function normalizeOrigin(domain: string): string {
  if (domain === '*') return domain
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(domain) && !/^https?:\/\//i.test(domain)) {
      throw new TypeError()
    }
    const candidate = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
    const origin = new URL(candidate).origin
    if (origin === 'null') throw new TypeError()
    return origin
  } catch {
    throw new TypeError('ReactNativeWebView domain must be an HTTP(S) origin or domain name.')
  }
}
