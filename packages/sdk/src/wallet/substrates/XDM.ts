import Random from '../../primitives/Random.js'
import { toArray, toBase64 } from '../../primitives/utils.js'
import { WalletError, walletErrors } from '../WalletError.js'
import { CallType } from './WalletWireCalls.js'
import { InvokableWalletBase } from './InvokableWalletBase.js'
import { validateWalletResult } from '../WalletResultValidation.js'

type CWIResponse = {
  type: 'CWI'
  isInvocation: false
  id: string
} & (
  { status: 'success'; result?: unknown } | { status: 'error'; description: string; code: number }
)

const MAX_PENDING_XDM_INVOCATIONS = 1024
const MAX_XDM_RESPONSE_TIMEOUT_MS = 60 * 60 * 1000

function isCWIResponse(value: unknown, id: string): value is CWIResponse {
  if (typeof value !== 'object' || value === null) return false
  const response = value as Record<string, unknown>
  if (response.type !== 'CWI' || response.isInvocation !== false || response.id !== id) {
    return false
  }
  if (response.status === 'success') return true
  return (
    response.status === 'error' &&
    typeof response.description === 'string' &&
    toArray(response.description, 'utf8').length <= 4096 &&
    typeof response.code === 'number' &&
    Number.isSafeInteger(response.code) &&
    response.code >= 1 &&
    response.code <= 255
  )
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
  private readonly responseTimeout?: number
  private pendingInvocations = 0

  constructor(domain: string = '*', responseTimeout?: number) {
    super()
    if (typeof globalThis.window !== 'object') {
      throw new TypeError('The XDM substrate requires a global window object.')
    }
    if (typeof globalThis.window.postMessage !== 'function') {
      throw new TypeError('The window object does not seem to support postMessage calls.')
    }
    if (
      responseTimeout !== undefined &&
      (!Number.isSafeInteger(responseTimeout) ||
        responseTimeout < 1 ||
        responseTimeout > MAX_XDM_RESPONSE_TIMEOUT_MS)
    ) {
      throw new TypeError(
        `XDM responseTimeout must be an integer from 1 to ${MAX_XDM_RESPONSE_TIMEOUT_MS}.`
      )
    }
    this.domain = domain
    this.responseTimeout = responseTimeout
  }

  protected override async invokeRaw(
    call: CallType,
    args: any,
    bindingRequest: unknown
  ): Promise<any> {
    if (this.pendingInvocations >= MAX_PENDING_XDM_INVOCATIONS) {
      throw new Error('XDM wallet pending invocation limit reached.')
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
        if (listenerRegistered && typeof window.removeEventListener === 'function') {
          try {
            window.removeEventListener('message', listener)
          } catch {
            // Cleanup failures must not retain the invocation or replace the
            // operation's actual result.
          }
        }
      }
      const listener = (e: MessageEvent): void => {
        if (
          !e.isTrusted ||
          e.source !== window.parent ||
          (this.domain !== '*' && e.origin !== this.domain) ||
          !isCWIResponse(e.data, id)
        ) {
          return
        }
        cleanup()
        if (e.data.status === 'error') {
          const isAssignedCode =
            e.data.code >= walletErrors.unsupportedAction &&
            e.data.code <= walletErrors.abortRefused
          const description = isAssignedCode ? e.data.description : 'Wallet operation failed'
          const err = new WalletError(
            description,
            isAssignedCode ? e.data.code : walletErrors.unknownError
          )
          reject(err)
        } else {
          try {
            resolve(validateWalletResult(call, e.data.result, bindingRequest))
          } catch (error) {
            reject(error)
          }
        }
      }
      try {
        window.addEventListener('message', listener)
        listenerRegistered = true
        if (this.responseTimeout !== undefined) {
          timeoutHandle = setTimeout(() => {
            cleanup()
            reject(new Error('XDM wallet response timed out.'))
          }, this.responseTimeout)
        }
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
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }
}
