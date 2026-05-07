/**
 * Broadcast dispatcher — Wave 1.
 *
 * Categories:
 *   arc-submit             (broadcast.arcsubmit)
 *   merkle-path-validation (broadcast.merklepath)
 *   merkle-service         (broadcast.merkle-service)
 *
 * Implementation notes:
 *   - No live network calls. ARC response handling is exercised by driving the
 *     SDK ARC client through a synthetic in-process HttpClient, exactly as the
 *     ARC unit tests do (see packages/sdk/src/transaction/broadcasters/__tests/).
 *   - MerklePath parsing uses @bsv/sdk MerklePath.fromHex() where a BUMP hex is
 *     present; other broadcast.merklepath vectors validate ARC callback payload
 *     shape rules that the SDK enforces on the ingest side.
 *   - merkle-service vectors are pure structural / schema checks against
 *     specs/merkle/merkle-service-http.yaml — no live service required.
 */

import { expect } from '@jest/globals'
import { ARC, FetchHttpClient } from '@bsv/sdk'
import {
  getString,
  getNumber,
  normalizeHeaderKey,
  syntheticFetch,
  buildSyntheticTx,
  isArcFailureStatus,
  assertArcSuccess200,
  assertArcNon200,
  validateArcCallbackPayload,
  assertMerklePathParseable,
  simulateWatchRequest,
  assertWatchResponse,
  assertSchemaCheckVector
} from './broadcastHelpers.js'

export const categories: ReadonlyArray<string> = [
  'arc-submit',
  'merkle-path-validation',
  'merkle-service'
]

// ── ARC Submit Dispatcher ──────────────────────────────────────────────────────

function assertArcRequestShape (
  method: string,
  path: string,
  headers: Record<string, unknown>,
  input: Record<string, unknown>
): void {
  expect(['GET', 'POST']).toContain(method)
  expect(path.startsWith('/v1/') || path.startsWith('/arc-ingest')).toBe(true)

  if (method === 'POST' && input.body !== undefined) {
    const ct = Object.entries(headers).find(
      ([k]) => normalizeHeaderKey(k) === 'content-type'
    )
    if (ct !== undefined) {
      expect((ct[1] as string).toLowerCase()).toContain('application/json')
    }
  }
}

async function dispatchArcPostTx (
  expectedStatus: number,
  expBody: Record<string, unknown>,
  input: Record<string, unknown>
): Promise<void> {
  const txStatus = getString(expBody, 'txStatus')
  const extraInfo = getString(expBody, 'extraInfo')
  const txid = getString(expBody, 'txid')
  const inputBody = input.body as Record<string, unknown> | undefined
  const rawTx = (inputBody === undefined ? '' : getString(inputBody, 'rawTx')) || 'aabbcc'

  if (expectedStatus === 200) {
    await assertArcSuccess200(expBody, txStatus, extraInfo, txid, rawTx)
  } else {
    await assertArcNon200(expectedStatus, expBody, rawTx)
  }
}

async function dispatchArcGetTx (
  path: string,
  expectedStatus: number,
  expectedBody: unknown
): Promise<void> {
  const txidFromPath = path.replace('/v1/tx/', '')
  expect(txidFromPath.length).toBe(64)
  expect(/^[0-9a-fA-F]{64}$/.test(txidFromPath)).toBe(true)

  if (expectedStatus === 200 && typeof expectedBody === 'object' && expectedBody !== null) {
    const expBody = expectedBody as Record<string, unknown>
    expect(typeof getString(expBody, 'txid')).toBe('string')
    expect(typeof getString(expBody, 'txStatus')).toBe('string')
  }

  if (expectedStatus === 404 && typeof expectedBody === 'object' && expectedBody !== null) {
    const expBody = expectedBody as Record<string, unknown>
    expect(getNumber(expBody, 'status')).toBe(404)
  }
}

function dispatchArcBatchTx (expectedBody: unknown, inputBody: unknown): void {
  if (Array.isArray(expectedBody) && Array.isArray(inputBody)) {
    expect(expectedBody.length).toBe((inputBody as unknown[]).length)
    for (const item of expectedBody) {
      const itemObj = item as Record<string, unknown>
      expect(typeof getString(itemObj, 'txid')).toBe('string')
      expect(getString(itemObj, 'txid').length).toBe(64)
      expect(typeof getString(itemObj, 'txStatus')).toBe('string')
      expect(getString(itemObj, 'txStatus').length).toBeGreaterThan(0)
    }
  }
}

async function dispatchArcSubmit (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): Promise<void> {
  const method = getString(input, 'method')
  const path = getString(input, 'path')
  const headers = (input.headers ?? {}) as Record<string, unknown>

  assertArcRequestShape(method, path, headers, input)

  const expectedStatus = getNumber(expected, 'status')
  const expectedBody = expected.body

  if (expectedStatus === undefined) {
    const statusOneof = expected.status_oneof
    if (Array.isArray(statusOneof)) {
      expect(statusOneof.every((s: unknown) => typeof s === 'number')).toBe(true)
    }
    return
  }

  if (method === 'POST' && path === '/v1/tx' && typeof expectedBody === 'object' && expectedBody !== null) {
    await dispatchArcPostTx(expectedStatus, expectedBody as Record<string, unknown>, input)
    return
  }

  if (method === 'POST' && path === '/v1/txs') {
    dispatchArcBatchTx(expectedBody, input.body)
    return
  }

  if (method === 'GET' && path.startsWith('/v1/tx/')) {
    await dispatchArcGetTx(path, expectedStatus, expectedBody)
    return
  }

  if (path.startsWith('/arc-ingest') || path.includes('arc-ingest')) {
    if (method === 'POST' && typeof expectedBody === 'object' && expectedBody !== null) {
      expect(expectedStatus).toBe(200)
      const expBody = expectedBody as Record<string, unknown>
      expect(getString(expBody, 'status')).toBe('success')
    }
  }
}

// ── Merkle-Path Validation Dispatcher ─────────────────────────────────────────

async function dispatchMerklePathValidation (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): Promise<void> {
  const method = getString(input, 'method')
  const expectedStatus = getNumber(expected, 'status')
  const body = (input.body ?? {}) as Record<string, unknown>

  if (method !== 'POST' && method !== '') return

  const { valid } = validateArcCallbackPayload(body)

  if (expectedStatus === 200) {
    expect(valid).toBe(true)

    const merklePath = getString(body, 'merklePath')
    const blockHeight = getNumber(body, 'blockHeight')
    const expBody = (expected.body ?? {}) as Record<string, unknown>

    if (merklePath !== '' && blockHeight !== undefined) {
      await assertMerklePathParseable(merklePath, blockHeight, expBody)
    } else {
      expect(getString(expBody, 'status')).toBe('success')
    }
  } else if (expectedStatus === 400) {
    expect(valid).toBe(false)
    const expBody = (expected.body ?? {}) as Record<string, unknown>
    expect(getString(expBody, 'status')).toBe('error')
  }
}

async function dispatchMerklePathValidationFull (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): Promise<void> {
  const method = getString(input, 'method')
  const path = getString(input, 'path')

  // Vectors 10 & 11: ARC txStatus failure — drive SDK response parser
  if (method === 'POST' && path === '/v1/tx') {
    await dispatchMerklePathSdkFailure(input, expected)
    return
  }

  // All other vectors: ARC callback payload shape validation
  await dispatchMerklePathValidation(input, expected)
}

async function dispatchMerklePathSdkFailure (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): Promise<void> {
  const body = (input.body ?? {}) as Record<string, unknown>
  const expectedStatus = getNumber(expected, 'status')
  const expBody = (expected.body ?? {}) as Record<string, unknown>

  const txStatus = getString(expBody, 'txStatus')
  const extraInfo = getString(expBody, 'extraInfo')
  const txid = getString(expBody, 'txid')
  const rawTx = (typeof (body as any).rawTx === 'string' ? (body as any).rawTx : '') || 'aabbcc'

  const sdkTreatment = getString(expected, 'sdk_treatment')
  const isSdkFailure = sdkTreatment.includes('BroadcastFailure')

  if (expectedStatus !== 200 || !isSdkFailure) return

  const mockFetch = syntheticFetch(200, expBody)
  const arc = new ARC('https://arc.example.com', {
    httpClient: new FetchHttpClient(mockFetch as unknown as typeof fetch)
  })
  const tx = buildSyntheticTx(rawTx)
  const result = await arc.broadcast(tx as any)

  expect(result.status).toBe('error')
  if (result.status === 'error') {
    expect(result.code).toBe(txStatus)
    if (txid !== '') expect(result.txid).toBe(txid)
    if (extraInfo !== '') {
      expect(result.description.length).toBeGreaterThan(0)
    }
  }
}

// ── Merkle-Service Dispatcher ──────────────────────────────────────────────────

async function dispatchMerkleService (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): Promise<void> {
  const method = getString(input, 'method')
  const path = getString(input, 'path')
  const body = (input.body ?? {}) as Record<string, unknown>
  const expectedStatus = getNumber(expected, 'status')
  const expBody = (expected.body ?? {}) as Record<string, unknown>

  if (input._schema_check === true) {
    assertSchemaCheckVector(input, expected)
    return
  }

  if (method === 'POST' && path === '/watch') {
    const sim = simulateWatchRequest(input, body)
    assertWatchResponse(sim, expectedStatus, expBody)
    return
  }

  if (method === 'GET' && path === '/health') {
    dispatchMerkleServiceHealth(expectedStatus, expBody)
  }
}

function dispatchMerkleServiceHealth (
  expectedStatus: number | undefined,
  expBody: Record<string, unknown>
): void {
  if (expectedStatus === 200) {
    expect(getString(expBody, 'status')).toBe('healthy')
    const details = expBody.details as Record<string, unknown> | undefined
    if (details !== undefined) {
      expect(typeof details.aerospike).toBe('string')
    }
  } else if (expectedStatus === 503) {
    expect(getString(expBody, 'status')).toBe('unhealthy')
    const details = expBody.details as Record<string, unknown> | undefined
    if (details !== undefined) {
      expect(typeof details.aerospike).toBe('string')
    }
  }
}

// ── Main dispatch entry point ──────────────────────────────────────────────────

export function dispatch (
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  switch (category) {
    case 'arc-submit':
      return dispatchArcSubmit(input, expected)
    case 'merkle-path-validation':
      return dispatchMerklePathValidationFull(input, expected)
    case 'merkle-service':
      return dispatchMerkleService(input, expected)
    default:
      throw new Error(`not implemented: dispatchers/broadcast.ts – ${category} (Wave 1)`)
  }
}
