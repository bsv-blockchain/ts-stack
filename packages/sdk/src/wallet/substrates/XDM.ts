import Random from '../../primitives/Random.js'
import * as Utils from '../../primitives/utils.js'
import { WalletError } from '../WalletError.js'
import { CallType } from './WalletWireCalls.js'
import { InvokableWalletBase } from './InvokableWalletBase.js'

interface CWIResponse {
  type: 'CWI'
  isInvocation: false
  id: string
  status: 'success' | 'error'
  result?: unknown
  description?: string
  code?: number
}

function isCWIResponse (value: unknown, id: string): value is CWIResponse {
  if (typeof value !== 'object' || value === null) return false
  const response = value as Record<string, unknown>
  if (
    response.type !== 'CWI' ||
    response.isInvocation !== false ||
    response.id !== id
  ) {
    return false
  }
  if (response.status === 'success') return true
  return response.status === 'error' &&
    typeof response.description === 'string' &&
    typeof response.code === 'number' &&
    Number.isSafeInteger(response.code)
}

/**
 * Facilitates wallet operations over cross-document messaging.
 *
 * The default wildcard target supports wallets embedded by public web apps,
 * including callers with opaque origins. Configure an exact origin when the
 * parent is known. Responses must always come from the current parent window;
 * exact-origin mode additionally requires the configured origin.
 */
export default class XDMSubstrate extends InvokableWalletBase {
  private readonly domain: string

  constructor(domain: string = '*') {
    super()
    if (typeof globalThis.window !== 'object') {
      throw new TypeError('The XDM substrate requires a global window object.')
    }
    if (typeof globalThis.window.postMessage !== 'function') {
      throw new TypeError(
        'The window object does not seem to support postMessage calls.'
      )
    }
    this.domain = domain
  }

  async invoke(call: CallType, args: any): Promise<any> {
    return await new Promise((resolve, reject) => {
      const id = Utils.toBase64(Random(12))
      const listener = (e: MessageEvent): void => {
        if (
          !e.isTrusted ||
          e.source !== window.parent ||
          (this.domain !== '*' && e.origin !== this.domain) ||
          !isCWIResponse(e.data, id)
        ) { return }
        if (typeof window.removeEventListener === 'function') {
          window.removeEventListener('message', listener)
        }
        if (e.data.status === 'error') {
          const err = new WalletError(e.data.description, e.data.code)
          reject(err)
        } else {
          resolve(e.data.result)
        }
      }
      window.addEventListener('message', listener)
      window.parent.postMessage(
        {
          type: 'CWI',
          isInvocation: true,
          id,
          call,
          args
        },
        this.domain
      )
    })
  }
}
