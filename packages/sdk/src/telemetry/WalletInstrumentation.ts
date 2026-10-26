import type {
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface
} from '../wallet/Wallet.interfaces.js'
import {
  Telemetry,
  type TelemetryAttributeValue,
  type TelemetryConfig,
  type TelemetrySpanKind
} from './Telemetry.js'

const walletMethodNames = new Set<keyof WalletInterface>([
  'getPublicKey',
  'revealCounterpartyKeyLinkage',
  'revealSpecificKeyLinkage',
  'encrypt',
  'decrypt',
  'createHmac',
  'verifyHmac',
  'createSignature',
  'verifySignature',
  'createAction',
  'signAction',
  'abortAction',
  'listActions',
  'internalizeAction',
  'listOutputs',
  'relinquishOutput',
  'acquireCertificate',
  'listCertificates',
  'proveCertificate',
  'relinquishCertificate',
  'discoverByIdentityKey',
  'discoverByAttributes',
  'isAuthenticated',
  'waitForAuthentication',
  'getHeight',
  'getHeaderForHeight',
  'getNetwork',
  'getVersion'
])

export interface WalletInstrumentationOptions {
  component?: string
  spanNamePrefix?: string
  kind?: TelemetrySpanKind
  /**
   * Optional privacy policy and enrichment hook. The raw arguments are supplied
   * only to consumer code and are never emitted automatically. Hook failure,
   * accessors, non-scalar values, and attempts to replace core attributes are
   * contained and cannot prevent or alter the wallet call.
   */
  attributes?: (
    method: keyof WalletInterface,
    originator: OriginatorDomainNameStringUnder250Bytes | undefined
  ) => Readonly<Record<string, TelemetryAttributeValue>>
}

/**
 * Wraps every BRC-100 method without changing its arguments or results.
 *
 * The first argument object acts as an explicit context carrier. This keeps
 * concurrent browser and React Native calls correlated without global async
 * state and lets downstream Wallet Toolbox layers attach child spans.
 * Optional telemetry adapters cannot suppress, duplicate, or replace a wallet
 * invocation or result.
 */
export function instrumentWallet(
  wallet: WalletInterface,
  config: Telemetry | TelemetryConfig,
  options: WalletInstrumentationOptions = {}
): WalletInterface {
  const telemetry = config instanceof Telemetry ? config : new Telemetry(config)
  let dynamicallyEnabled = false
  try {
    dynamicallyEnabled =
      !(config instanceof Telemetry) && typeof config.enabled === 'function' && config.sink != null
  } catch {
    // A malformed optional telemetry configuration disables instrumentation.
  }
  if (!telemetry.enabled && !dynamicallyEnabled) return wallet

  const component = options.component ?? 'wallet'
  const prefix = options.spanNamePrefix ?? 'wallet.call'
  const kind = options.kind ?? 'internal'
  const methods = new Map<PropertyKey, unknown>()

  return new Proxy(wallet, {
    get(target, property, receiver) {
      if (!walletMethodNames.has(property as keyof WalletInterface)) {
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }

      const cached = methods.get(property)
      if (cached != null) return cached

      const original = Reflect.get(target, property, target)
      if (typeof original !== 'function') return original
      const method = property as keyof WalletInterface
      const wrapped = (
        args: object,
        originator?: OriginatorDomainNameStringUnder250Bytes
      ): unknown => {
        const attributes: Record<string, TelemetryAttributeValue> = Object.create(null)
        attributes['wallet.method'] = String(method)
        let attributeCount = 1
        try {
          const supplied = options.attributes?.(method, originator)
          if (supplied != null && typeof supplied === 'object' && !Array.isArray(supplied)) {
            let inspected = 0
            for (const key of Reflect.ownKeys(supplied)) {
              if (inspected >= 64) break
              inspected += 1
              if (typeof key !== 'string') continue
              const descriptor = Object.getOwnPropertyDescriptor(supplied, key)
              const value = descriptor?.value
              if (
                descriptor != null &&
                Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
                (typeof value === 'string' ||
                  typeof value === 'number' ||
                  typeof value === 'boolean')
              ) {
                if (Object.prototype.hasOwnProperty.call(attributes, key)) continue
                if (attributeCount >= 64) continue
                attributeCount += 1
                attributes[key] = value
              }
            }
          }
        } catch {
          // Instrumentation enrichment must never prevent the wallet call.
        }
        const carrier =
          args != null && (typeof args === 'object' || typeof args === 'function')
            ? args
            : undefined
        return telemetry.withSpan(
          `${prefix}.${String(method)}`,
          {
            component,
            kind,
            carrier,
            attributes
          },
          span => {
            if (carrier !== undefined) span.bind(carrier)
            return original.call(target, args, originator)
          }
        )
      }
      methods.set(property, wrapped)
      return wrapped
    }
  })
}
