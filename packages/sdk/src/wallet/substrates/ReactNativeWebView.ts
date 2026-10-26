import Random from '../../primitives/Random.js'
import { toArray, toBase64, toUint8Array } from '../../primitives/utils.js'
import { WalletError, walletErrors } from '../WalletError.js'
import { CallType } from './WalletWireCalls.js'
import { InvokableWalletBase } from './InvokableWalletBase.js'
import { normalizeBRC100WalletByteFields, stringifyBRC100 } from '../BRC100ByteEncoding.js'
import { validateWalletResult } from '../WalletResultValidation.js'

type ReactNativeWindow = Window & {
  ReactNativeWebView: {
    postMessage: (message: any) => void
  }
}

const MAX_PENDING_REACT_NATIVE_INVOCATIONS = 1024
const MAX_REACT_NATIVE_RESPONSE_TIMEOUT_MS = 60 * 60 * 1000
const MAX_REACT_NATIVE_MESSAGE_BYTES = 256 * 1024 * 1024

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
  private pendingInvocations = 0

  constructor(domain: string = '*', responseTimeout?: number) {
    super()
    if (typeof globalThis.window !== 'object') {
      throw new TypeError('The XDM substrate requires a global window object.')
    }
    if (
      !Object.prototype.hasOwnProperty.call(
        globalThis.window as unknown as ReactNativeWindow,
        'ReactNativeWebView'
      )
    ) {
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
    if (
      responseTimeout !== undefined &&
      (!Number.isSafeInteger(responseTimeout) ||
        responseTimeout < 1 ||
        responseTimeout > MAX_REACT_NATIVE_RESPONSE_TIMEOUT_MS)
    ) {
      throw new TypeError(
        `ReactNativeWebView responseTimeout must be an integer from 1 to ${MAX_REACT_NATIVE_RESPONSE_TIMEOUT_MS}.`
      )
    }
    this.domain = normalizeOrigin(domain)
    this.responseTimeout = responseTimeout
  }

  protected override async invokeRaw(
    call: CallType,
    args: any,
    bindingRequest: unknown
  ): Promise<any> {
    if (this.pendingInvocations >= MAX_PENDING_REACT_NATIVE_INVOCATIONS) {
      throw new Error('React Native wallet pending invocation limit reached.')
    }
    const id = toBase64(Random(12))
    this.pendingInvocations++
    return await new Promise((resolve, reject) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      let listenerRegistered = false
      let active = true
      const cleanup = (): void => {
        if (!active) return
        active = false
        this.pendingInvocations--
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        if (listenerRegistered && typeof globalThis.window.removeEventListener === 'function') {
          try {
            globalThis.window.removeEventListener('message', listener)
          } catch {
            // Cleanup failures must not retain the invocation or replace the
            // operation's actual result.
          }
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
        if (typeof e.data !== 'string') return
        if (toUint8Array(e.data, 'utf8').length > MAX_REACT_NATIVE_MESSAGE_BYTES) {
          cleanup()
          reject(new Error('React Native wallet response exceeds the maximum permitted size.'))
          return
        }
        let data: any
        try {
          data = JSON.parse(e.data)
        } catch {
          return
        }
        if (
          data?.type !== 'CWI' ||
          data.id !== id ||
          data.isInvocation !== false ||
          (data.status !== 'success' && data.status !== 'error')
        ) {
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
        if (data.status === 'error') {
          if (
            typeof data.description !== 'string' ||
            toArray(data.description, 'utf8').length > 4096 ||
            !Number.isSafeInteger(data.code) ||
            data.code < 1 ||
            data.code > 255
          ) {
            reject(new Error('Invalid React Native wallet error response.'))
          } else {
            const isAssignedCode =
              data.code >= walletErrors.unsupportedAction && data.code <= walletErrors.abortRefused
            const description = isAssignedCode ? data.description : 'Wallet operation failed'
            reject(
              new WalletError(description, isAssignedCode ? data.code : walletErrors.unknownError)
            )
          }
        } else {
          try {
            const result = normalizeBRC100WalletByteFields(data.result)
            resolve(validateWalletResult(call, result, bindingRequest))
          } catch (error) {
            reject(error)
          }
        }
      }
      try {
        globalThis.window.addEventListener('message', listener)
        listenerRegistered = true
        if (this.responseTimeout !== undefined) {
          timeoutHandle = setTimeout(() => {
            cleanup()
            reject(new Error('React Native wallet response timed out.'))
          }, this.responseTimeout)
        }
        const message = stringifyBRC100({
          type: 'CWI',
          isInvocation: true,
          id,
          call,
          args
        })
        if (toUint8Array(message, 'utf8').length > MAX_REACT_NATIVE_MESSAGE_BYTES) {
          throw new Error('React Native wallet request exceeds the maximum permitted size.')
        }
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
  const from = e.source
  if (from == null || from === win) return true
  return from === win.parent && (e.origin === win.origin || e.origin === domain)
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
