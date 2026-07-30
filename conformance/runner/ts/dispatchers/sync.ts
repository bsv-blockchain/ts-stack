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
import { createHash } from 'node:crypto'

export const categories: ReadonlyArray<string> = [
  'gasp-protocol',
  'brc40-user-state',
  'chaintracks-v2-http',
  'brc136-basm'
]

// ── Constants ──────────────────────────────────────────────────────────────────

/** Current GASP protocol version (from GASP.ts: this.version = 1). */
const GASP_CURRENT_VERSION = 1

/** txid pattern: exactly 64 hex characters (upper or lower). */
const TXID_RE = /^[0-9a-fA-F]{64}$/
const ZERO_HASH = '0000000000000000000000000000000000000000000000000000000000000000'

// ── Helpers ────────────────────────────────────────────────────────────────────

function getString(m: Record<string, unknown>, key: string): string {
  const v = m[key]
  return typeof v === 'string' ? v : ''
}

function getNumber(m: Record<string, unknown>, key: string): number {
  const v = m[key]
  return typeof v === 'number' ? v : 0
}

/** Assert a GASPOutput object has correct field types and constraint values. */
function assertGASPOutput(output: unknown, _ctx: string): void {
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
function dispatchInitialRequest(
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
function dispatchInitialResponse(
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
function dispatchInitialReply(
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
function dispatchRequestNode(
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
function dispatchNode(msg: Record<string, unknown>, expected: Record<string, unknown>): void {
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
function dispatchNodeResponse(
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
function dispatchRequestSyncResponse(
  headers: Record<string, string>,
  body: Record<string, unknown> | undefined,
  expected: Record<string, unknown>
): void {
  const hasTopic = Object.keys(headers).some(k => k.toLowerCase() === 'x-bsv-topic')
  if (!hasTopic) {
    expect(getNumber(expected, 'status')).toBe(400)
    const expectedBody = expected['body'] as Record<string, unknown> | undefined
    if (expectedBody !== undefined) expect(expectedBody['status']).toBe('error')
    return
  }
  if (body === undefined) return

  expect(typeof body['version']).toBe('number')
  expect(typeof body['since']).toBe('number')
  expect(getNumber(expected, 'status')).toBe(200)

  const expectedBody = expected['body'] as Record<string, unknown> | undefined
  if (expectedBody === undefined) return
  expect(Array.isArray(expectedBody['UTXOList'])).toBe(true)
  for (const utxo of expectedBody['UTXOList'] as unknown[]) {
    assertGASPOutput(utxo, 'response UTXOList entry')
  }
  expect(typeof expectedBody['since']).toBe('number')
}

function dispatchForeignGASPNode(
  body: Record<string, unknown> | undefined,
  expected: Record<string, unknown>
): void {
  if (body === undefined) return
  if (typeof body['txid'] === 'string' && !TXID_RE.test(body['txid'])) {
    expect(getNumber(expected, 'status')).toBe(400)
    const expectedBody = expected['body'] as Record<string, unknown> | undefined
    if (expectedBody !== undefined) expect(expectedBody['status']).toBe('error')
    return
  }

  expect(getNumber(expected, 'status')).toBe(200)
  const expectedBody = expected['body'] as Record<string, unknown> | undefined
  if (expectedBody !== undefined) {
    expect(typeof expectedBody['graphID']).toBe('string')
    expect(typeof expectedBody['rawTx']).toBe('string')
    expect(typeof expectedBody['outputIndex']).toBe('number')
  }
}

function dispatchHTTP(input: Record<string, unknown>, expected: Record<string, unknown>): void {
  const method = getString(input, 'method')
  const path = getString(input, 'path')
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const body = input['body'] as Record<string, unknown> | undefined

  expect(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)).toBe(true)
  expect(path.startsWith('/')).toBe(true)

  if (path === '/requestSyncResponse') {
    dispatchRequestSyncResponse(headers, body, expected)
  } else if (path === '/requestForeignGASPNode') {
    dispatchForeignGASPNode(body, expected)
  }
}

// ── BRC-40 (User Wallet Data Synchronization) ─────────────────────────────────
//
// Type references (from packages/wallet/wallet-toolbox/src/sdk/WalletStorage.interfaces.ts):
//   RequestSyncChunkArgs {
//     fromStorageIdentityKey: string
//     toStorageIdentityKey:   string
//     identityKey:            string
//     since?: Date                 // serialized as ISO-8601 string in vectors
//     maxRoughSize: number         // integer >= 1
//     maxItems:     number         // integer >= 1
//     offsets: { name: string, offset: integer >= 0 }[]
//   }
//   SyncChunk {
//     fromStorageIdentityKey: string
//     toStorageIdentityKey:   string
//     userIdentityKey:        string
//     user?: TableUser
//     provenTxs?, provenTxReqs?, outputBaskets?, txLabels?, outputTags?,
//     transactions?, txLabelMaps?, commissions?, outputs?, outputTagMaps?,
//     certificates?, certificateFields?: Table*[]
//   }

const BRC40_ENTITY_KEYS = [
  'user',
  'provenTxs',
  'provenTxReqs',
  'outputBaskets',
  'txLabels',
  'outputTags',
  'transactions',
  'txLabelMaps',
  'commissions',
  'outputs',
  'outputTagMaps',
  'certificates',
  'certificateFields'
] as const

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isNonEmptyHexPubkey(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-fA-F]+$/.test(v) && v.length >= 2
}

type BRC40RequestValidation = { ok: true } | { ok: false; field?: string; reason?: string }

function validateSince(value: unknown): BRC40RequestValidation {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'string' || !ISO_8601_RE.test(value)) {
    return { ok: false, field: 'since', reason: 'must be ISO-8601 string' }
  }
  return { ok: true }
}

function validatePositiveInteger(
  m: Record<string, unknown>,
  field: 'maxRoughSize' | 'maxItems'
): BRC40RequestValidation {
  const value = m[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return { ok: false, field, reason: 'integer >= 1' }
  }
  return { ok: true }
}

function validateOffsets(value: unknown): BRC40RequestValidation {
  if (!Array.isArray(value)) return { ok: false, field: 'offsets' }
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, field: 'offsets', reason: 'entry must be object' }
    }
    const offset = entry as Record<string, unknown>
    if (typeof offset['name'] !== 'string' || offset['name'].length === 0) {
      return { ok: false, field: 'offsets', reason: 'offset.name required' }
    }
    if (
      typeof offset['offset'] !== 'number' ||
      !Number.isInteger(offset['offset']) ||
      offset['offset'] < 0
    ) {
      return { ok: false, field: 'offsets', reason: 'offset must be integer >= 0' }
    }
  }
  return { ok: true }
}

/** Pure structural validation of RequestSyncChunkArgs. Returns true if request is well-formed. */
function isValidBRC40Request(m: Record<string, unknown>): BRC40RequestValidation {
  for (const field of ['fromStorageIdentityKey', 'toStorageIdentityKey', 'identityKey'] as const) {
    if (!isNonEmptyHexPubkey(m[field])) return { ok: false, field }
  }
  const since = validateSince(m['since'])
  if (!since.ok) return since
  const roughSize = validatePositiveInteger(m, 'maxRoughSize')
  if (!roughSize.ok) return roughSize
  const maxItems = validatePositiveInteger(m, 'maxItems')
  if (!maxItems.ok) return maxItems
  return validateOffsets(m['offsets'])
}

/** Pure structural validation of a SyncChunk message. */
function validateSyncChunkIdentity(
  message: Record<string, unknown>,
  request: Record<string, unknown> | undefined
): string | undefined {
  if (!isNonEmptyHexPubkey(message['fromStorageIdentityKey'])) return 'fromStorageIdentityKey'
  if (!isNonEmptyHexPubkey(message['toStorageIdentityKey'])) return 'toStorageIdentityKey'
  if (!isNonEmptyHexPubkey(message['userIdentityKey'])) return 'userIdentityKey'
  if (
    request !== undefined &&
    typeof request['identityKey'] === 'string' &&
    request['identityKey'] !== message['userIdentityKey']
  ) {
    return 'ERR_BRC40_USER_MISMATCH'
  }
  return undefined
}

function validateSyncRows(rows: unknown[]): string | undefined {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') return 'ERR_BRC40_NULL_ENTITY'
    const record = row as Record<string, unknown>
    if (typeof record['updated_at'] !== 'string' || !ISO_8601_RE.test(record['updated_at'])) {
      return 'ERR_BRC40_MISSING_TIMESTAMP:updated_at'
    }
    if (typeof record['created_at'] !== 'string' || !ISO_8601_RE.test(record['created_at'])) {
      return 'ERR_BRC40_MISSING_TIMESTAMP:created_at'
    }
  }
  return undefined
}

function validateSyncEntity(
  key: string,
  value: unknown
): { ok: true; isArray: boolean; isEmpty: boolean } | { ok: false; reason: string } {
  if (key === 'user') {
    if (value !== undefined && (typeof value !== 'object' || value === null)) {
      return { ok: false, reason: `${key} must be object` }
    }
    return { ok: true, isArray: false, isEmpty: true }
  }
  if (!Array.isArray(value)) return { ok: false, reason: `${key} must be array` }
  const invalidReason = validateSyncRows(value)
  if (invalidReason !== undefined) return { ok: false, reason: invalidReason }
  return { ok: true, isArray: true, isEmpty: value.length === 0 }
}

function isValidBRC40SyncChunk(
  m: Record<string, unknown>,
  request?: Record<string, unknown>
): { ok: true; allEmpty: boolean } | { ok: false; reason: string } {
  const identityError = validateSyncChunkIdentity(m, request)
  if (identityError !== undefined) return { ok: false, reason: identityError }

  let allPresentArraysEmpty = true
  let arrayKeyCount = 0
  for (const key of BRC40_ENTITY_KEYS) {
    if (!(key in m)) continue
    const validation = validateSyncEntity(key, m[key])
    if (!validation.ok) return validation
    if (!validation.isArray) continue
    arrayKeyCount += 1
    if (!validation.isEmpty) allPresentArraysEmpty = false
  }
  // Completion sentinel = all 12 entity arrays present AND empty
  const allEmpty = allPresentArraysEmpty && arrayKeyCount === 12
  return { ok: true, allEmpty }
}

function scalarKeyPart(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  return null
}

const BRC40_ID_MAPPING_KEYS: Record<string, (row: Record<string, unknown>) => string | null> = {
  provenTxs: row => (typeof row['txid'] === 'string' ? (row['txid'] as string) : null),
  outputBaskets: row => {
    const userId = scalarKeyPart(row['userId'])
    return userId !== null && typeof row['name'] === 'string' ? `${userId}::${row['name']}` : null
  }
}

function recordIdMappings(
  entity: string,
  getKey: (row: Record<string, unknown>) => string | null,
  rows: unknown[],
  seen: Record<string, Map<string, unknown>>
): boolean {
  seen[entity] ??= new Map<string, unknown>()
  const surrogateField = entity === 'provenTxs' ? 'provenTxId' : 'basketId'
  for (const row of rows) {
    const record = row as Record<string, unknown>
    const key = getKey(record)
    if (key === null) continue
    const surrogate = record[surrogateField]
    if (!seen[entity].has(key)) {
      seen[entity].set(key, surrogate)
      continue
    }
    if (seen[entity].get(key) !== surrogate && entity === 'outputBaskets') return false
  }
  return true
}

/** Detect ID-mapping conflict / convergence across a sequence of SyncChunks. */
function detectIdMappingResult(
  messages: Array<Record<string, unknown>>
): { ok: true } | { ok: false; reason: string } {
  const seen: Record<string, Map<string, unknown>> = {}
  for (const chunk of messages) {
    const sc = (chunk['syncChunk'] ?? chunk) as Record<string, unknown>
    for (const [entity, getKey] of Object.entries(BRC40_ID_MAPPING_KEYS)) {
      const rows = sc[entity]
      if (!Array.isArray(rows)) continue
      if (!recordIdMappings(entity, getKey, rows, seen)) {
        return { ok: false, reason: 'ERR_BRC40_ID_MAPPING_CONFLICT' }
      }
    }
  }
  return { ok: true }
}

/**
 * Reference merge semantics from wallet-toolbox EntityTransaction.mergeExisting /
 * EntityOutput.mergeExisting / EntityProvenTx.mergeExisting:
 *
 *   if (incoming.updated_at > existing.updated_at) → UPDATE
 *   else                                            → SKIP
 *
 * Strict `>` — equal timestamps do NOT update. This is the guard absent in
 * go-wallet-toolbox upsert paths (issue go-wallet-toolbox#853): stale chunks
 * with older updated_at must not regress mutable fields (transaction.status,
 * transaction.provenTxId, output.spendable, output.spentBy).
 */
function mergeAction(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): 'update' | 'skip' {
  const e =
    typeof existing['updated_at'] === 'string'
      ? Date.parse(existing['updated_at'] as string)
      : Number.NaN
  const i =
    typeof incoming['updated_at'] === 'string'
      ? Date.parse(incoming['updated_at'] as string)
      : Number.NaN
  if (Number.isNaN(e) || Number.isNaN(i)) return 'skip'
  return i > e ? 'update' : 'skip'
}

const BRC40_REPLAY_KEYS: Record<string, (row: Record<string, unknown>) => string | null> = {
  transactions: row => {
    const id = scalarKeyPart(row['transactionId'])
    return id === null ? null : `tx::${id}`
  },
  outputs: row => {
    const id = scalarKeyPart(row['outputId'])
    return id === null ? null : `out::${id}`
  },
  provenTxs: row => (typeof row['txid'] === 'string' ? `ptx::${row['txid'] as string}` : null)
}

function replayEntityRows(
  entity: string,
  getKey: (row: Record<string, unknown>) => string | null,
  rows: unknown[],
  state: Record<string, Map<string, Record<string, unknown>>>
): void {
  state[entity] ??= new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const record = row as Record<string, unknown>
    const key = getKey(record)
    if (key === null) continue
    const prior = state[entity].get(key)
    if (prior === undefined || mergeAction(prior, record) === 'update') {
      state[entity].set(key, record)
    }
  }
}

/** Replay an ordered chunk sequence and produce the post-merge state per natural key. */
function replayChunks(
  messages: Array<Record<string, unknown>>
): Record<string, Map<string, Record<string, unknown>>> {
  const state: Record<string, Map<string, Record<string, unknown>>> = {}
  for (const chunk of messages) {
    const sc = (chunk['syncChunk'] ?? chunk) as Record<string, unknown>
    for (const [entity, getKey] of Object.entries(BRC40_REPLAY_KEYS)) {
      const rows = sc[entity]
      if (!Array.isArray(rows)) continue
      replayEntityRows(entity, getKey, rows, state)
    }
  }
  return state
}

function dispatchBRC40MergeExisting(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const existing = (input['existing'] ?? {}) as Record<string, unknown>
  const incoming = (input['incoming'] ?? {}) as Record<string, unknown>
  expect(expected['valid']).toBe(true)
  expect(mergeAction(existing, incoming)).toBe(expected['action'])
}

function dispatchBRC40Request(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const message = (input['message'] ?? {}) as Record<string, unknown>
  const result = isValidBRC40Request(message)
  if (result.ok) {
    expect(expected['valid']).toBe(true)
    return
  }

  expect(expected['valid']).toBe(false)
  const expectedError = expected['error'] as Record<string, unknown> | undefined
  if (expectedError === undefined) return

  expect(typeof expectedError['code']).toBe('string')
  expect((expectedError['code'] as string).startsWith('ERR_BRC40_')).toBe(true)
  if (typeof expectedError['field'] === 'string' && result.field !== undefined) {
    expect(expectedError['field']).toBe(result.field)
  }
}

function dispatchBRC40SyncChunk(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const message = (input['message'] ?? {}) as Record<string, unknown>
  const request = input['request'] as Record<string, unknown> | undefined
  const result = isValidBRC40SyncChunk(message, request)
  if (!result.ok) {
    expect(expected['valid']).toBe(false)
    const expectedError = expected['error'] as Record<string, unknown> | undefined
    if (expectedError !== undefined && typeof expectedError['code'] === 'string') {
      expect((expectedError['code'] as string).startsWith('ERR_BRC40_')).toBe(true)
    }
    return
  }

  expect(expected['valid']).toBe(true)
  if (expected['done'] === true) {
    expect(result.allEmpty).toBe(true)
  }
}

function expectedReplayKey(entity: string, row: Record<string, unknown>): string | undefined {
  if (entity === 'transactions') {
    const id = scalarKeyPart(row['transactionId'])
    return id === null ? undefined : `tx::${id}`
  }
  if (entity === 'outputs') {
    const id = scalarKeyPart(row['outputId'])
    return id === null ? undefined : `out::${id}`
  }
  if (entity === 'provenTxs' && typeof row['txid'] === 'string') {
    return `ptx::${row['txid']}`
  }
  return undefined
}

function assertExpectedReplayRow(
  entity: string,
  expectedRow: Record<string, unknown>,
  stateMap: Map<string, Record<string, unknown>>
): void {
  const key = expectedReplayKey(entity, expectedRow)
  expect(key).toBeDefined()
  if (key === undefined) return

  const actual = stateMap.get(key)
  expect(actual).toBeDefined()
  if (actual === undefined) return

  for (const [field, value] of Object.entries(expectedRow)) {
    expect(actual[field]).toBe(value)
  }
}

function assertBRC40FinalState(
  messages: Array<Record<string, unknown>>,
  finalState: Record<string, unknown>
): void {
  const replayed = replayChunks(messages)
  for (const [entity, expectedRows] of Object.entries(finalState)) {
    if (!Array.isArray(expectedRows)) continue
    const stateMap = replayed[entity] ?? new Map<string, Record<string, unknown>>()
    for (const expectedRow of expectedRows as Array<Record<string, unknown>>) {
      assertExpectedReplayRow(entity, expectedRow, stateMap)
    }
  }
}

function allBRC40ChunksValid(messages: Array<Record<string, unknown>>): boolean {
  for (const chunk of messages) {
    const syncChunk = (chunk['syncChunk'] ?? {}) as Record<string, unknown>
    if (!isValidBRC40SyncChunk(syncChunk).ok) return false
  }
  return true
}

function dispatchBRC40MessageFlow(
  messages: Array<Record<string, unknown>>,
  expected: Record<string, unknown>
): void {
  if (!allBRC40ChunksValid(messages)) {
    expect(expected['valid']).toBe(false)
    return
  }

  const conflict = detectIdMappingResult(messages)
  if (!conflict.ok) {
    expect(expected['valid']).toBe(false)
    const expectedError = expected['error'] as Record<string, unknown> | undefined
    if (expectedError !== undefined) {
      expect(expectedError['code']).toBe(conflict.reason)
    }
    return
  }

  expect(expected['valid']).toBe(true)
  const finalState = expected['finalState'] as Record<string, unknown> | undefined
  if (finalState !== undefined) {
    // Covers go-wallet-toolbox#853: stale chunks must not regress mutable fields.
    assertBRC40FinalState(messages, finalState)
  }
}

function rowReachesSinceBoundary(row: unknown, sinceMs: number): boolean {
  const candidate = row as Record<string, unknown>
  const updatedAt = candidate['updated_at']
  if (typeof updatedAt !== 'string') return false
  const updatedAtMs = Date.parse(updatedAt)
  return !Number.isNaN(updatedAtMs) && updatedAtMs >= sinceMs
}

function hasInclusiveSinceBoundary(
  request: Record<string, unknown>,
  syncChunk: Record<string, unknown>
): boolean | undefined {
  const since = request['since']
  if (typeof since !== 'string') return undefined
  const sinceMs = Date.parse(since)

  for (const key of BRC40_ENTITY_KEYS) {
    if (key === 'user') continue
    const rows = syncChunk[key]
    if (Array.isArray(rows) && rows.some(row => rowReachesSinceBoundary(row, sinceMs))) {
      return true
    }
  }
  return false
}

function dispatchBRC40BoundaryFlow(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const request = input['request'] as Record<string, unknown>
  const response = input['response'] as Record<string, unknown>
  const syncChunk = (response['syncChunk'] ?? {}) as Record<string, unknown>
  if (!isValidBRC40SyncChunk(syncChunk).ok) {
    expect(expected['valid']).toBe(false)
    return
  }

  const foundBoundary = hasInclusiveSinceBoundary(request, syncChunk)
  if (foundBoundary !== undefined) {
    expect(foundBoundary).toBe(true)
  }
  expect(expected['valid']).toBe(true)
}

function dispatchBRC40Flow(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  if (Array.isArray(input['messages'])) {
    dispatchBRC40MessageFlow(input['messages'] as Array<Record<string, unknown>>, expected)
    return
  }
  if (input['request'] !== undefined && input['response'] !== undefined) {
    dispatchBRC40BoundaryFlow(input, expected)
    return
  }
  throw new Error('brc40/flow vector: must have either messages[] or request+response')
}

function dispatchBRC40(input: Record<string, unknown>, expected: Record<string, unknown>): void {
  const channel = getString(input, 'channel')
  if (channel === 'brc40/mergeExisting') {
    dispatchBRC40MergeExisting(input, expected)
    return
  }
  if (channel === 'brc40/requestSyncChunk') {
    dispatchBRC40Request(input, expected)
    return
  }
  if (channel === 'brc40/syncChunk') {
    dispatchBRC40SyncChunk(input, expected)
    return
  }
  if (channel === 'brc40/flow') {
    dispatchBRC40Flow(input, expected)
    return
  }
  throw new Error(`sync dispatcher: unknown channel '${channel}' in brc40-user-state`)
}

// ── Chaintracks v2 HTTP vector dispatcher ──────────────────────────────────────
//
// Structural validation of the chaintracks-server v2 REST contract. Cross-language
// implementations replace this with real HTTP calls against a running server;
// here we only assert that each vector's expected payload obeys the v2 envelope
// rules so the corpus stays well-formed.

const V2_PATH_RE =
  /^\/v2\/(network|tip(?:\.bin)?|header\/height\/.+|header\/hash\/.+|headers(?:\.bin)?)$/
const V2_ERROR_CODES: ReadonlySet<string> = new Set([
  'ERR_INVALID_PARAMS',
  'ERR_NOT_FOUND',
  'ERR_NO_TIP',
  'ERR_INTERNAL'
])

function assertSuccessEnvelope(eb: Record<string, unknown>): void {
  expect(eb['status']).toBe('success')
  expect('value' in eb).toBe(true)
}

function assertErrorEnvelope(eb: Record<string, unknown>): void {
  expect(eb['status']).toBe('error')
  const code = eb['code']
  expect(typeof code).toBe('string')
  expect(V2_ERROR_CODES.has(code as string)).toBe(true)
  expect(typeof eb['description']).toBe('string')
}

function assertBinaryShape(shape: Record<string, unknown>): void {
  expect(shape['encoding']).toBe('binary')
  const len = shape['length_bytes']
  // length_bytes may be a fixed integer or a formula string for variable-length payloads.
  if (typeof len === 'number') {
    expect(Number.isInteger(len) && len >= 0).toBe(true)
    const stride = shape['stride']
    if (typeof stride === 'number') {
      expect(len % stride).toBe(0)
    }
  } else {
    expect(typeof len).toBe('string')
  }
}

function dispatchChaintracksV2(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const method = getString(input, 'method')
  const path = getString(input, 'path')
  expect(method).toBe('GET')
  expect(V2_PATH_RE.test(path)).toBe(true)

  const status = getNumber(expected, 'status')
  expect([200, 400, 404].includes(status)).toBe(true)

  if (status >= 400) {
    const body = expected['body']
    expect(body !== undefined).toBe(true)
    assertErrorEnvelope(body as Record<string, unknown>)
    return
  }

  // Success path — either a JSON envelope (body) or a binary shape (body_shape).
  const hasJson = expected['body'] !== undefined
  const hasShape = expected['body_shape'] !== undefined
  expect(hasJson || hasShape).toBe(true)

  if (hasJson) {
    assertSuccessEnvelope(expected['body'] as Record<string, unknown>)
  }
  if (hasShape) {
    const shape = expected['body_shape'] as Record<string, unknown>
    if (shape['encoding'] === 'binary') {
      assertBinaryShape(shape)
    } else {
      // JSON success shape — must describe a {status, value} envelope.
      expect(shape['status']).toBe('success')
      expect('value' in shape).toBe(true)
    }
  }
}

// ── BRC-136 BASM ──────────────────────────────────────────────────────────────

function sha256d(buffer: Buffer): Buffer {
  const first = createHash('sha256').update(buffer).digest()
  return createHash('sha256').update(first).digest()
}

function displayToInternal(hash: string): Buffer {
  expect(TXID_RE.test(hash)).toBe(true)
  return Buffer.from(hash, 'hex').reverse()
}

function internalToDisplay(hash: Buffer): string {
  return Buffer.from(hash).reverse().toString('hex')
}

function computeBasmRootForVector(txids: string[]): string {
  if (txids.length === 0) return ZERO_HASH
  let layer = txids.map(displayToInternal)
  if (layer.length === 1) return internalToDisplay(layer[0])
  while (layer.length > 1) {
    const next: Buffer[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i]
      next.push(sha256d(Buffer.concat([layer[i], right])))
    }
    layer = next
  }
  return internalToDisplay(layer[0])
}

function computeTacForVector(prevTac: string, blockHash: string, basmRoot: string): string {
  return internalToDisplay(
    sha256d(
      Buffer.concat([
        displayToInternal(prevTac),
        displayToInternal(blockHash),
        displayToInternal(basmRoot)
      ])
    )
  )
}

function dispatchBRC136HTTP(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const method = getString(input, 'method')
  const path = getString(input, 'path')
  const headers = (input['headers'] ?? {}) as Record<string, string>
  const expectedStatus = getNumber(expected, 'status')

  expect(method).toBe('POST')
  expect(path.startsWith('/request')).toBe(true)
  const requiresTopic = path !== '/requestRawTransactions'
  if (requiresTopic) {
    const hasTopic = Object.keys(headers).some(k => k.toLowerCase() === 'x-bsv-topic')
    expect(hasTopic).toBe(expectedStatus < 400)
  }

  if (expectedStatus >= 400) {
    const body = expected['body']
    expect(body !== undefined).toBe(true)
    assertErrorEnvelope(body as Record<string, unknown>)
    return
  }

  if (expected['body'] !== undefined) {
    const body = expected['body'] as Record<string, unknown>
    if (path === '/requestTopicAnchorTip') {
      expect(typeof body['topic']).toBe('string')
      expect(typeof body['blockHeight']).toBe('number')
      expect(typeof body['tac']).toBe('string')
      expect(TXID_RE.test(body['tac'] as string)).toBe(true)
    }
  }
}

function dispatchBRC136(input: Record<string, unknown>, expected: Record<string, unknown>): void {
  const method = getString(input, 'method')
  if (method !== '') {
    dispatchBRC136HTTP(input, expected)
    return
  }

  const channel = getString(input, 'channel')
  if (channel === 'basm/root') {
    const cases = input['cases'] as Array<{ name: string; txids: string[] }>
    const roots = (expected['roots'] ?? {}) as Record<string, string>
    for (const testCase of cases) {
      expect(computeBasmRootForVector(testCase.txids)).toBe(roots[testCase.name])
    }
    return
  }

  if (channel === 'basm/tac') {
    expect(
      computeTacForVector(
        getString(input, 'prevTac'),
        getString(input, 'blockHash'),
        getString(input, 'basmRoot')
      )
    ).toBe(expected['tac'])
    return
  }

  if (channel === 'basm/rawTransactions') {
    const msg = (input['message'] ?? {}) as Record<string, unknown>
    expect(Array.isArray(msg['transactions'])).toBe(true)
    for (const record of msg['transactions'] as unknown[]) {
      expect(typeof record).toBe('object')
      expect(record).not.toBeNull()
      const tx = record as Record<string, unknown>
      expect(typeof tx['txid']).toBe('string')
      expect(TXID_RE.test(tx['txid'] as string)).toBe(true)
      expect(typeof tx['rawTx']).toBe('string')
      expect(/^[0-9a-fA-F]+$/.test(tx['rawTx'] as string)).toBe(true)
    }
    expect(Array.isArray(msg['missing'])).toBe(true)
    expect(expected['valid']).toBe(true)
    return
  }

  throw new Error(`sync dispatcher: unknown BRC-136 BASM channel '${channel}'`)
}

// ── Main dispatch entry point ──────────────────────────────────────────────────

export function dispatch(
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  if (category === 'brc40-user-state') {
    dispatchBRC40(input, expected)
    return
  }
  if (category === 'chaintracks-v2-http') {
    dispatchChaintracksV2(input, expected)
    return
  }
  if (category === 'brc136-basm') {
    dispatchBRC136(input, expected)
    return
  }
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
