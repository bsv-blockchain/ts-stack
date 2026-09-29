import { LocalKVStore, PubKeyHex, PublicKey, WalletInterface } from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'

export interface Certifier {
  name: string
  description: string
  identityKey: PubKeyHex
  trust: number
  iconUrl?: string
  baseURL?: string // ?
}
export interface TrustSettings {
  trustLevel: number
  trustedCertifiers: Certifier[]
}
export interface WalletTheme {
  mode: string
}
export interface WalletSettings {
  trustSettings: TrustSettings
  theme?: WalletTheme
  currency?: string
  permissionMode?: string // Vendor-specific permission UX mode identifier
}
export interface WalletSettingsManagerConfig {
  defaultSettings: WalletSettings
}

const MAX_SETTINGS_BYTES = 256 * 1024
const MAX_TRUSTED_CERTIFIERS = 256
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid wallet settings: ${field} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Invalid wallet settings: ${field} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || unsafeKeys.has(key)) {
      throw new Error(`Invalid wallet settings: ${field} contains an unsafe key`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor == null || !('value' in descriptor)) {
      throw new Error(`Invalid wallet settings: ${field}.${key} must be a data property`)
    }
  }
  return value as Record<string, unknown>
}

function data(record: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value
}

function boundedString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`Invalid wallet settings: ${field} must be a string`)
  const length = toArray(value, 'utf8').length
  if (length < minimum || length > maximum) {
    throw new Error(`Invalid wallet settings: ${field} must contain ${minimum}-${maximum} UTF-8 bytes`)
  }
  return value
}

function optionalUrl(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  const encoded = boundedString(value, field, 1, 500)
  let parsed: URL
  try {
    parsed = new URL(encoded)
  } catch {
    throw new Error(`Invalid wallet settings: ${field} must be an absolute HTTP(S) URL`)
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(`Invalid wallet settings: ${field} must be a credential-free HTTP(S) URL`)
  }
  return parsed.toString()
}

function canonicalPublicKey(value: unknown, field: string): PubKeyHex {
  const encoded = boundedString(value, field, 66, 66)
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(encoded)) {
    throw new Error(`Invalid wallet settings: ${field} must be a compressed public key`)
  }
  try {
    if (PublicKey.fromString(encoded).toString() !== encoded) throw new Error('non-canonical')
  } catch {
    throw new Error(`Invalid wallet settings: ${field} must be a compressed public key`)
  }
  return encoded
}

export function validateTrustSettings(value: unknown): TrustSettings {
  const settings = plainRecord(value, 'trustSettings')
  const trustLevel = data(settings, 'trustLevel')
  if (!Number.isSafeInteger(trustLevel) || (trustLevel as number) < 1 || (trustLevel as number) > 2560) {
    throw new Error('Invalid wallet settings: trustLevel must be an integer from 1 to 2560')
  }
  const rawCertifiers = data(settings, 'trustedCertifiers')
  if (!Array.isArray(rawCertifiers) || rawCertifiers.length > MAX_TRUSTED_CERTIFIERS) {
    throw new Error(`Invalid wallet settings: trustedCertifiers must contain at most ${MAX_TRUSTED_CERTIFIERS} entries`)
  }
  const seen = new Set<string>()
  const trustedCertifiers = rawCertifiers.map((entry, index): Certifier => {
    if (!Object.prototype.hasOwnProperty.call(rawCertifiers, index)) {
      throw new Error('Invalid wallet settings: trustedCertifiers must be dense')
    }
    const certifier = plainRecord(entry, `trustedCertifiers[${index}]`)
    const identityKey = canonicalPublicKey(data(certifier, 'identityKey'), `trustedCertifiers[${index}].identityKey`)
    if (seen.has(identityKey)) {
      throw new Error('Invalid wallet settings: trusted certifier identity keys must be unique')
    }
    seen.add(identityKey)
    const trust = data(certifier, 'trust')
    if (!Number.isSafeInteger(trust) || (trust as number) < 1 || (trust as number) > 10) {
      throw new Error(`Invalid wallet settings: trustedCertifiers[${index}].trust must be an integer from 1 to 10`)
    }
    const validated: Certifier = {
      name: boundedString(data(certifier, 'name'), `trustedCertifiers[${index}].name`, 1, 100),
      description: boundedString(data(certifier, 'description'), `trustedCertifiers[${index}].description`, 1, 500),
      identityKey,
      trust: trust as number
    }
    const iconUrl = optionalUrl(data(certifier, 'iconUrl'), `trustedCertifiers[${index}].iconUrl`)
    if (iconUrl !== undefined) validated.iconUrl = iconUrl
    const baseURL = optionalUrl(data(certifier, 'baseURL'), `trustedCertifiers[${index}].baseURL`)
    if (baseURL !== undefined) validated.baseURL = baseURL
    return validated
  })
  return { trustLevel: trustLevel as number, trustedCertifiers }
}

export function validateWalletSettings(value: unknown): WalletSettings {
  const settings = plainRecord(value, 'root')
  const validated: WalletSettings = {
    trustSettings: validateTrustSettings(data(settings, 'trustSettings'))
  }
  const theme = data(settings, 'theme')
  if (theme !== undefined) {
    const themeRecord = plainRecord(theme, 'theme')
    validated.theme = { mode: boundedString(data(themeRecord, 'mode'), 'theme.mode', 1, 64) }
  }
  const currency = data(settings, 'currency')
  if (currency !== undefined) validated.currency = boundedString(currency, 'currency', 1, 16)
  const permissionMode = data(settings, 'permissionMode')
  if (permissionMode !== undefined) {
    validated.permissionMode = boundedString(permissionMode, 'permissionMode', 1, 64)
  }
  return validated
}

const SETTINGS_BASKET = 'wallet settings'

// Defaults can be overridden as needed
export const DEFAULT_SETTINGS = {
  trustSettings: {
    trustLevel: 2,
    trustedCertifiers: [
      {
        name: 'Metanet Trust Services',
        description: 'Registry of protocols, baskets, certificate types',
        iconUrl: 'https://bsvblockchain.org/favicon.ico',
        identityKey: '03daf815fe38f83da0ad83b5bedc520aa488aef5cbc93a93c67a7fe60406cbffe8',
        trust: 4
      },
      {
        name: 'SocialCert',
        description: 'Certifies social media handles, phones and emails',
        iconUrl: 'https://socialcert.net/favicon.ico',
        trust: 3,
        identityKey: '02cf6cdf466951d8dfc9e7c9367511d0007ed6fba35ed42d425cc412fd6cfd4a17'
      }
    ]
  },
  theme: { mode: 'dark' },
  permissionMode: 'simple'
} as WalletSettings

// Mapping of certifier names to their testnet identity keys
const TESTNET_IDENTITY_KEYS: Record<string, string> = {
  'Babbage Trust Services': '03d0b36b5c98b000ec9ffed9a2cf005e279244edf6a19cf90545cdebe873162761',
  IdentiCert: '036dc48522aba1705afbb43df3c04dbd1da373b6154341a875bceaa2a3e7f21528',
  SocialCert: '02cf6cdf466951d8dfc9e7c9367511d0007ed6fba35ed42d425cc412fd6cfd4a17'
}

// Define defaults that can be imported for a testnet environment
export const TESTNET_DEFAULT_SETTINGS: WalletSettings = {
  ...DEFAULT_SETTINGS,
  trustSettings: {
    ...DEFAULT_SETTINGS.trustSettings,
    trustedCertifiers: DEFAULT_SETTINGS.trustSettings.trustedCertifiers.map(certifier => ({
      ...certifier,
      // Use the testnet key if provided, otherwise fallback to the default
      identityKey: TESTNET_IDENTITY_KEYS[certifier.name] || certifier.identityKey
    }))
  }
}

/**
 * Manages wallet settings
 */
export class WalletSettingsManager {
  kv: LocalKVStore
  private readonly config: WalletSettingsManagerConfig

  constructor(
    wallet: WalletInterface,
    config: WalletSettingsManagerConfig = {
      defaultSettings: DEFAULT_SETTINGS
    }
  ) {
    this.config = { defaultSettings: validateWalletSettings(config.defaultSettings) }
    this.kv = new LocalKVStore(wallet, SETTINGS_BASKET, true)
  }

  /**
   * Returns a user's wallet settings
   *
   * @returns - Wallet settings object
   */
  async get(): Promise<WalletSettings> {
    const encoded = await this.kv.get('settings', JSON.stringify(this.config.defaultSettings))
    if (typeof encoded !== 'string' || toArray(encoded, 'utf8').length > MAX_SETTINGS_BYTES) {
      throw new Error('Invalid wallet settings: encoded value is missing or oversized')
    }
    return validateWalletSettings(JSON.parse(encoded))
  }

  /**
   * Creates (or updates) the user's settings token.
   *
   * @param settings - The wallet settings to be stored.
   */
  async set(settings: WalletSettings): Promise<void> {
    const encoded = JSON.stringify(validateWalletSettings(settings))
    if (toArray(encoded, 'utf8').length > MAX_SETTINGS_BYTES) {
      throw new Error('Invalid wallet settings: encoded value is oversized')
    }
    await this.kv.set('settings', encoded)
  }

  /**
   * Deletes the user's settings token.
   */
  async delete(): Promise<void> {
    await this.kv.remove('settings')
  }
}
