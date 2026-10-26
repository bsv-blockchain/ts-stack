import { toArray } from '@bsv/sdk/primitives/utils'
import {
  decodeAndVerifyRegistryToken,
  decodeAndVerifySignedPushDropToken,
  type DefinitionType,
  LockingScript,
  PublicKey,
  WalletProtocol
} from '@bsv/sdk'
const MAX_REGISTRY_TEXT_BYTES = 4096
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

export function registryText(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = MAX_REGISTRY_TEXT_BYTES
): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const bytes = toArray(value, 'utf8')
  if (bytes.length < minimum || bytes.length > maximum) {
    throw new Error(`${label} has an invalid UTF-8 length`)
  }
  for (const byte of bytes) {
    if (byte < 9 || (byte > 10 && byte < 13) || (byte > 13 && byte < 32) || byte === 127) {
      throw new Error(`${label} contains unsafe control characters`)
    }
  }
  return value
}

export function registryUrl(value: unknown, label: string): string {
  const encoded = registryText(value, label, 1, 2048)
  let parsed: URL
  try {
    parsed = new URL(encoded)
  } catch {
    throw new Error(`${label} must be a valid resource URL`)
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    !isPublicHostname(parsed.hostname)
  ) {
    throw new Error(
      `${label} must be an absolute public HTTPS URL without credentials or a fragment`
    )
  }
  return encoded
}

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home.arpa')
  ) {
    return false
  }
  if (normalized.includes(':')) {
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('::ffff:')
    )
  }
  const octets = normalized.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet))) return true
  const [a, b, c, d] = octets
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

export function registryObject(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      typeof key !== 'string' ||
      unsafeKeys.has(key) ||
      descriptor == null ||
      !('value' in descriptor)
    ) {
      throw new Error(`${label} contains an unsafe property`)
    }
  }
  return value as Record<string, unknown>
}

export function validateRegistryOperator(value: string): string {
  registryText(value, 'Registry operator', 66, 66)
  PublicKey.fromString(value)
  return value
}

export function validateRegistryProtocol(value: string): WalletProtocol {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error('Invalid wallet protocol format.')
  }
  const [security, protocolString] = parsed
  if (security !== 0 && security !== 1 && security !== 2) {
    throw new Error('Invalid security level.')
  }
  if (typeof protocolString !== 'string') throw new TypeError('Invalid protocolID')
  registryText(protocolString, 'Protocol name', 5, 400)
  return [security, protocolString]
}

export async function authenticateRegistryToken(
  definitionType: DefinitionType,
  lockingScript: LockingScript
): Promise<string[]> {
  const fields = await decodeAndVerifyRegistryToken(definitionType, lockingScript)
  validateRegistryOperator(fields.at(-1)!)
  return fields
}

export async function authenticateSignedRegistryToken(
  lockingScript: LockingScript,
  dataFieldCount: number,
  protocolID: WalletProtocol
): Promise<string[]> {
  const fields = await decodeAndVerifySignedPushDropToken(lockingScript, dataFieldCount, protocolID)
  validateRegistryOperator(fields.at(-1)!)
  return fields
}
