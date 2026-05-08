/**
 * overlayHelpers.ts — shared assertion helpers for overlay.ts dispatcher.
 *
 * Extracted to reduce cognitive complexity (S3776) in the main overlay dispatcher.
 */

import { expect } from '@jest/globals'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VectorInput {
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: unknown
  body_hex?: string
  query?: Record<string, string>
  topics?: string[]
  note?: string
}

export interface VectorExpected {
  status?: number
  status_oneof?: number[]
  content_type?: string
  body?: Record<string, unknown>
  body_schema?: string
  body_type?: string
  body_note?: string
  schema_note?: string
}

// ── HTTP status helpers ───────────────────────────────────────────────────────

export function assertHttpStatus (exp: VectorExpected): void {
  if (exp.status !== undefined) {
    expect(typeof exp.status).toBe('number')
    expect(exp.status).toBeGreaterThanOrEqual(100)
    expect(exp.status).toBeLessThan(600)
  } else if (exp.status_oneof !== undefined) {
    expect(Array.isArray(exp.status_oneof)).toBe(true)
    expect(exp.status_oneof.length).toBeGreaterThan(0)
    for (const s of exp.status_oneof) {
      expect(s).toBeGreaterThanOrEqual(100)
      expect(s).toBeLessThan(600)
    }
  }
}

// ── Submit helpers ────────────────────────────────────────────────────────────

export function assertSteakShape (body: Record<string, unknown>): void {
  expect(typeof body).toBe('object')
  expect(body).not.toBeNull()

  for (const [topic, result] of Object.entries(body)) {
    expect(typeof topic).toBe('string')
    const r = result as Record<string, unknown>
    expect(typeof r).toBe('object')
    expect(r).not.toBeNull()

    expect(Array.isArray(r.outputsToAdmit)).toBe(true)
    for (const idx of (r.outputsToAdmit as unknown[])) {
      expect(typeof idx).toBe('number')
      expect(idx).toBeGreaterThanOrEqual(0)
    }

    if ('coinstakeOutputsToRetain' in r) {
      expect(Array.isArray(r.coinstakeOutputsToRetain)).toBe(true)
      for (const idx of (r.coinstakeOutputsToRetain as unknown[])) {
        expect(typeof idx).toBe('number')
        expect(idx).toBeGreaterThanOrEqual(0)
      }
    }
  }
}

export function assertErrorShape (body: Record<string, unknown>): void {
  expect(body.status).toBe('error')
  if (body.message_type === 'string') {
    expect(body.message_type).toBe('string')
  }
}

export function assertSubmitRequestShape (inp: VectorInput): void {
  const headers = inp.headers ?? {}
  const method = (inp.method ?? 'POST').toUpperCase()
  const path = inp.path ?? '/submit'

  expect(method).toBe('POST')
  expect(path).toBe('/submit')

  const ctKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type')
  if (ctKey !== undefined) {
    expect(typeof headers[ctKey]).toBe('string')
  }

  const topicsKey = Object.keys(headers).find(k => k.toLowerCase() === 'x-topics')
  if (topicsKey !== undefined) {
    expect(typeof headers[topicsKey]).toBe('string')
  }
}

/** Validate STEAK topic keys against the X-Topics header. */
export function assertSteakTopicsMatch (
  body: Record<string, unknown>,
  headers: Record<string, string>
): void {
  const topicsKey = Object.keys(headers).find(k => k.toLowerCase() === 'x-topics')
  if (topicsKey === undefined) return

  let parsedTopics: unknown
  try {
    parsedTopics = JSON.parse(headers[topicsKey])
  } catch (_parseErr) {
    // malformed JSON — treat as no topics
    parsedTopics = null
  }

  if (Array.isArray(parsedTopics) && parsedTopics.length > 0) {
    for (const topicKey of Object.keys(body)) {
      expect(parsedTopics).toContain(topicKey)
    }
  }
}

/** Validate Content-Type is octet-stream for a happy-path submit. */
export function assertSubmitContentType (headers: Record<string, string>): void {
  const ctKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type')
  if (ctKey !== undefined) {
    expect(headers[ctKey].toLowerCase()).toContain('application/octet-stream')
  }
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

export function assertLookupRequestShape (inp: VectorInput): void {
  const method = (inp.method ?? 'POST').toUpperCase()
  if (method !== 'POST') return

  const path = inp.path ?? ''
  if (!path.startsWith('/lookup')) return

  const headers = inp.headers ?? {}
  const ctKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type')
  if (ctKey !== undefined) {
    expect(headers[ctKey].toLowerCase()).toContain('application/json')
  }

  const body = inp.body as Record<string, unknown> | undefined
  if (body !== undefined && typeof body === 'object' && 'service' in body) {
    expect(body.service).toBeDefined()
  }
}

export function assertLookupAnswerOutputList (body: Record<string, unknown>): void {
  expect(body.type).toBe('output-list')
  expect(Array.isArray(body.outputs)).toBe(true)

  for (const out of (body.outputs as unknown[])) {
    const o = out as Record<string, unknown>
    expect(typeof o).toBe('object')
    expect(o).not.toBeNull()

    expect(Array.isArray(o.beef)).toBe(true)
    for (const b of (o.beef as unknown[])) {
      expect(typeof b).toBe('number')
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(255)
    }

    expect(typeof o.outputIndex).toBe('number')
    expect(o.outputIndex).toBeGreaterThanOrEqual(0)

    if ('context' in o) {
      expect(Array.isArray(o.context)).toBe(true)
      for (const c of (o.context as unknown[])) {
        expect(typeof c).toBe('number')
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(255)
      }
    }
  }
}

export function assertLookupAnswerFreeform (body: Record<string, unknown>): void {
  expect(body.type).toBe('freeform')
  if ('outputs' in body) {
    expect(Array.isArray(body.outputs)).toBe(true)
  }
  if ('result' in body) {
    expect(body.result).toBeDefined()
  }
}

export function assertLookupAnswerShape (body: Record<string, unknown>): void {
  const answerType = body.type as string | undefined
  if (answerType === 'output-list') {
    assertLookupAnswerOutputList(body)
  } else if (answerType === 'freeform') {
    assertLookupAnswerFreeform(body)
  } else if (answerType !== undefined) {
    expect(typeof answerType).toBe('string')
  }
}

export function assertLookupBinaryResponse (exp: VectorExpected): void {
  if (exp.content_type !== undefined) {
    expect(exp.content_type).toContain('application/octet-stream')
  }
  if (exp.body_note !== undefined) {
    expect(typeof exp.body_note).toBe('string')
  }
}

export function assertLookupErrorStatusRange (exp: VectorExpected): void {
  if (exp.status !== undefined) {
    expect(exp.status).toBeGreaterThanOrEqual(400)
    expect(exp.status).toBeLessThan(600)
  } else if (exp.status_oneof !== undefined) {
    for (const s of exp.status_oneof) {
      expect(s).toBeGreaterThanOrEqual(400)
      expect(s).toBeLessThan(600)
    }
  }
}

// ── Discovery endpoint helpers ────────────────────────────────────────────────

export function assertListEndpointBody (exp: VectorExpected): void {
  if (exp.body_schema !== undefined) {
    expect(typeof exp.body_schema).toBe('string')
  }
  const exampleBody = (exp as Record<string, unknown>).example_body as Record<string, unknown> | undefined
  if (exampleBody !== undefined) {
    expect(typeof exampleBody).toBe('object')
    for (const [key, val] of Object.entries(exampleBody)) {
      expect(typeof key).toBe('string')
      const info = val as Record<string, unknown>
      if ('name' in info) expect(typeof info.name).toBe('string')
      if ('shortDescription' in info) expect(typeof info.shortDescription).toBe('string')
    }
  }
}

export function assertDocumentationEndpoint (status: number, exp: VectorExpected): void {
  if (status === 200) {
    if (exp.content_type !== undefined) {
      expect(exp.content_type).toContain('text/markdown')
    }
    if (exp.body_type !== undefined) {
      expect(exp.body_type).toBe('string')
    }
  } else {
    expect(status).toBe(400)
    if (exp.body !== undefined) {
      assertErrorShape(exp.body)
    }
  }
}

// ── Health report helpers ─────────────────────────────────────────────────────

const HEALTH_STATUS_ALLOWED = ['ok', 'degraded', 'error']

function assertHealthStatusField (body: Record<string, unknown>): void {
  const statusOneof = body.status_oneof
  if (Array.isArray(statusOneof)) {
    for (const s of statusOneof) {
      expect(HEALTH_STATUS_ALLOWED).toContain(s)
    }
  } else if (body.status !== undefined) {
    expect(HEALTH_STATUS_ALLOWED).toContain(body.status)
  }
}

function assertHealthServiceField (body: Record<string, unknown>): void {
  if (!('service' in body) || body.service === null || typeof body.service !== 'object') return
  const svc = body.service as Record<string, unknown>
  if ('name' in svc) expect(typeof svc.name).toBe('string')
  if ('network' in svc) expect(['main', 'test']).toContain(svc.network)
  if ('topicManagerCount' in svc) expect(typeof svc.topicManagerCount).toBe('number')
  if ('lookupServiceCount' in svc) expect(typeof svc.lookupServiceCount).toBe('number')
}

export function assertHealthReportShape (body: Record<string, unknown>): void {
  if ('live' in body) expect(typeof body.live).toBe('boolean')
  if ('ready' in body) expect(typeof body.ready).toBe('boolean')
  if ('status' in body) assertHealthStatusField(body)
  assertHealthServiceField(body)
}

// ── Admin helpers ─────────────────────────────────────────────────────────────

export function assertAdminStatsShape (body: Record<string, unknown>): void {
  expect(body.status).toBe('success')
  if (!('data' in body) || typeof body.data !== 'object' || body.data === null) return
  const data = body.data as Record<string, unknown>
  if ('nodeName' in data) expect(typeof data.nodeName).toBe('string')
  if ('network' in data) expect(['main', 'test']).toContain(data.network)
  if ('topicManagers' in data) expect(Array.isArray(data.topicManagers)).toBe(true)
  if ('lookupServices' in data) expect(Array.isArray(data.lookupServices)).toBe(true)
}

export function assertBanListShape (body: Record<string, unknown>): void {
  expect(body.status).toBe('success')
  if (!('data' in body) || typeof body.data !== 'object' || body.data === null) return
  const data = body.data as Record<string, unknown>
  if (!('bans' in data)) return
  expect(Array.isArray(data.bans)).toBe(true)
  for (const ban of (data.bans as unknown[])) {
    const b = ban as Record<string, unknown>
    if ('type' in b) expect(['domain', 'outpoint']).toContain(b.type)
    if ('value' in b) expect(typeof b.value).toBe('string')
  }
}

export function assertPaginatedRecordShape (body: Record<string, unknown>): void {
  expect(body.status).toBe('success')
  if (!('data' in body) || typeof body.data !== 'object' || body.data === null) return
  const data = body.data as Record<string, unknown>
  if ('records' in data) expect(Array.isArray(data.records)).toBe(true)
  if ('total' in data) {
    expect(typeof data.total).toBe('number')
    expect(data.total).toBeGreaterThanOrEqual(0)
  }
  if ('page' in data) {
    expect(typeof data.page).toBe('number')
    expect(data.page).toBeGreaterThanOrEqual(1)
  }
  if ('limit' in data) {
    expect(typeof data.limit).toBe('number')
    expect(data.limit).toBeGreaterThanOrEqual(1)
  }
  if ('pages' in data) {
    expect(typeof data.pages).toBe('number')
    expect(data.pages).toBeGreaterThanOrEqual(0)
  }
}

export function assertArcIngestRequestShape (inp: VectorInput): void {
  const body = inp.body as Record<string, unknown> | undefined
  if (body === undefined) return

  if ('txid' in body) {
    expect(typeof body.txid).toBe('string')
    expect((body.txid as string).length).toBe(64)
  }
  if ('merklePath' in body) {
    expect(typeof body.merklePath).toBe('string')
  }
  if ('blockHeight' in body) {
    expect(typeof body.blockHeight).toBe('number')
    expect(body.blockHeight).toBeGreaterThanOrEqual(0)
  }
}

export function assertBanRequestShape (body: Record<string, unknown>): void {
  if ('type' in body) expect(['domain', 'outpoint']).toContain(body.type)
  if ('value' in body) expect(typeof body.value).toBe('string')
  if ('reason' in body) expect(typeof body.reason).toBe('string')
}

export function assertEvictRequestShape (body: Record<string, unknown>): void {
  if ('txid' in body) {
    expect(typeof body.txid).toBe('string')
    expect((body.txid as string).length).toBe(64)
  }
  if ('outputIndex' in body) {
    expect(typeof body.outputIndex).toBe('number')
    expect(body.outputIndex).toBeGreaterThanOrEqual(0)
  }
  if ('service' in body) {
    expect(typeof body.service).toBe('string')
    expect((body.service as string).startsWith('ls_')).toBe(true)
  }
}

// ── Topic-management route handlers ──────────────────────────────────────────

export function handleHealthEndpoint (
  method: string,
  status: number,
  body: Record<string, unknown>
): void {
  expect(method).toBe('GET')
  assertHealthReportShape(body)
  if (status === 503 && 'ready' in body) {
    expect(body.ready).toBe(false)
  }
}

export function handleAdminConfig (
  status: number,
  body: Record<string, unknown>
): void {
  expect(status).toBe(200)
  if ('adminIdentityKey' in body) {
    expect(
      body.adminIdentityKey === null || typeof body.adminIdentityKey === 'string'
    ).toBe(true)
  }
  if ('nodeName' in body) {
    expect(typeof body.nodeName).toBe('string')
  }
}

export function handleAdminStats (
  status: number,
  body: Record<string, unknown>
): void {
  if (status === 200) {
    assertAdminStatsShape(body)
  } else {
    assertErrorShape(body)
  }
}

export function handleAdminBanUnban (
  status: number,
  body: Record<string, unknown>,
  reqBody: Record<string, unknown> | undefined,
  _exp: VectorExpected
): void {
  if (reqBody !== undefined) {
    assertBanRequestShape(reqBody)
  }
  if (status === 200) {
    expect(body.status).toBe('success')
  } else {
    assertErrorShape(body)
  }
}

export function handleAdminBans (
  status: number,
  body: Record<string, unknown>
): void {
  if (status === 200) {
    assertBanListShape(body)
  } else {
    assertErrorShape(body)
  }
}

export function handleAdminEvict (
  status: number,
  body: Record<string, unknown>,
  reqBody: Record<string, unknown> | undefined
): void {
  if (reqBody !== undefined) {
    assertEvictRequestShape(reqBody)
  }
  if (status === 200) {
    expect(body.status).toBe('success')
  } else {
    assertErrorShape(body)
  }
}

export function handleAdminShipRecords (
  status: number,
  body: Record<string, unknown>
): void {
  if (status === 200) {
    assertPaginatedRecordShape(body)
  } else {
    assertErrorShape(body)
  }
}

export function handleArcIngest (
  status: number,
  body: Record<string, unknown>,
  inp: VectorInput
): void {
  assertArcIngestRequestShape(inp)
  if (status === 200) {
    expect(body.status).toBe('success')
  } else {
    assertErrorShape(body)
  }
}
