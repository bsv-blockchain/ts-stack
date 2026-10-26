import { defaultHttpClient } from '../http/DefaultHttpClient.js'
import type { HttpClient } from '../http/HttpClient.js'
import { hasControlCharacter, utf8ByteLength } from '../../primitives/UTF8.js'

/** Configuration options for the ARC broadcaster. */
export interface ArcConfig {
  /** Authentication token for the ARC API. */
  apiKey?: string
  /** The explicitly trusted HTTP adapter used to make provider requests. */
  httpClient?: HttpClient
  /** Deployment ID sent in the XDeployment-ID header. */
  deploymentId?: string
  /** Notification callback endpoint for proofs and double-spend notifications. */
  callbackUrl?: string
  /** Access token sent to the configured notification callback. */
  callbackToken?: string
  /** Additional request headers, snapshotted when the broadcaster is constructed. */
  headers?: Record<string, string>
}

export interface NormalizedArcConfig {
  apiKey?: string
  httpClient: HttpClient
  deploymentId: string
  callbackUrl?: string
  callbackToken?: string
  headers?: Readonly<Record<string, string>>
}

const MAX_CONFIGURATION_PROPERTIES = 32
const MAX_CUSTOM_HEADERS = 64

function plainOwnDataProperties(
  value: unknown,
  label: string,
  maximumProperties: number
): Record<string, PropertyDescriptor> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an accessor-free plain data object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  const properties = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(properties).length > maximumProperties ||
    Object.values(properties).some(property => property.get != null || property.set != null)
  ) {
    throw new TypeError(`${label} must be an accessor-free plain data object.`)
  }
  return properties
}

function optionalHeaderText(
  value: unknown,
  label: string,
  maximumBytes: number
): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    utf8ByteLength(value) > maximumBytes ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${label} must be bounded text without control characters.`)
  }
  return value
}

function snapshotHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const properties = plainOwnDataProperties(value, 'ARC headers', MAX_CUSTOM_HEADERS)
  const headers = Object.create(null) as Record<string, string>
  for (const [name, property] of Object.entries(properties)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) {
      throw new TypeError(`ARC header name is invalid: ${name}`)
    }
    const headerValue = optionalHeaderText(property.value, `ARC header ${name}`, 8192)
    if (headerValue === undefined) {
      throw new TypeError(`ARC header ${name} must be a string.`)
    }
    headers[name] = headerValue
  }
  return Object.freeze(headers)
}

function validateHttpClient(value: unknown): HttpClient {
  const client = value ?? defaultHttpClient()
  if (
    client == null ||
    typeof client !== 'object' ||
    typeof (client as HttpClient).request !== 'function'
  ) {
    throw new TypeError('ARC httpClient must provide request().')
  }
  return client as HttpClient
}

/** Snapshot security-relevant ARC constructor configuration exactly once. */
export function normalizeArcConfig(
  config: string | ArcConfig | undefined,
  defaultDeploymentId: () => string
): NormalizedArcConfig {
  if (typeof config === 'string') {
    return Object.freeze({
      apiKey: optionalHeaderText(config, 'ARC API key', 16 * 1024),
      httpClient: defaultHttpClient(),
      deploymentId: defaultDeploymentId()
    })
  }

  const properties = plainOwnDataProperties(
    config ?? {},
    'ARC config',
    MAX_CONFIGURATION_PROPERTIES
  )
  const read = (name: string): unknown => properties[name]?.value
  return Object.freeze({
    apiKey: optionalHeaderText(read('apiKey'), 'ARC API key', 16 * 1024),
    httpClient: validateHttpClient(read('httpClient')),
    deploymentId:
      optionalHeaderText(read('deploymentId'), 'ARC deployment ID', 256) ?? defaultDeploymentId(),
    callbackUrl: optionalHeaderText(read('callbackUrl'), 'ARC callback URL', 2048),
    callbackToken: optionalHeaderText(read('callbackToken'), 'ARC callback token', 16 * 1024),
    headers: snapshotHeaders(read('headers'))
  })
}

/** Require a stable, bounded primitive URL without changing caller-selected endpoint authority. */
export function normalizeArcUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8ByteLength(value) > 2048 ||
    hasControlCharacter(value)
  ) {
    throw new TypeError('ARC URL must be nonempty bounded text without control characters.')
  }
  return value
}
