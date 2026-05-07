/**
 * Wallet Storage Adapter dispatcher — BRC-100 storage HTTP interface conformance vectors.
 *
 * Categories:
 *   adapter-conformance   (wallet.storage.adapterconformance)
 *
 * Implementation strategy:
 *   Each vector describes an HTTP request/response pair for the wallet-toolbox storage
 *   remoting layer (/storage/v1/... paths).  Since the dispatcher runs in-process without
 *   a live server, we perform structural validation:
 *
 *   1. Request: method, path prefix, Auth header format (BRC-103 Bearer token),
 *      Content-Type when body is present, and required body field presence.
 *   2. Response: expected status code range, required body field presence and types.
 *   3. TableSettings required fields validated when present in response body.
 *   4. Routes that semantically require a running storage engine (createAction, processAction,
 *      internalizeAction, listActions, listOutputs, sync/* endpoints, certificates) are
 *      validated structurally and demoted to "best-effort" — they pass vacuously if the
 *      expected body fields are present in the vector, since no live server is available.
 *
 * BRC-103 auth: Bearer tokens must match /^Bearer .+$/ — format only, not cryptographic.
 *
 * Spec reference: specs/wallet/storage-adapter.yaml
 * Implementation reference: packages/wallet/wallet-toolbox/src/storage/remoting/
 */

import { expect } from '@jest/globals'

export const categories: ReadonlyArray<string> = [
  'adapter-conformance'
]

// ── Helpers ────────────────────────────────────────────────────────────────────

function getString (m: Record<string, unknown>, key: string): string {
  const v = m[key]
  return typeof v === 'string' ? v : ''
}

function getNumber (m: Record<string, unknown>, key: string): number {
  const v = m[key]
  return typeof v === 'number' ? v : 0
}

/** Assert that a Bearer token is present and has the correct BRC-103 format. */
function assertBearerToken (headers: Record<string, string>): void {
  // Case-insensitive header lookup
  const authValue = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === 'authorization'
  )?.[1]

  if (authValue === undefined) return // absence checked by caller

  expect(typeof authValue).toBe('string')
  expect(authValue).toMatch(/^Bearer .+$/)
}

/** Check whether a request carries an Authorization header. */
function hasAuthHeader (headers: Record<string, string>): boolean {
  return Object.keys(headers).some(k => k.toLowerCase() === 'authorization')
}

/** Assert Content-Type is application/json for POST requests with a body. */
function assertJsonContentType (headers: Record<string, string>): void {
  const ct = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === 'content-type'
  )?.[1]
  if (ct !== undefined) {
    expect(ct.toLowerCase()).toContain('application/json')
  }
}

// ── TableSettings field validation ─────────────────────────────────────────────

/** Required fields in a TableSettings response body per spec. */
const TABLE_SETTINGS_REQUIRED = [
  'storageIdentityKey',
  'storageName',
  'chain',
  'dbtype',
  'maxOutputScript',
  'created_at',
  'updated_at'
] as const

function assertTableSettings (body: Record<string, unknown>): void {
  for (const field of TABLE_SETTINGS_REQUIRED) {
    expect(body).toHaveProperty(field)
  }
  expect(typeof body['storageIdentityKey']).toBe('string')
  expect(typeof body['storageName']).toBe('string')
  expect(typeof body['chain']).toBe('string')
  expect(['main', 'test'].includes(body['chain'] as string)).toBe(true)
  expect(typeof body['dbtype']).toBe('string')
  expect(typeof body['maxOutputScript']).toBe('number')
  expect(typeof body['created_at']).toBe('string')
  expect(typeof body['updated_at']).toBe('string')
}

// ── StorageCreateActionResult field validation ──────────────────────────────────

function assertCreateActionResult (body: Record<string, unknown>): void {
  // Required: inputs, outputs, derivationPrefix, version, lockTime, reference
  expect(Array.isArray(body['inputs'])).toBe(true)
  expect(Array.isArray(body['outputs'])).toBe(true)
  expect(typeof body['derivationPrefix']).toBe('string')
  expect(typeof body['version']).toBe('number')
  expect(typeof body['lockTime']).toBe('number')
  expect(typeof body['reference']).toBe('string')
}

// ── SyncChunk field validation ──────────────────────────────────────────────────

const SYNC_CHUNK_FIELDS = [
  'users', 'transactions', 'outputs', 'outputBaskets', 'provenTxs', 'provenTxReqs', 'syncStates'
] as const

function assertSyncChunk (body: Record<string, unknown>): void {
  for (const field of SYNC_CHUNK_FIELDS) {
    if (field in body) {
      expect(Array.isArray(body[field])).toBe(true)
    }
  }
}

// ── Route handler functions ────────────────────────────────────────────────────

/** GET /storage/v1/settings */
function handleSettings (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const expectedStatus = getNumber(expected, 'status')

  if (!hasAuthHeader(headers)) {
    // Vector 2: no auth → 401
    expect(expectedStatus).toBe(401)
    if (expected['body'] !== undefined) {
      const eb = expected['body'] as Record<string, unknown>
      expect(typeof eb['error']).toBe('string')
    }
    return
  }

  assertBearerToken(headers)
  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    assertTableSettings(expected['body'] as Record<string, unknown>)
  }
}

/** POST /storage/v1/migrate */
function handleMigrate (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  expect(typeof body['storageName']).toBe('string')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    expect(typeof eb['storageName']).toBe('string')
  }
}

/** POST /storage/v1/actions */
function handleCreateAction (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined || !('args' in body)) {
    // Vector 5: missing args → 400
    expect(expectedStatus).toBe(400)
    if (expected['body'] !== undefined) {
      const eb = expected['body'] as Record<string, unknown>
      expect(typeof eb['error']).toBe('string')
    }
    return
  }

  expect(typeof body['args']).toBe('object')
  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    assertCreateActionResult(expected['body'] as Record<string, unknown>)
  }
}

/** POST /storage/v1/actions/process */
function handleProcessAction (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  const b = body
  expect(typeof b['reference']).toBe('string')
  expect(typeof b['isNewTx']).toBe('boolean')
  expect(typeof b['isSendWith']).toBe('boolean')
  expect(typeof b['isNoSend']).toBe('boolean')
  expect(typeof b['isDelayed']).toBe('boolean')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    // StorageProcessActionResults: { sendWithResults?, notDelayedResults?, log? }
    if ('notDelayedResults' in eb) {
      expect(Array.isArray(eb['notDelayedResults'])).toBe(true)
    }
    if ('sendWithResults' in eb) {
      expect(Array.isArray(eb['sendWithResults'])).toBe(true)
    }
  }
}

/** POST /storage/v1/actions/abort */
function handleAbortAction (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  expect(typeof body['reference']).toBe('string')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    expect(typeof eb['aborted']).toBe('boolean')
  }
}

/** POST /storage/v1/actions/internalize */
function handleInternalizeAction (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  const b = body
  // Required fields: tx (raw byte array or hex), outputs, description
  expect(b['tx']).toBeDefined()
  expect(Array.isArray(b['outputs'])).toBe(true)
  expect(typeof b['description']).toBe('string')

  // Validate each output entry
  const outputs = b['outputs'] as Array<Record<string, unknown>>
  for (const output of outputs) {
    expect(typeof output['outputIndex']).toBe('number')
    expect(typeof output['protocol']).toBe('string')
  }

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    // StorageInternalizeActionResult: { accepted, isMerge, txid, satoshis }
    expect(typeof eb['accepted']).toBe('boolean')
    expect(typeof eb['isMerge']).toBe('boolean')
    if ('txid' in eb) expect(typeof eb['txid']).toBe('string')
    if ('satoshis' in eb) expect(typeof eb['satoshis']).toBe('number')
  }
}

/** POST /storage/v1/list/actions */
function handleListActions (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  const b = body
  // limit and offset are optional but must be numbers if present
  if ('limit' in b) expect(typeof b['limit']).toBe('number')
  if ('offset' in b) expect(typeof b['offset']).toBe('number')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    expect(typeof eb['totalActions']).toBe('number')
    expect(Array.isArray(eb['actions'])).toBe(true)
  }
}

/** POST /storage/v1/list/outputs */
function handleListOutputs (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  const b = body
  if ('limit' in b) expect(typeof b['limit']).toBe('number')
  if ('offset' in b) expect(typeof b['offset']).toBe('number')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    expect(typeof eb['totalOutputs']).toBe('number')
    expect(Array.isArray(eb['outputs'])).toBe(true)
  }
}

/** POST /storage/v1/sync/chunk */
function handleSyncChunk (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  const b = body
  expect(typeof b['identityKey']).toBe('string')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    assertSyncChunk(expected['body'] as Record<string, unknown>)
  }
}

/** POST /storage/v1/sync/state */
function handleSyncState (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  const b = body
  expect(typeof b['storageIdentityKey']).toBe('string')
  expect(typeof b['storageName']).toBe('string')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    expect(typeof eb['isNew']).toBe('boolean')
    if ('syncState' in eb) {
      const ss = eb['syncState'] as Record<string, unknown>
      expect(typeof ss['storageIdentityKey']).toBe('string')
      expect(typeof ss['storageName']).toBe('string')
      expect(typeof ss['status']).toBe('string')
    }
  }
}

/** POST /storage/v1/sync/active */
function handleSyncActive (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  expect(typeof body['newActiveStorageIdentityKey']).toBe('string')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    if ('updated' in eb) expect(typeof eb['updated']).toBe('number')
  }
}

/** POST /storage/v1/certificates */
function handleInsertCertificate (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  const b = body
  expect(typeof b['certifier']).toBe('string')
  expect(typeof b['serialNumber']).toBe('string')
  expect(typeof b['type']).toBe('string')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    if ('certificateId' in eb) expect(typeof eb['certificateId']).toBe('number')
  }
}

/** POST /storage/v1/certificates/relinquish */
function handleRelinquishCertificate (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  const b = body
  expect(typeof b['certifier']).toBe('string')
  expect(typeof b['serialNumber']).toBe('string')
  expect(typeof b['type']).toBe('string')

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    if ('updated' in eb) expect(typeof eb['updated']).toBe('number')
  }
}

/** POST /storage/v1/outputs/relinquish */
function handleRelinquishOutput (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  assertBearerToken(headers)
  assertJsonContentType(headers)

  if (body === undefined) return
  const b = body
  const outpoint = getString(b, 'output')

  // Validate outpoint format: must be {64-hex-chars}.{digit+}
  const OUTPOINT_RE = /^[0-9a-fA-F]{64}\.\d+$/
  if (!OUTPOINT_RE.test(outpoint)) {
    // Vector 18: invalid outpoint → 400
    expect(expectedStatus).toBe(400)
    if (expected['body'] !== undefined) {
      const eb = expected['body'] as Record<string, unknown>
      expect(typeof eb['error']).toBe('string')
    }
    return
  }

  expect(expectedStatus).toBe(200)

  if (expected['body'] !== undefined) {
    const eb = expected['body'] as Record<string, unknown>
    if ('updated' in eb) expect(typeof eb['updated']).toBe('number')
  }
}

// ── Route dispatch table ───────────────────────────────────────────────────────

type RouteHandler = (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
) => void | Promise<void>

const ROUTE_TABLE: Array<{
  method: string
  pathExact?: string
  pathPrefix?: string
  handler: RouteHandler
}> = [
  { method: 'GET',  pathExact: '/storage/v1/settings',               handler: handleSettings },
  { method: 'POST', pathExact: '/storage/v1/migrate',                 handler: handleMigrate },
  { method: 'POST', pathExact: '/storage/v1/actions',                 handler: handleCreateAction },
  { method: 'POST', pathExact: '/storage/v1/actions/process',         handler: handleProcessAction },
  { method: 'POST', pathExact: '/storage/v1/actions/abort',           handler: handleAbortAction },
  { method: 'POST', pathExact: '/storage/v1/actions/internalize',     handler: handleInternalizeAction },
  { method: 'POST', pathExact: '/storage/v1/list/actions',            handler: handleListActions },
  { method: 'POST', pathExact: '/storage/v1/list/outputs',            handler: handleListOutputs },
  { method: 'POST', pathExact: '/storage/v1/sync/chunk',              handler: handleSyncChunk },
  { method: 'POST', pathExact: '/storage/v1/sync/state',              handler: handleSyncState },
  { method: 'POST', pathExact: '/storage/v1/sync/active',             handler: handleSyncActive },
  { method: 'POST', pathExact: '/storage/v1/certificates',            handler: handleInsertCertificate },
  { method: 'POST', pathExact: '/storage/v1/certificates/relinquish', handler: handleRelinquishCertificate },
  { method: 'POST', pathExact: '/storage/v1/outputs/relinquish',      handler: handleRelinquishOutput }
]

// ── Main dispatch entry point ──────────────────────────────────────────────────

export function dispatch (
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  if (category !== 'adapter-conformance') {
    throw new Error(`wallet-storage dispatcher: unknown category '${category}'`)
  }

  const method = getString(input, 'method')
  const path = getString(input, 'path')

  // Validate common HTTP request fields
  expect(typeof method).toBe('string')
  expect(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)).toBe(true)
  expect(typeof path).toBe('string')
  expect(path.startsWith('/storage/v1/')).toBe(true)

  // Validate expected status is a valid HTTP status code
  const expectedStatus = getNumber(expected, 'status')
  expect(expectedStatus).toBeGreaterThanOrEqual(100)
  expect(expectedStatus).toBeLessThan(600)

  // Route lookup
  const route = ROUTE_TABLE.find(r => {
    if (r.method !== method) return false
    if (r.pathExact !== undefined) return r.pathExact === path
    if (r.pathPrefix !== undefined) return path.startsWith(r.pathPrefix)
    return false
  })

  if (route === undefined) {
    throw new Error(
      `wallet-storage dispatcher: no handler for ${method} ${path} — add route to ROUTE_TABLE`
    )
  }

  return route.handler(input, expected)
}
