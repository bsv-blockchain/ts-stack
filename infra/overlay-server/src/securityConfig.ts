import { PrivateKey, PublicKey } from '@bsv/sdk'

const MAX_STATIC_DENYLIST_ENTRIES = 10_000
const MAX_STATIC_DENYLIST_BYTES = 1024 * 1024

type Environment = Record<string, string | undefined>

export const readBooleanEnv = (
  environment: Environment,
  name: string,
  defaultValue: boolean
): boolean => {
  const value = environment[name]
  if (value === undefined || value === '') return defaultValue
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  throw new TypeError(`${name} must be one of true, false, 1, 0, yes, or no`)
}

const requireValue = (environment: Environment, name: string): string => {
  const value = environment[name]
  if (value === undefined || value === '') {
    throw new TypeError(`Missing required environment variable: ${name}`)
  }
  return value
}

const canonicalPrivateKey = (value: string, name: string): string => {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${name} must be an exact 32-byte hexadecimal private key`)
  }
  try {
    return PrivateKey.fromHex(value).toHex()
  } catch {
    throw new TypeError(`${name} must be a valid secp256k1 private key`)
  }
}

const parseStaticDenylist = (value: string): string[] => {
  if (new TextEncoder().encode(value).byteLength > MAX_STATIC_DENYLIST_BYTES) {
    throw new TypeError('MANDALA_STATIC_DENYLIST_JSON is too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError('MANDALA_STATIC_DENYLIST_JSON must be valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_STATIC_DENYLIST_ENTRIES) {
    throw new TypeError(
      `MANDALA_STATIC_DENYLIST_JSON must be an array of at most ${MAX_STATIC_DENYLIST_ENTRIES} identities`
    )
  }
  const identities = new Set<string>()
  for (const candidate of parsed) {
    if (typeof candidate !== 'string' || !/^(?:02|03)[0-9a-fA-F]{64}$/.test(candidate)) {
      throw new TypeError(
        'MANDALA_STATIC_DENYLIST_JSON entries must be compressed secp256k1 public keys'
      )
    }
    const canonical = candidate.toLowerCase()
    try {
      if (PublicKey.fromString(canonical).toString() !== canonical) throw new Error('noncanonical')
    } catch {
      throw new TypeError(
        'MANDALA_STATIC_DENYLIST_JSON entries must be valid compressed secp256k1 public keys'
      )
    }
    if (identities.has(canonical)) {
      throw new TypeError('MANDALA_STATIC_DENYLIST_JSON entries must be unique')
    }
    identities.add(canonical)
  }
  return [...identities]
}

export type MandalaRuntimeConfiguration =
  | { enabled: false }
  | {
      enabled: true
      verifierPrivateKey: string
      adminPrivateKey: string
      sanctionedIdentityKeys: string[]
    }

/**
 * The bundled server leaves regulated-token processing disabled unless an
 * operator deliberately supplies independent verifier/admin roots and an
 * explicit static screening snapshot. Production deployments should replace
 * the static provider in application code with their authoritative feed.
 */
export const readMandalaRuntimeConfiguration = (
  environment: Environment,
  serverPrivateKey: string
): MandalaRuntimeConfiguration => {
  if (!readBooleanEnv(environment, 'MANDALA_ENABLED', false)) return { enabled: false }

  const serverKey = canonicalPrivateKey(serverPrivateKey, 'SERVER_PRIVATE_KEY')
  const verifierPrivateKey = canonicalPrivateKey(
    requireValue(environment, 'MANDALA_VERIFIER_PRIVATE_KEY'),
    'MANDALA_VERIFIER_PRIVATE_KEY'
  )
  const adminPrivateKey = canonicalPrivateKey(
    requireValue(environment, 'MANDALA_ADMIN_PRIVATE_KEY'),
    'MANDALA_ADMIN_PRIVATE_KEY'
  )
  if (new Set([serverKey, verifierPrivateKey, adminPrivateKey]).size !== 3) {
    throw new TypeError('Mandala server, verifier, and admin private keys must be independent')
  }

  return {
    enabled: true,
    verifierPrivateKey,
    adminPrivateKey,
    sanctionedIdentityKeys: parseStaticDenylist(
      requireValue(environment, 'MANDALA_STATIC_DENYLIST_JSON')
    )
  }
}
