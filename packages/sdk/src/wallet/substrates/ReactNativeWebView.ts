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
 * A browser-attested origin must belong to this document or to the configured
 * wallet origin; hosts stamp their own origin on synthesized events, which the
 * browser does not attest, so those are matched only when an exact domain is
 * configured. The default wildcard target keeps every React Native host
 * reachable, and configuring an exact origin pins responses to it.
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
        // The host injects responses into this document, so a response comes
        // from this window, from the frame bridging for it, or from a
        // synthesized event without a source. Any other browsing context is
        // not the wallet bridge.
        if (!isBridgeDelivered(e.source)) {
          return
        }
        // Verify the origin of the received message before its data is read.
        // The browser attests the origin of a real postMessage, so a response
        // it delivers must come from this document or from the configured
        // wallet origin.
        if (e.source != null && e.origin !== documentOrigin() && e.origin !== this.domain) {
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
        if (isPinnedOriginMismatch(this.domain, e.origin)) {
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
 * Whether a message was delivered inside the document that made the call: a
 * host-synthesized event carries no source, a bridged `postMessage` comes from
 * this window, and a host that relays through the surrounding frame comes from
 * its parent. Every other browsing context is rejected.
 */
function isBridgeDelivered(source: MessageEventSource | null): boolean {
  const win = globalThis.window
  return source == null || source === win || source === win.parent
}

/**
 * Whether a response violates an exact configured wallet origin. Hosts inject
 * responses without a browser-attested origin, so an absent origin stays
 * acceptable while any other origin must match the configured one.
 */
function isPinnedOriginMismatch(domain: string, origin: string | undefined): boolean {
  return domain !== '*' && origin != null && origin !== '' && origin !== domain
}

/**
 * The origin of the document running this substrate, or an empty string when
 * the environment does not expose one.
 */
function documentOrigin(): string {
  return (globalThis.window as Partial<Window> | undefined)?.location?.origin ?? ''
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
