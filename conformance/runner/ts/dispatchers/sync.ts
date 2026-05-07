/**
 * Sync dispatcher — BRC-21 GASP protocol conformance vectors.
 *
 * Categories:
 *   gasp-protocol   (sync.gasprotocol)
 *
 * Implementation strategy:
 *   The GASP TypeScript types and class live in packages/overlays/gasp-core.
 *   That package is NOT a dependency of the conformance runner and cannot be
 *   imported via the Jest module mapper.  Instead we perform pure structural
 *   validation of the GASP message shapes:
 *
 *   - "gasp/*" channel vectors: validate message field presence, types, and
 *     value constraints against the GASP TypeScript interfaces defined in
 *     packages/overlays/gasp-core/src/GASP.ts (inlined below as JSDoc comments).
 *
 *   - Version mismatch (vector 3): assert that `expected.valid === false` and that
 *     the error object has the correct ERR_GASP_VERSION_MISMATCH fields.
 *
 *   - Negative since (vector 4): assert that `expected.valid === false`.
 *
 *   - HTTP overlay vectors (/requestSyncResponse, /requestForeignGASPNode):
 *     validate request shape per the GASP HTTP extension and assert expected
 *     response body structure.
 *
 * Type references (from packages/overlays/gasp-core/src/GASP.ts):
 *   GASPInitialRequest  { version: number, since: number, limit?: number }
 *   GASPOutput          { txid: string, outputIndex: number, score: number }
 *   GASPInitialResponse { UTXOList: GASPOutput[], since: number }
 *   GASPInitialReply    { UTXOList: GASPOutput[] }
 *   GASPNodeRequest     { graphID: string, txid: string, outputIndex: number, metadata: boolean }
 *   GASPNode            { graphID, rawTx, outputIndex, proof?, txMetadata?, outputMetadata?, inputs? }
 *   GASPNodeResponse    { requestedInputs: Record<string, { metadata: boolean }> | null }
 *   GASPVersionMismatchError { code: 'ERR_GASP_VERSION_MISMATCH', currentVersion, foreignVersion }
 */

import { expect } from '@jest/globals'

export const categories: ReadonlyArray<string> = [
  'gasp-protocol'
]

// ── Constants ──────────────────────────────────────────────────────────────────

/** Current GASP protocol version (from GASP.ts: this.version = 1). */
const GASP_CURRENT_VERSION = 1

/** txid pattern: exactly 64 hex characters (upper or lower). */
const TXID_RE = /^[0-9a-fA-F]{64}$/

// ── Helpers ────────────────────────────────────────────────────────────────────

function getString (m: Record<string, unknown>, key: string): string {
  const v = m[key]
  return typeof v === 'string' ? v : ''
}

function getNumber (m: Record<string, unknown>, key: string): number {
  const v = m[key]
  return typeof v === 'number' ? v : 0
}

/** Assert a GASPOutput object has correct field types and constraint values. */
function assertGASPOutput (output: unknown, ctx: string): void {
  expect(output).toBeDefined()
  expect(typeof output).toBe('object')
  const o = output as Record<string, unknown>
  // txid: /^[0-9a-fA-F]{64}$/
  expect(typeof o['txid']).toBe('string')
  expect(TXID_RE.test(o['txid'] as string)).toBe(true)
  // outputIndex: integer >= 0
  expect(typeof o['outputIndex']).toBe('number')
  expect(Number.isInteger(o['outputIndex'])).toBe(true)
  expect(o['outputIndex'] as number).toBeGreaterThanOrEqual(0)
  // score: number >= 0 (0 = unconfirmed)
  expect(typeof o['score']).toBe('number')
  expect(o['score'] as number).toBeGreaterThanOrEqual(0)
}

// ── Channel dispatchers ────────────────────────────────────────────────────────

/**
 * gasp/initialRequest — GASPInitialRequest validation.
 * Shape: { version: number, since: integer >= 0, limit?: integer >= 1 }
 */
function dispatchInitialRequest (
  msg: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const version = msg['version']
  const since = msg['since']
  const sinceIsValid = typeof since === 'number' && Number.isInteger(since) && since >= 0
  const versionIsValid = version === GASP_CURRENT_VERSION

  if (!sinceIsValid || !versionIsValid) {
    expect(expected['valid']).toBe(false)

    if (!versionIsValid && sinceIsValid) {
      // Version mismatch — assert error object shape matches GASPVersionMismatchError
      const errExp = expected['error'] as Record<string, unknown> | undefined
      if (errExp !== undefined) {
        expect(errExp['code']).toBe('ERR_GASP_VERSION_MISMATCH')
        expect(errExp['currentVersion']).toBe(GASP_CURRENT_VERSION)
        expect(errExp['foreignVersion']).toBe(version)
      }
    }
    return
  }

  expect(expected['valid']).toBe(true)
  // version must be the current GASP version
  expect(version).toBe(GASP_CURRENT_VERSION)
  // since must be an integer >= 0
  expect(sinceIsValid).toBe(true)
  // limit, if present, must be an integer >= 1
  if ('limit' in msg && msg['limit'] !== undefined) {
    expect(typeof msg['limit']).toBe('number')
    expect(Number.isInteger(msg['limit'])).toBe(true)
    expect(msg['limit'] as number).toBeGreaterThanOrEqual(1)
  }
}

/**
 * gasp/initialResponse — GASPInitialResponse validation.
 * Shape: { UTXOList: GASPOutput[], since: integer >= 0 }
 */
function dispatchInitialResponse (
  msg: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  expect(expected['valid']).toBe(true)

  expect(Array.isArray(msg['UTXOList'])).toBe(true)
  const utxoList = msg['UTXOList'] as unknown[]
  for (const utxo of utxoList) {
    assertGASPOutput(utxo, 'UTXOList entry')
  }

  expect(typeof msg['since']).toBe('number')
  expect(Number.isInteger(msg['since'])).toBe(true)
  expect(msg['since'] as number).toBeGreaterThanOrEqual(0)
}

/**
 * gasp/initialReply — GASPInitialReply validation.
 * Shape: { UTXOList: GASPOutput[] }
 */
function dispatchInitialReply (
  msg: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  expect(expected['valid']).toBe(true)

  expect(Array.isArray(msg['UTXOList'])).toBe(true)
  const utxoList = msg['UTXOList'] as unknown[]
  for (const utxo of utxoList) {
    assertGASPOutput(utxo, 'UTXOList entry')
  }
}

/**
 * gasp/requestNode — GASPNodeRequest validation.
 * Shape: { graphID: string, txid: /^[0-9a-fA-F]{64}$/, outputIndex: int >= 0, metadata: boolean }
 */
function dispatchRequestNode (
  msg: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  expect(expected['valid']).toBe(true)

  expect(typeof msg['graphID']).toBe('string')
  expect((msg['graphID'] as string).length).toBeGreaterThan(0)

  expect(typeof msg['txid']).toBe('string')
  expect(TXID_RE.test(msg['txid'] as string)).toBe(true)

  expect(typeof msg['outputIndex']).toBe('number')
  expect(Number.isInteger(msg['outputIndex'])).toBe(true)
  expect(msg['outputIndex'] as number).toBeGreaterThanOrEqual(0)

  expect(typeof msg['metadata']).toBe('boolean')
}

/**
 * gasp/node — GASPNode validation.
 * Shape: { graphID, rawTx (hex string), outputIndex, proof?, txMetadata?, outputMetadata?, inputs? }
 */
function dispatchNode (
  msg: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  expect(expected['valid']).toBe(true)

  // Required fields
  expect(typeof msg['graphID']).toBe('string')
  expect(typeof msg['rawTx']).toBe('string')
  // rawTx must be a non-empty hex string
  expect(/^[0-9a-fA-F]+$/.test(msg['rawTx'] as string)).toBe(true)
  expect((msg['rawTx'] as string).length).toBeGreaterThan(0)

  expect(typeof msg['outputIndex']).toBe('number')
  expect(Number.isInteger(msg['outputIndex'])).toBe(true)
  expect(msg['outputIndex'] as number).toBeGreaterThanOrEqual(0)

  // Optional fields — validate types when present
  if ('proof' in msg && msg['proof'] !== undefined) {
    expect(typeof msg['proof']).toBe('string')
    // proof is a BUMP hex string — must be non-empty hex
    expect(/^[0-9a-fA-F]+$/.test(msg['proof'] as string)).toBe(true)
  }

  if ('txMetadata' in msg && msg['txMetadata'] !== undefined) {
    expect(typeof msg['txMetadata']).toBe('string')
  }

  if ('outputMetadata' in msg && msg['outputMetadata'] !== undefined) {
    expect(typeof msg['outputMetadata']).toBe('string')
  }

  if ('inputs' in msg && msg['inputs'] !== undefined) {
    expect(typeof msg['inputs']).toBe('object')
    expect(msg['inputs']).not.toBeNull()
    const inputs = msg['inputs'] as Record<string, unknown>
    for (const [_outpoint, val] of Object.entries(inputs)) {
      expect(typeof val).toBe('object')
      expect(val).not.toBeNull()
      // Each value: { hash: string }
      const inputVal = val as Record<string, unknown>
      expect(typeof inputVal['hash']).toBe('string')
    }
  }
}

/**
 * gasp/nodeResponse — GASPNodeResponse validation.
 * Shape: { requestedInputs: Record<string, { metadata: boolean }> | null }
 * null or {} both signal graph completion.
 */
function dispatchNodeResponse (
  msg: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  expect(expected['valid']).toBe(true)

  const ri = msg['requestedInputs']
  // requestedInputs may be null (graph complete) or an object
  if (ri !== null && ri !== undefined) {
    expect(typeof ri).toBe('object')
    const riObj = ri as Record<string, unknown>
    // Each value must have { metadata: boolean }
    for (const [_key, val] of Object.entries(riObj)) {
      expect(typeof val).toBe('object')
      expect(val).not.toBeNull()
      const v = val as Record<string, unknown>
      expect(typeof v['metadata']).toBe('boolean')
    }
  }
  // null and {} are both valid — graph complete; no further assertion needed
}

// ── HTTP overlay vector dispatcher ─────────────────────────────────────────────

/**
 * HTTP overlay vectors — /requestSyncResponse and /requestForeignGASPNode.
 * These describe the GASP sync over HTTP extension on the overlay server.
 */
function dispatchHTTP (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const method = getString(input, 'method')
  const path = getString(input, 'path')
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined
  const expectedStatus = getNumber(expected, 'status')

  // Validate request structure
  expect(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)).toBe(true)
  expect(typeof path).toBe('string')
  expect(path.startsWith('/')).toBe(true)

  if (path === '/requestSyncResponse') {
    // x-bsv-topic header is required
    const hasTopic = Object.keys(headers).some(k => k.toLowerCase() === 'x-bsv-topic')
    if (!hasTopic) {
      // Vector 18: missing required header → 400
      expect(expectedStatus).toBe(400)
      if (expected['body'] !== undefined) {
        const eb = expected['body'] as Record<string, unknown>
        expect(eb['status']).toBe('error')
      }
      return
    }

    // Valid request — body is a GASPInitialRequest
    expect(body).toBeDefined()
    const b = body!
    expect(typeof b['version']).toBe('number')
    expect(typeof b['since']).toBe('number')
    expect(expectedStatus).toBe(200)

    // Response body is a GASPInitialResponse
    if (expected['body'] !== undefined) {
      const eb = expected['body'] as Record<string, unknown>
      expect(Array.isArray(eb['UTXOList'])).toBe(true)
      const utxoList = eb['UTXOList'] as unknown[]
      for (const utxo of utxoList) {
        assertGASPOutput(utxo, 'response UTXOList entry')
      }
      expect(typeof eb['since']).toBe('number')
    }
    return
  }

  if (path === '/requestForeignGASPNode') {
    expect(body).toBeDefined()
    const b = body!

    // txid validation — must be 64 hex chars
    if (typeof b['txid'] === 'string') {
      const isValidTxid = TXID_RE.test(b['txid'])
      if (!isValidTxid) {
        // Vector 20: invalid txid → 400
        expect(expectedStatus).toBe(400)
        if (expected['body'] !== undefined) {
          const eb = expected['body'] as Record<string, unknown>
          expect(eb['status']).toBe('error')
        }
        return
      }
    }

    expect(expectedStatus).toBe(200)

    // Response body is a GASPNode (minimal required fields)
    if (expected['body'] !== undefined) {
      const eb = expected['body'] as Record<string, unknown>
      expect(typeof eb['graphID']).toBe('string')
      expect(typeof eb['rawTx']).toBe('string')
      expect(typeof eb['outputIndex']).toBe('number')
    }
  }
}

// ── Main dispatch entry point ──────────────────────────────────────────────────

export function dispatch (
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  if (category !== 'gasp-protocol') {
    throw new Error(`sync dispatcher: unknown category '${category}'`)
  }

  const channel = getString(input, 'channel')
  const method = getString(input, 'method')

  // HTTP overlay vectors have a 'method' field and no 'channel' field
  if (method !== '') {
    dispatchHTTP(input, expected)
    return
  }

  const msg = (input['message'] ?? {}) as Record<string, unknown>

  switch (channel) {
    case 'gasp/initialRequest':
      dispatchInitialRequest(msg, expected)
      return
    case 'gasp/initialResponse':
      dispatchInitialResponse(msg, expected)
      return
    case 'gasp/initialReply':
      dispatchInitialReply(msg, expected)
      return
    case 'gasp/requestNode':
      dispatchRequestNode(msg, expected)
      return
    case 'gasp/node':
      dispatchNode(msg, expected)
      return
    case 'gasp/nodeResponse':
      dispatchNodeResponse(msg, expected)
      return
    default:
      throw new Error(`sync dispatcher: unknown channel '${channel}' in gasp-protocol`)
  }
}
