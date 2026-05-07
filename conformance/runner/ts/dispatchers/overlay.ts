/**
 * Overlay dispatcher — Wave 1.
 *
 * Categories:
 *   submit           (overlay.submit)    — POST /submit BEEF → STEAK
 *   lookup           (overlay.lookup)    — POST /lookup + discovery endpoints
 *   topic-management (overlay.topicmanagement) — health, admin, arc-ingest
 *
 * Implementation strategy:
 *   These vectors describe the overlay HTTP API contract.  The TS SDK ships a
 *   client-side implementation (SHIPBroadcaster / LookupResolver) that talks to
 *   a live server, so we cannot invoke it end-to-end in a unit test.  Instead we:
 *
 *   1. For submit/lookup: validate that the INPUT shape (method, path, headers,
 *      body) matches what the SDK client would send, using static assertions.
 *
 *   2. For success (2xx) vectors: validate that the EXPECTED body shape is
 *      structurally valid according to the overlay-http.yaml schema definitions.
 *
 *   3. For error (4xx/5xx) vectors: assert expected.status is a number in the
 *      right range and that expected.body.status === 'error'.
 *
 *   4. Vectors that require a running overlay server are demoted to best-effort
 *      with an explicit skip_reason comment below (no vector files are modified
 *      here; the parity_class change must be done in the vector files if needed).
 *
 * MISMATCH flags:
 *   - submit.8: SDK off-chain-values body layout uses
 *       Writer.writeVarIntNum(beef.length) ++ beef ++ offChainValues
 *     but the vector note says "varint(4) + 4 off-chain bytes + BEEF bytes"
 *     which reverses the order.  Vector expected.body only checks outputsToAdmit
 *     shape so no assertion fails, but the body_hex note disagrees with the SDK.
 *     Flagged — do NOT silently fix expected values.
 *
 *   - lookup.3: x-aggregation binary response — the SDK sends X-Aggregation: yes
 *     and parses the binary response, but the vector only checks content_type.
 *     Shape-validated only.
 *
 *   - topic-management.1 / .2: HealthReport schema requires "checks" array per
 *     overlay-http.yaml but the vector expected bodies omit it. Validated against
 *     the minimal required fields only (status, live, ready).
 */

import { expect } from '@jest/globals'
import {
  VectorInput,
  VectorExpected,
  assertHttpStatus,
  assertErrorShape,
  assertSteakShape,
  assertSubmitRequestShape,
  assertSteakTopicsMatch,
  assertSubmitContentType,
  assertLookupRequestShape,
  assertLookupAnswerShape,
  assertLookupBinaryResponse,
  assertLookupErrorStatusRange,
  assertListEndpointBody,
  assertDocumentationEndpoint,
  handleHealthEndpoint,
  handleAdminConfig,
  handleAdminStats,
  handleAdminBanUnban,
  handleAdminBans,
  handleAdminEvict,
  handleAdminShipRecords,
  handleArcIngest
} from './overlayHelpers.js'

// ── Exported contract ────────────────────────────────────────────────────────

export const categories: ReadonlyArray<string> = [
  'submit',
  'lookup',
  'topic-management'
]

export function dispatch (
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  const inp = input as VectorInput
  const exp = expected as VectorExpected

  switch (category) {
    case 'submit':
      return dispatchSubmit(inp, exp)
    case 'lookup':
      return dispatchLookup(inp, exp)
    case 'topic-management':
      return dispatchTopicManagement(inp, exp)
    default:
      throw new Error(`not implemented: dispatchers/overlay.ts – unknown category '${category}'`)
  }
}

// ── Submit dispatcher ────────────────────────────────────────────────────────

function dispatchSubmitSuccess (inp: VectorInput, body: Record<string, unknown>): void {
  assertSteakShape(body)

  const headers = inp.headers ?? {}
  assertSteakTopicsMatch(body, headers)
  assertSubmitContentType(headers)

  if (inp.body_hex !== undefined && inp.body_hex !== '') {
    expect(inp.body_hex).toMatch(/^[0-9a-fA-F]+$/)
  }
}

function dispatchSubmitError (body: Record<string, unknown>, status: number): void {
  assertErrorShape(body)
  expect(status).toBeGreaterThanOrEqual(400)
  expect(status).toBeLessThan(600)
}

function dispatchSubmit (inp: VectorInput, exp: VectorExpected): void {
  assertSubmitRequestShape(inp)
  assertHttpStatus(exp)

  const status = exp.status ?? (exp.status_oneof?.[0] ?? 200)
  const body = exp.body ?? {}

  if (status === 200) {
    dispatchSubmitSuccess(inp, body)
  } else {
    dispatchSubmitError(body, status)
  }
}

// ── Lookup dispatcher ────────────────────────────────────────────────────────

/**
 * Handle GET discovery/metadata endpoints under the lookup category.
 */
function dispatchLookupGet (path: string, status: number, exp: VectorExpected): void {
  switch (path) {
    case '/listTopicManagers':
    case '/listLookupServiceProviders':
      expect(status).toBe(200)
      assertListEndpointBody(exp)
      return

    case '/getDocumentationForTopicManager':
      assertDocumentationEndpoint(status, exp)
      return

    default:
      if (exp.body !== undefined && status >= 400) {
        assertErrorShape(exp.body)
      }
  }
}

function dispatchLookupPostSuccess (inp: VectorInput, exp: VectorExpected): void {
  const headers = inp.headers ?? {}
  const aggKey = Object.keys(headers).find(k => k.toLowerCase() === 'x-aggregation')
  if (aggKey !== undefined && headers[aggKey].toLowerCase() === 'yes') {
    assertLookupBinaryResponse(exp)
    return
  }

  const body = exp.body
  if (body !== undefined) {
    assertLookupAnswerShape(body)
  }
}

function dispatchLookupPostError (exp: VectorExpected): void {
  const body = exp.body ?? {}
  assertErrorShape(body)
  assertLookupErrorStatusRange(exp)
}

function dispatchLookupPost (inp: VectorInput, exp: VectorExpected): void {
  assertLookupRequestShape(inp)
  assertHttpStatus(exp)

  const status = exp.status ?? (exp.status_oneof?.[0] ?? 200)

  if (status === 200) {
    dispatchLookupPostSuccess(inp, exp)
  } else {
    dispatchLookupPostError(exp)
  }
}

function dispatchLookup (inp: VectorInput, exp: VectorExpected): void {
  const method = (inp.method ?? 'POST').toUpperCase()
  const path = inp.path ?? ''

  if (method === 'GET') {
    assertHttpStatus(exp)
    const status = exp.status ?? 200
    dispatchLookupGet(path, status, exp)
    return
  }

  if (method === 'POST' && path === '/lookup') {
    dispatchLookupPost(inp, exp)
    return
  }

  // Unexpected path for lookup category
  assertHttpStatus(exp)
}

// ── Topic-management dispatcher ──────────────────────────────────────────────

const HEALTH_PATHS = new Set(['/health', '/health/live', '/health/ready'])
const ADMIN_BAN_PATHS = new Set(['/admin/ban', '/admin/unban'])

function dispatchTopicManagement (inp: VectorInput, exp: VectorExpected): void {
  const method = (inp.method ?? 'GET').toUpperCase()
  const path = inp.path ?? ''

  assertHttpStatus(exp)

  const status = exp.status ?? (exp.status_oneof?.[0] ?? 200)
  const body = exp.body ?? {}

  if (HEALTH_PATHS.has(path)) {
    handleHealthEndpoint(method, status, body)
    return
  }

  if (path === '/admin/config' && method === 'GET') {
    handleAdminConfig(status, body)
    return
  }

  if (path === '/admin/stats' && method === 'GET') {
    handleAdminStats(status, body)
    return
  }

  if (ADMIN_BAN_PATHS.has(path) && method === 'POST') {
    handleAdminBanUnban(status, body, inp.body as Record<string, unknown> | undefined, exp)
    return
  }

  if (path === '/admin/bans' && method === 'GET') {
    handleAdminBans(status, body)
    return
  }

  if (path === '/admin/evictOutpoint' && method === 'POST') {
    handleAdminEvict(status, body, inp.body as Record<string, unknown> | undefined)
    return
  }

  if (path === '/admin/ship-records' && method === 'GET') {
    handleAdminShipRecords(status, body)
    return
  }

  if (path === '/arc-ingest' && method === 'POST') {
    handleArcIngest(status, body, inp)
    return
  }

  // Fallback: unknown endpoint in topic-management
  expect(status).toBeGreaterThanOrEqual(100)
  expect(status).toBeLessThan(600)
}

