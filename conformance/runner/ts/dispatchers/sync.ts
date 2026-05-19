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
  'gasp-protocol',
  'brc40-user-state'
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
    if (body === undefined) return
    const b = body
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
    if (body === undefined) return
    const b = body

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
  'provenTxs', 'provenTxReqs', 'outputBaskets', 'txLabels', 'outputTags',
  'transactions', 'txLabelMaps', 'commissions', 'outputs', 'outputTagMaps',
  'certificates', 'certificateFields'
] as const

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isNonEmptyHexPubkey (v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-fA-F]+$/.test(v) && v.length >= 2
}

/** Pure structural validation of RequestSyncChunkArgs. Returns true if request is well-formed. */
function isValidBRC40Request (m: Record<string, unknown>): { ok: true } | { ok: false; field?: string; reason?: string } {
  if (!isNonEmptyHexPubkey(m['fromStorageIdentityKey'])) return { ok: false, field: 'fromStorageIdentityKey' }
  if (!isNonEmptyHexPubkey(m['toStorageIdentityKey'])) return { ok: false, field: 'toStorageIdentityKey' }
  if (!isNonEmptyHexPubkey(m['identityKey'])) return { ok: false, field: 'identityKey' }
  if ('since' in m && m['since'] !== undefined) {
    if (typeof m['since'] !== 'string' || !ISO_8601_RE.test(m['since'])) {
      return { ok: false, field: 'since', reason: 'must be ISO-8601 string' }
    }
  }
  if (typeof m['maxRoughSize'] !== 'number' || !Number.isInteger(m['maxRoughSize']) || (m['maxRoughSize'] as number) < 1) {
    return { ok: false, field: 'maxRoughSize', reason: 'integer >= 1' }
  }
  if (typeof m['maxItems'] !== 'number' || !Number.isInteger(m['maxItems']) || (m['maxItems'] as number) < 1) {
    return { ok: false, field: 'maxItems', reason: 'integer >= 1' }
  }
  if (!Array.isArray(m['offsets'])) return { ok: false, field: 'offsets' }
  for (const entry of m['offsets'] as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, field: 'offsets', reason: 'entry must be object' }
    }
    const e = entry as Record<string, unknown>
    if (typeof e['name'] !== 'string' || (e['name'] as string).length === 0) {
      return { ok: false, field: 'offsets', reason: 'offset.name required' }
    }
    if (typeof e['offset'] !== 'number' || !Number.isInteger(e['offset']) || (e['offset'] as number) < 0) {
      return { ok: false, field: 'offsets', reason: 'offset must be integer >= 0' }
    }
  }
  return { ok: true }
}

/** Pure structural validation of a SyncChunk message. */
function isValidBRC40SyncChunk (
  m: Record<string, unknown>,
  request?: Record<string, unknown>
): { ok: true; allEmpty: boolean } | { ok: false; reason: string } {
  if (!isNonEmptyHexPubkey(m['fromStorageIdentityKey'])) return { ok: false, reason: 'fromStorageIdentityKey' }
  if (!isNonEmptyHexPubkey(m['toStorageIdentityKey'])) return { ok: false, reason: 'toStorageIdentityKey' }
  if (!isNonEmptyHexPubkey(m['userIdentityKey'])) return { ok: false, reason: 'userIdentityKey' }

  if (request !== undefined && typeof request['identityKey'] === 'string') {
    if (request['identityKey'] !== m['userIdentityKey']) {
      return { ok: false, reason: 'ERR_BRC40_USER_MISMATCH' }
    }
  }

  let allPresentArraysEmpty = true
  let arrayKeyCount = 0
  for (const key of BRC40_ENTITY_KEYS) {
    if (!(key in m)) continue
    const val = m[key]
    if (key === 'user') {
      if (val !== undefined && (typeof val !== 'object' || val === null)) {
        return { ok: false, reason: `${key} must be object` }
      }
      continue
    }
    if (!Array.isArray(val)) return { ok: false, reason: `${key} must be array` }
    arrayKeyCount++
    if (val.length > 0) allPresentArraysEmpty = false
    for (const row of val) {
      if (row === null || typeof row !== 'object') {
        return { ok: false, reason: 'ERR_BRC40_NULL_ENTITY' }
      }
      const r = row as Record<string, unknown>
      if (typeof r['updated_at'] !== 'string' || !ISO_8601_RE.test(r['updated_at'])) {
        return { ok: false, reason: 'ERR_BRC40_MISSING_TIMESTAMP:updated_at' }
      }
      if (typeof r['created_at'] !== 'string' || !ISO_8601_RE.test(r['created_at'])) {
        return { ok: false, reason: 'ERR_BRC40_MISSING_TIMESTAMP:created_at' }
      }
    }
  }
  // Completion sentinel = all 12 entity arrays present AND empty
  const allEmpty = allPresentArraysEmpty && arrayKeyCount === 12
  return { ok: true, allEmpty }
}

/** Detect ID-mapping conflict / convergence across a sequence of SyncChunks. */
function detectIdMappingResult (
  messages: Array<Record<string, unknown>>
): { ok: true } | { ok: false; reason: string } {
  // Natural-key index per entity
  const naturalKeyForEntity: Record<string, (row: Record<string, unknown>) => string | null> = {
    provenTxs: (r) => typeof r['txid'] === 'string' ? r['txid'] as string : null,
    outputBaskets: (r) =>
      r['userId'] !== undefined && typeof r['name'] === 'string'
        ? `${String(r['userId'])}::${r['name'] as string}` : null
  }
  // For each entity, track natural-key → producer-side surrogate ID seen
  const seen: Record<string, Map<string, unknown>> = {}
  for (const chunk of messages) {
    const sc = (chunk['syncChunk'] ?? chunk) as Record<string, unknown>
    for (const [entity, getKey] of Object.entries(naturalKeyForEntity)) {
      const rows = sc[entity]
      if (!Array.isArray(rows)) continue
      seen[entity] ??= new Map<string, unknown>()
      const surrogateField = entity === 'provenTxs' ? 'provenTxId' : 'basketId'
      for (const row of rows) {
        const r = row as Record<string, unknown>
        const k = getKey(r)
        if (k === null) continue
        const surrogate = r[surrogateField]
        if (seen[entity].has(k)) {
          const prior = seen[entity].get(k)
          if (prior !== surrogate) {
            // Same natural key → distinct surrogate. Convergence only valid if natural key
            // identifies the same logical row; conflict if entity has user/local uniqueness
            // constraint enforced by natural key alone. For provenTxs the natural key (txid)
            // IS globally unique, so different surrogates → convergence (ok). For
            // outputBaskets the natural key (userId, name) is unique per producer; different
            // surrogates → ID-mapping conflict.
            if (entity === 'outputBaskets') {
              return { ok: false, reason: 'ERR_BRC40_ID_MAPPING_CONFLICT' }
            }
          }
        } else {
          seen[entity].set(k, surrogate)
        }
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
function mergeAction (
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): 'update' | 'skip' {
  const e = typeof existing['updated_at'] === 'string' ? Date.parse(existing['updated_at'] as string) : NaN
  const i = typeof incoming['updated_at'] === 'string' ? Date.parse(incoming['updated_at'] as string) : NaN
  if (Number.isNaN(e) || Number.isNaN(i)) return 'skip'
  return i > e ? 'update' : 'skip'
}

/** Replay an ordered chunk sequence and produce the post-merge state per natural key. */
function replayChunks (
  messages: Array<Record<string, unknown>>
): Record<string, Map<string, Record<string, unknown>>> {
  const state: Record<string, Map<string, Record<string, unknown>>> = {}
  const naturalKey: Record<string, (r: Record<string, unknown>) => string | null> = {
    transactions: (r) => r['transactionId'] !== undefined ? `tx::${String(r['transactionId'])}` : null,
    outputs: (r) => r['outputId'] !== undefined ? `out::${String(r['outputId'])}` : null,
    provenTxs: (r) => typeof r['txid'] === 'string' ? `ptx::${r['txid'] as string}` : null
  }
  for (const chunk of messages) {
    const sc = (chunk['syncChunk'] ?? chunk) as Record<string, unknown>
    for (const [entity, getKey] of Object.entries(naturalKey)) {
      const rows = sc[entity]
      if (!Array.isArray(rows)) continue
      state[entity] ??= new Map<string, Record<string, unknown>>()
      for (const row of rows) {
        const r = row as Record<string, unknown>
        const k = getKey(r)
        if (k === null) continue
        const prior = state[entity].get(k)
        if (prior === undefined || mergeAction(prior, r) === 'update') {
          state[entity].set(k, r)
        }
      }
    }
  }
  return state
}

function dispatchBRC40 (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const channel = getString(input, 'channel')

  if (channel === 'brc40/mergeExisting') {
    const existing = (input['existing'] ?? {}) as Record<string, unknown>
    const incoming = (input['incoming'] ?? {}) as Record<string, unknown>
    const action = mergeAction(existing, incoming)
    expect(expected['valid']).toBe(true)
    expect(action).toBe(expected['action'])
    return
  }

  if (channel === 'brc40/requestSyncChunk') {
    const msg = (input['message'] ?? {}) as Record<string, unknown>
    const result = isValidBRC40Request(msg)
    if (!result.ok) {
      expect(expected['valid']).toBe(false)
      const errExp = expected['error'] as Record<string, unknown> | undefined
      if (errExp !== undefined) {
        expect(typeof errExp['code']).toBe('string')
        expect((errExp['code'] as string).startsWith('ERR_BRC40_')).toBe(true)
        if (typeof errExp['field'] === 'string' && result.field !== undefined) {
          expect(errExp['field']).toBe(result.field)
        }
      }
      return
    }
    expect(expected['valid']).toBe(true)
    return
  }

  if (channel === 'brc40/syncChunk') {
    const msg = (input['message'] ?? {}) as Record<string, unknown>
    const request = input['request'] as Record<string, unknown> | undefined
    const result = isValidBRC40SyncChunk(msg, request)
    if (!result.ok) {
      expect(expected['valid']).toBe(false)
      const errExp = expected['error'] as Record<string, unknown> | undefined
      if (errExp !== undefined && typeof errExp['code'] === 'string') {
        expect((errExp['code'] as string).startsWith('ERR_BRC40_')).toBe(true)
      }
      return
    }
    expect(expected['valid']).toBe(true)
    if (expected['done'] === true) {
      expect(result.allEmpty).toBe(true)
    }
    return
  }

  if (channel === 'brc40/flow') {
    // Two flow shapes:
    //   1. messages: [{ syncChunk: SyncChunk }, ...]  — id-mapping convergence/conflict
    //   2. request: { since }, response: { syncChunk: SyncChunk }  — boundary semantics
    if (Array.isArray(input['messages'])) {
      const messages = input['messages'] as Array<Record<string, unknown>>
      // Per-chunk shape validation
      for (const chunk of messages) {
        const sc = (chunk['syncChunk'] ?? {}) as Record<string, unknown>
        const r = isValidBRC40SyncChunk(sc)
        if (!r.ok) {
          expect(expected['valid']).toBe(false)
          return
        }
      }
      const conflict = detectIdMappingResult(messages)
      if (!conflict.ok) {
        expect(expected['valid']).toBe(false)
        const errExp = expected['error'] as Record<string, unknown> | undefined
        if (errExp !== undefined) {
          expect(errExp['code']).toBe(conflict.reason)
        }
        return
      }
      expect(expected['valid']).toBe(true)

      // finalState: assert post-merge consumer state per natural key
      // (covers go-wallet-toolbox#853: stale chunks must not regress mutable fields)
      const finalState = expected['finalState'] as Record<string, unknown> | undefined
      if (finalState !== undefined) {
        const replayed = replayChunks(messages)
        for (const [entity, expectedRows] of Object.entries(finalState)) {
          if (!Array.isArray(expectedRows)) continue
          const stateMap = replayed[entity] ?? new Map<string, Record<string, unknown>>()
          for (const expRow of expectedRows as Array<Record<string, unknown>>) {
            // Locate the row in replayed state by transactionId / outputId / txid
            const expRowKey = entity === 'transactions'
              ? `tx::${String(expRow['transactionId'])}`
              : entity === 'outputs'
                ? `out::${String(expRow['outputId'])}`
                : `ptx::${String(expRow['txid'])}`
            const actual = stateMap.get(expRowKey)
            expect(actual).toBeDefined()
            if (actual === undefined) continue
            // Assert each expected field matches
            for (const [field, value] of Object.entries(expRow)) {
              expect(actual[field]).toBe(value)
            }
          }
        }
      }
      return
    }

    if (input['request'] !== undefined && input['response'] !== undefined) {
      const request = input['request'] as Record<string, unknown>
      const response = input['response'] as Record<string, unknown>
      const sc = (response['syncChunk'] ?? {}) as Record<string, unknown>
      const r = isValidBRC40SyncChunk(sc)
      if (!r.ok) {
        expect(expected['valid']).toBe(false)
        return
      }
      // `since` inclusive lower bound: response must include at least one row
      // whose updated_at >= request.since
      const sinceStr = request['since']
      if (typeof sinceStr === 'string') {
        const sinceMs = Date.parse(sinceStr)
        let foundBoundary = false
        for (const key of BRC40_ENTITY_KEYS) {
          if (key === 'user') continue
          const arr = sc[key]
          if (!Array.isArray(arr)) continue
          for (const row of arr) {
            const r2 = row as Record<string, unknown>
            const u = typeof r2['updated_at'] === 'string' ? Date.parse(r2['updated_at'] as string) : NaN
            if (!Number.isNaN(u) && u >= sinceMs) {
              foundBoundary = true
              break
            }
          }
          if (foundBoundary) break
        }
        expect(foundBoundary).toBe(true)
      }
      expect(expected['valid']).toBe(true)
      return
    }

    throw new Error('brc40/flow vector: must have either messages[] or request+response')
  }

  throw new Error(`sync dispatcher: unknown channel '${channel}' in brc40-user-state`)
}

// ── Main dispatch entry point ──────────────────────────────────────────────────

export function dispatch (
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  if (category === 'brc40-user-state') {
    dispatchBRC40(input, expected)
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
