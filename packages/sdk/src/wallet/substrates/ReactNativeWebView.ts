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
 *
 * A React Native host answers a BRC-100 invocation by injecting the response
 * into the document that made the call, so a response is delivered by this
 * window, by the frame bridging for it, or by a host-synthesized event that
 * carries no source at all. Messages from any other browsing context - a
 * framed document, an opener, or a sandboxed frame reporting an opaque origin
 * - are never wallet responses and are ignored before their payload is read.
 * A relaying host frame is a separate browsing context, so its browser-attested
 * origin must belong to this document or to the configured wallet origin.
 * Whatever origin a host stamps on an event it synthesizes in this document is
 * accepted, because the browser does not attest it and the injection is already
 * same-origin; configuring an exact domain additionally pins every response to
 * that origin, while the default wildcard target keeps every host reachable.
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
        // The host injects the response into this document, so a response is
        // delivered by this window or by a synthesized event that carries no
        // source. The frame bridging for it may relay one, and being a separate
        // browsing context it has a browser-attested origin, which has to be
        // this document's origin or the configured wallet origin. Verify that
        // before the payload is read: every other context - a framed document,
        // an opener, or a sandboxed frame reporting an opaque origin - is not
        // the wallet bridge.
        if (!isBridgeDelivered(e, this.domain)) {
          return
        }
        let data: any
        try {
          data = JSON.parse(e.data)
        } catch {
          return
        }
        if (data?.type !== 'CWI' || data.id !== id || data.isInvocation === true) {
          return
        }
        // A configured domain also pins host-synthesized responses, which
        // carry whatever origin - commonly none - the host stamped on them.
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

/**
 * Whether a message reached this document the way a React Native host delivers
 * a response: synthesized in this document, posted by this window, or relayed
 * by the frame bridging for it. A relaying frame is a separate browsing
 * context, so the browser attests its origin, which then has to be this
 * document's origin or the configured wallet origin.
 */
function isBridgeDelivered(e: MessageEvent, domain: string): boolean {
  const win = globalThis.window
  if (e.source == null || e.source === win) return true
  if (e.source !== win.parent) return false
  return e.origin === win.location?.origin || e.origin === domain
}

function normalizeOrigin(domain: string): string {
  if (domain === '*') return domain
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(domain) && !/^https?:\/\//i.test(domain)) {
      throw new TypeError('Only HTTP(S) origins are supported.')
    }
    const candidate = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
    const origin = new URL(candidate).origin
    if (origin === 'null') throw new TypeError('The origin could not be normalized.')
    return origin
  } catch {
    throw new TypeError('ReactNativeWebView domain must be an HTTP(S) origin or domain name.')
  }
}
