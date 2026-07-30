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
   * only to consumer code and are never emitted automatically.
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
 */
export function instrumentWallet(
  wallet: WalletInterface,
  config: Telemetry | TelemetryConfig,
  options: WalletInstrumentationOptions = {}
): WalletInterface {
  const telemetry = config instanceof Telemetry ? config : new Telemetry(config)
  if (!telemetry.enabled) return wallet

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
      ): unknown =>
        telemetry.withSpan(
          `${prefix}.${String(method)}`,
          {
            component,
            kind,
            carrier: args,
            attributes: {
              'wallet.method': String(method),
              ...options.attributes?.(method, originator)
            }
          },
          span => {
            span.bind(args)
            return original.call(target, args, originator)
          }
        )
      methods.set(property, wrapped)
      return wrapped
    }
  })
}
