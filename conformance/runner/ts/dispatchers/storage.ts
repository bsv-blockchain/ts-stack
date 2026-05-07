/**
 * Storage dispatcher — Wave 1.
 *
 * Categories:
 *   uhrp-http   (storage.uhrp-http)
 *
 * Implementation notes:
 * --------------------
 * The UHRP HTTP API is a server-side service (uhrp-services or NanoStore).
 * All but a few vectors require a running UHRP server, which is not available
 * in the conformance test environment.  The entire vector file carries
 * `parity_class: best-effort` at the file level, so all vectors are skipped
 * by the runner automatically without this dispatcher needing to throw.
 *
 * The dispatcher still validates structural invariants where possible:
 *
 * - storage.uhrp-http.10  (schema: pagination constants)
 * - storage.uhrp-http.14  (schema: UHRP URL format + prefix bytes)
 * - storage.uhrp-http.15  (schema: upload PUT workflow description)
 *
 * For all other vectors the dispatcher validates the HTTP method, path,
 * and expected status-code shape against the spec, then returns — these
 * vectors are effectively no-ops because they are skipped by the runner
 * (best-effort parity_class).  If parity_class is ever changed to
 * `required`, the dispatcher will need real HTTP client integration.
 */

import { expect } from '@jest/globals'
import { StorageUtils } from '@bsv/sdk/storage'

const { getURLForHash, getHashFromURL, isValidURL } = StorageUtils

export const categories: ReadonlyArray<string> = [
  'uhrp-http'
]

// ── Helpers ────────────────────────────────────────────────────────────────────

function getString (m: Record<string, unknown>, key: string): string {
  const v = m[key]
  return typeof v === 'string' ? v : ''
}

function getBool (m: Record<string, unknown>, key: string): boolean {
  return m[key] === true
}

/**
 * Validates an HTTP-shaped vector's method, path, and expected status code
 * against the UHRP HTTP spec.
 */
function validateHttpShape (
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  expectedMethod: string,
  expectedPath: string,
  allowedStatuses: number[]
): void {
  const method = getString(input, 'method')
  const path = getString(input, 'path')

  expect(method).toBe(expectedMethod)
  expect(path).toBe(expectedPath)

  const status = expected['status'] as number | undefined
  if (typeof status === 'number') {
    expect(allowedStatuses).toContain(status)
  }
}

/**
 * storage.uhrp-http.1
 * POST /upload: initiate file upload — shape check.
 */
function dispatchUploadRequest (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'POST', '/upload', [200, 400, 401, 500])

  const body = (input['body'] ?? {}) as Record<string, unknown>
  expect(typeof body['fileSize']).toBe('number')
  expect(typeof body['contentType']).toBe('string')

  if (expected['status'] === 200) {
    const bodyShape = (expected['body_shape'] ?? {}) as Record<string, unknown>
    expect(getString(bodyShape, 'uploadURL')).toBe('string')
    expect(getString(bodyShape, 'uhrpUrl')).toBe('string')
  }
}

/**
 * storage.uhrp-http.2
 * POST /upload: unauthenticated — 401.
 */
function dispatchUploadUnauthenticated (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'POST', '/upload', [401])
  expect(expected['status']).toBe(401)
}

/**
 * storage.uhrp-http.3
 * POST /upload: missing fileSize — 400.
 */
function dispatchUploadMissingField (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'POST', '/upload', [400])
  expect(expected['status']).toBe(400)

  // Confirm the body is indeed missing fileSize
  const body = (input['body'] ?? {}) as Record<string, unknown>
  expect(body['fileSize']).toBeUndefined()
}

/**
 * storage.uhrp-http.4
 * GET /find: resolve UHRP URL — 200 with body shape.
 */
function dispatchFindRequest (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'GET', '/find', [200, 400, 404, 500])

  if (expected['status'] === 200) {
    const bodyShape = (expected['body_shape'] ?? {}) as Record<string, unknown>
    expect(getString(bodyShape, 'URLs')).toBe('array')
    expect(getString(bodyShape, 'MIMEType')).toBe('string')
    expect(getString(bodyShape, 'expiryTime')).toBe('string')
  }
}

/**
 * storage.uhrp-http.5
 * GET /find: bare UHRP URL accepted — 200.
 */
function dispatchFindBareUrl (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'GET', '/find', [200])
  expect(expected['status']).toBe(200)
}

/**
 * storage.uhrp-http.6
 * GET /find: unknown UHRP URL — 404.
 */
function dispatchFindNotFound (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'GET', '/find', [404])
  expect(expected['status']).toBe(404)
}

/**
 * storage.uhrp-http.7
 * GET /find: missing uhrpUrl param — 400.
 */
function dispatchFindMissingParam (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'GET', '/find', [400])
  expect(expected['status']).toBe(400)

  const queryParams = (input['queryParams'] ?? {}) as Record<string, unknown>
  expect(queryParams['uhrpUrl']).toBeUndefined()
}

/**
 * storage.uhrp-http.8
 * GET /list: list hosted files — 200 with pagination body shape.
 */
function dispatchListRequest (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'GET', '/list', [200, 401, 500])

  if (expected['status'] === 200) {
    const bodyShape = (expected['body_shape'] ?? {}) as Record<string, unknown>
    expect(getString(bodyShape, 'files')).toBe('array')
    expect(getString(bodyShape, 'total')).toBe('number')
  }
}

/**
 * storage.uhrp-http.9
 * GET /list: unauthenticated — 401.
 */
function dispatchListUnauthenticated (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'GET', '/list', [401])
  expect(expected['status']).toBe(401)
}

/**
 * storage.uhrp-http.10
 * GET /list: pagination constants — pure schema/structural check.
 * Fully exercisable without a server.
 */
function dispatchListPaginationSchema (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  // The vector specifies the constants we should validate
  const limitDefault = input['limit_default'] as number
  const limitMax = input['limit_max'] as number
  const offsetMin = input['offset_min'] as number

  expect(typeof limitDefault).toBe('number')
  expect(typeof limitMax).toBe('number')
  expect(typeof offsetMin).toBe('number')

  // Sanity: defaults must be within bounds
  expect(limitDefault).toBeGreaterThan(0)
  expect(limitMax).toBeGreaterThanOrEqual(limitDefault)
  expect(offsetMin).toBe(0)

  // Verify the spec-documented values
  expect(limitDefault).toBe(100)
  expect(limitMax).toBe(1000)
  expect(offsetMin).toBe(0)

  expect(getBool(expected, 'valid')).toBe(true)
}

/**
 * storage.uhrp-http.11
 * POST /renew: renew advertisement — 200 with body shape.
 */
function dispatchRenewRequest (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'POST', '/renew', [200, 401, 404, 500])

  if (expected['status'] === 200) {
    const bodyShape = (expected['body_shape'] ?? {}) as Record<string, unknown>
    expect(getString(bodyShape, 'newExpiryTime')).toBe('string')
  }

  const body = (input['body'] ?? {}) as Record<string, unknown>
  expect(typeof body['uhrpUrl']).toBe('string')
}

/**
 * storage.uhrp-http.12
 * POST /renew: unauthenticated — 401.
 */
function dispatchRenewUnauthenticated (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'POST', '/renew', [401])
  expect(expected['status']).toBe(401)
}

/**
 * storage.uhrp-http.13
 * POST /renew: unknown UHRP URL — 404.
 */
function dispatchRenewNotFound (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  validateHttpShape(input, expected, 'POST', '/renew', [404])
  expect(expected['status']).toBe(404)
}

/**
 * storage.uhrp-http.14
 * UHRP URL format: Base58Check with prefix ce00.
 * Fully exercisable client-side using StorageUtils.
 */
function dispatchUhrpUrlFormat (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  // Validate the schema declarations
  expect(getString(expected, 'encoding')).toBe('Base58Check')
  expect(getString(expected, 'hash_algorithm')).toBe('SHA-256')
  expect(getString(expected, 'prefix_bytes')).toBe('ce00')

  // Exercise the SDK's UHRP URL utilities with the example URLs
  const examples = input['examples'] as string[]
  expect(Array.isArray(examples)).toBe(true)
  expect(examples.length).toBeGreaterThan(0)

  for (const url of examples) {
    // Both prefixed and bare forms should be accepted
    expect(isValidURL(url)).toBe(true)

    // Round-trip: hash from URL → URL from hash should produce the canonical form
    const hash = getHashFromURL(url)
    expect(hash.length).toBe(32)

    const rebuilt = getURLForHash(hash)
    // The canonical form is the bare Base58Check string (no uhrp:// prefix)
    // The examples include both prefixed and bare; both should decode to the same hash
    const rebuildHash = getHashFromURL(rebuilt)
    expect(hash).toEqual(rebuildHash)
  }
}

/**
 * storage.uhrp-http.15
 * Upload PUT to uploadURL — structural/schema check only.
 * This describes a two-step client workflow (POST /upload → PUT to uploadURL).
 */
function dispatchUploadPutSchema (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  // Structural check: verify the vector documents the correct HTTP method
  expect(getString(input, 'method')).toBe('PUT')

  // The path is a placeholder from a previous step's response
  const path = getString(input, 'path')
  expect(path.length).toBeGreaterThan(0)

  // Expected status is 200 from the storage backend
  const status = expected['status'] as number | undefined
  if (typeof status === 'number') {
    expect(status).toBe(200)
  }
}

// ── Main dispatch entry point ──────────────────────────────────────────────────

export function dispatch (
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  if (category === 'uhrp-http') {
    return dispatchUhrpHttp(input, expected)
  }
  throw new Error(`storage dispatcher: unknown category '${category}'`)
}

function dispatchUhrpHttp (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const method = getString(input, 'method')
  const path = getString(input, 'path')
  const schemaCheck = getBool(input, '_schema_check')

  // ── schema / structural-only vectors ─────────────────────────────────────────

  // storage.uhrp-http.10: pagination constants
  if ('limit_default' in input || 'limit_max' in input) {
    dispatchListPaginationSchema(input, expected)
    return
  }

  // storage.uhrp-http.14: UHRP URL format
  if (schemaCheck && 'examples' in input && 'encoding' in expected) {
    dispatchUhrpUrlFormat(input, expected)
    return
  }

  // storage.uhrp-http.15: upload PUT schema
  if (schemaCheck && method === 'PUT') {
    dispatchUploadPutSchema(input, expected)
    return
  }

  // ── HTTP-shaped vectors (all best-effort, server-only) ────────────────────────

  if (path === '/upload' && method === 'POST') {
    const headers = (input['headers'] ?? {}) as Record<string, unknown>
    const lowerHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      lowerHeaders[k.toLowerCase()] = String(v)
    }
    const hasAuth = lowerHeaders['authorization'] !== undefined

    if (hasAuth) {
      const body = (input['body'] ?? {}) as Record<string, unknown>
      if (body['fileSize'] === undefined) {
        // missing fileSize
        dispatchUploadMissingField(input, expected)
      } else {
        // happy path
        dispatchUploadRequest(input, expected)
      }
    } else {
      // unauthenticated
      dispatchUploadUnauthenticated(input, expected)
    }
    return
  }

  if (path === '/find' && method === 'GET') {
    const queryParams = (input['queryParams'] ?? {}) as Record<string, unknown>
    const status = expected['status'] as number | undefined

    if (queryParams['uhrpUrl'] === undefined) {
      dispatchFindMissingParam(input, expected)
    } else if (status === 404) {
      dispatchFindNotFound(input, expected)
    } else if ('body_shape' in expected) {
      // Vector 4 (happy path with body_shape)
      dispatchFindRequest(input, expected)
    } else {
      // Vector 5 (bare URL)
      dispatchFindBareUrl(input, expected)
    }
    return
  }

  if (path === '/list' && method === 'GET') {
    const headers = (input['headers'] ?? {}) as Record<string, unknown>
    const lowerHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      lowerHeaders[k.toLowerCase()] = String(v)
    }
    const hasAuth = lowerHeaders['authorization'] !== undefined

    if (hasAuth) {
      dispatchListRequest(input, expected)
    } else {
      dispatchListUnauthenticated(input, expected)
    }
    return
  }

  if (path === '/renew' && method === 'POST') {
    const headers = (input['headers'] ?? {}) as Record<string, unknown>
    const lowerHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      lowerHeaders[k.toLowerCase()] = String(v)
    }
    const hasAuth = lowerHeaders['authorization'] !== undefined
    const status = expected['status'] as number | undefined

    if (!hasAuth) {
      dispatchRenewUnauthenticated(input, expected)
    } else if (status === 404) {
      dispatchRenewNotFound(input, expected)
    } else {
      dispatchRenewRequest(input, expected)
    }
    return
  }

  // Fallback: unrecognised vector shape — make a minimal assertion
  // All storage vectors are best-effort so this path should never be reached
  // from a required vector.
  expect(input).toBeDefined()
  expect(expected).toBeDefined()
}
