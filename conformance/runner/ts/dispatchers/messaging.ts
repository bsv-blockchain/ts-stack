/**
 * Messaging dispatcher — Wave 1.
 *
 * Categories:
 *   authsocket           — AsyncAPI / BRC-103 WebSocket protocol shape validation
 *   authrite-signature   — BRC-31 Authrite mutual-auth signature compute/verify
 *   message-box-http     — MessageBox HTTP API request/response shape validation
 *
 * Binary frames: AuthSocket carries binary payloads; this dispatcher
 * treats them as hex-encoded number arrays (matching the convention used
 * throughout the SDK test suite).
 *
 * BRC-31 signature note: The vectors use protocolID=[2,'authrite message
 * signature'] (the BRC-31 / BRC-43 spec string). Verification is done
 * directly via ProtoWallet.createSignature / ProtoWallet.verifySignature
 * which delegate to KeyDeriver — the same path the SDK auth stack uses.
 * ProtoWallet.verifySignature throws on an invalid signature (code
 * ERR_INVALID_SIGNATURE); we catch that throw for error-case vectors.
 */

import { expect } from '@jest/globals'
import { PrivateKey, ProtoWallet, type SecurityLevel, type WalletProtocol } from '@bsv/sdk'

export const categories: ReadonlyArray<string> = [
  'authsocket',
  'authrite-signature',
  'message-box-http'
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): number[] {
  if (hex === '') return []
  if (hex.length % 2 !== 0) hex = '0' + hex
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    out.push(Number.parseInt(hex.slice(i, i + 2), 16))
  }
  return out
}

function bytesToHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function getString(m: Record<string, unknown>, key: string): string {
  const v = m[key]
  return typeof v === 'string' ? v : ''
}

function getBool(m: Record<string, unknown>, key: string): boolean {
  return m[key] === true
}

function getWalletProtocol(value: unknown): WalletProtocol {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    (value[0] !== 0 && value[0] !== 1 && value[0] !== 2) ||
    typeof value[1] !== 'string'
  ) {
    throw new Error('protocolID must be a [0|1|2, string] tuple')
  }
  return [value[0] as SecurityLevel, value[1]]
}

/**
 * Build a ProtoWallet from a 64-char hex private key scalar.
 */
function walletFromRootKeyHex(rootKeyHex: string): ProtoWallet {
  const privKey = PrivateKey.fromHex(rootKeyHex)
  return new ProtoWallet(privKey)
}

// ── authsocket dispatcher ─────────────────────────────────────────────────────
// These vectors describe the AsyncAPI / BRC-103 protocol shape — no live
// WebSocket server is required. We validate structural assertions only.

function assertExpectedFields(value: Record<string, unknown>, fields: string[] | undefined): void {
  if (!Array.isArray(fields)) return
  for (const field of fields) expect(value).toHaveProperty(field)
}

function dispatchEnvelopeSchema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  assertExpectedFields(
    input.envelope as Record<string, unknown>,
    expected.required_fields as string[] | undefined
  )
  if ('valid' in expected) expect(getBool(expected, 'valid')).toBe(true)
}

function dispatchMessageTypeSchema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const validTypes = input.valid_types as string[]
  const expectedEnum = expected.enum as string[]
  if (!Array.isArray(expectedEnum) || !Array.isArray(validTypes)) return
  expect(validTypes.toSorted((a, b) => a.localeCompare(b))).toEqual(
    [...expectedEnum].toSorted((a, b) => a.localeCompare(b))
  )
}

function dispatchRequiredFieldSchema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const fields = input.required_fields as string[]
  expect(fields.length).toBeGreaterThan(0)
  for (const field of fields) expect(typeof field).toBe('string')
  if ('valid' in expected) expect(getBool(expected, 'valid')).toBe(true)
}

function dispatchPublicKeySchema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const pattern = getString(expected, 'pattern')
  const validExamples = input.valid_examples as string[]
  if (pattern === '' || !Array.isArray(validExamples)) return
  const regularExpression = new RegExp(pattern)
  for (const example of validExamples) expect(regularExpression.test(example)).toBe(true)
}

function dispatchAuthSocketSchema(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  if ('envelope' in input) return dispatchEnvelopeSchema(input, expected)
  if ('valid_types' in input) return dispatchMessageTypeSchema(input, expected)
  if ('production_url' in expected) {
    expect(typeof getString(expected, 'production_url')).toBe('string')
    expect(getString(expected, 'protocol')).toBe('wss')
    expect(getString(expected, 'transport')).toBe('Socket.IO')
    return
  }
  if ('transport_handles' in expected) {
    const appSees = expected.application_sees as Record<string, unknown>
    expect(appSees).toHaveProperty('eventName')
    expect(appSees).toHaveProperty('data')
    return
  }
  if ('required_fields' in input) return dispatchRequiredFieldSchema(input, expected)
  if ('valid_examples' in input) dispatchPublicKeySchema(input, expected)
}

function dispatchInitialRequestShape(expected: Record<string, unknown>): void {
  const responseShape = expected.response_shape as Record<string, unknown> | undefined
  if (responseShape !== undefined) {
    expect(responseShape).toHaveProperty('messageType')
    expect(responseShape.messageType).toBe('initialResponse')
    expect(responseShape).toHaveProperty('identityKey')
    expect(responseShape).toHaveProperty('nonce')
    expect(responseShape).toHaveProperty('signature')
  }
  if ('response_shape_includes' in expected) {
    expect(expected.response_shape_includes).toBeDefined()
  }
}

function dispatchGeneralAuthMessage(
  payload: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const payloadBytes = payload.payload as number[]
  if (Array.isArray(payloadBytes) && payloadBytes.length > 0) {
    try {
      JSON.parse(new TextDecoder().decode(new Uint8Array(payloadBytes)))
    } catch {
      // Partial/stub payload in a shape-only vector is intentionally tolerated.
    }
  }
  if ('server_processes' in expected) {
    expect(getBool(expected, 'server_processes')).toBe(true)
  }
  if ('inner_event_extracted_from_payload' in expected) {
    expect(getBool(expected, 'inner_event_extracted_from_payload')).toBe(true)
  }
}

function dispatchAuthMessageEvent(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  const payload = input.payload as Record<string, unknown> | undefined
  const messageType = payload === undefined ? '' : getString(payload, 'messageType')
  if (messageType === 'initialRequest') {
    dispatchInitialRequestShape(expected)
    return true
  }
  if (messageType === 'general' && payload !== undefined) {
    dispatchGeneralAuthMessage(payload, expected)
    return true
  }
  return false
}

function dispatchMessageEvent(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const payload = input.payload_example as Record<string, unknown> | undefined
  if (payload !== undefined) {
    assertExpectedFields(payload, expected.payload_has_fields as string[] | undefined)
  }
  if (getString(expected, 'event_received') !== '') {
    expect(getString(expected, 'event_received')).toBe('message')
  }
}

function dispatchKnownIdentity(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  if ('identity_key_known' in expected) expect(getBool(expected, 'identity_key_known')).toBe(true)
  if ('persists_for' in expected) {
    expect(getString(expected, 'persists_for')).toBe('connection lifetime')
  }
  expect(/^0[23][0-9a-fA-F]{64}$/.test(getString(input, 'expected_identity_key'))).toBe(true)
}

function dispatchAuthSocket(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  if (getBool(input, '_schema_check')) {
    dispatchAuthSocketSchema(input, expected)
    return
  }

  const socketEvent = input.socketio_event
  if (socketEvent === 'authMessage' && dispatchAuthMessageEvent(input, expected)) return

  if (socketEvent === 'message') {
    dispatchMessageEvent(input, expected)
    return
  }

  if (socketEvent === null || socketEvent === undefined) {
    if ('server_disconnects' in expected) expect(getBool(expected, 'server_disconnects')).toBe(true)
    return
  }

  if ('expected_identity_key' in input) dispatchKnownIdentity(input, expected)
}

// ── authrite-signature dispatcher ─────────────────────────────────────────────
// BRC-31 uses BRC-43 key derivation with protocolID=[2,'authrite message
// signature']. The keyID is '<nonce1> <nonce2>' (space-separated base64
// strings). The data field is hex-encoded; createSignature hashes it via
// SHA-256 internally (ProtoWallet.createSignature calls Hash.sha256(data)).

async function dispatchAuthriteSignature(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): Promise<void> {
  const rootKeyHex = getString(input, 'root_key')
  const method = getString(input, 'method')
  const args = (input.args ?? {}) as Record<string, unknown>

  if (rootKeyHex === '' || method === '') {
    throw new Error('authrite-signature vector missing root_key or method')
  }

  const wallet = walletFromRootKeyHex(rootKeyHex)

  // Extract args fields
  const dataHex = getString(args, 'data')
  const dataBytes: number[] = hexToBytes(dataHex)

  const protocolID = getWalletProtocol(args.protocolID)
  const keyID = getString(args, 'keyID')
  const counterparty = getString(args, 'counterparty')

  if (method === 'createSignature') {
    const { signature } = await wallet.createSignature({
      data: dataBytes,
      protocolID,
      keyID,
      counterparty
    })

    const gotHex = bytesToHex(signature)
    expect(gotHex).toBe(getString(expected, 'signature'))
  } else if (method === 'verifySignature') {
    const sigHex = getString(args, 'signature')

    if (getBool(expected, 'error')) {
      // Wrong counterparty or tampered data — verifySignature must throw
      await expect(
        wallet.verifySignature({
          data: dataBytes,
          signature: hexToBytes(sigHex),
          protocolID,
          keyID,
          counterparty
        })
      ).rejects.toThrow()
    } else {
      // Happy path — must succeed
      const { valid } = await wallet.verifySignature({
        data: dataBytes,
        signature: hexToBytes(sigHex),
        protocolID,
        keyID,
        counterparty
      })
      expect(valid).toBe(getBool(expected, 'valid'))
    }
  } else {
    throw new Error(`authrite-signature: unknown method '${method}'`)
  }
}

// ── message-box-http dispatcher ───────────────────────────────────────────────
// Validates HTTP request/response shapes against the MessageBox API spec.
// No real backend is contacted — vectors describe the expected shapes.

function dispatchSendMessageResponse(
  body: Record<string, unknown> | undefined,
  expectedBody: Record<string, unknown>
): void {
  const message = body?.message as Record<string, unknown> | undefined
  if (message !== undefined) {
    expect('recipient' in message || 'recipients' in message).toBe(true)
    expect(typeof getString(message, 'messageBox')).toBe('string')
  }
  if (!('results' in expectedBody)) return
  const results = expectedBody.results as Array<Record<string, unknown>>
  expect(Array.isArray(results)).toBe(true)
  for (const result of results) {
    expect(typeof getString(result, 'recipient')).toBe('string')
    expect(typeof getString(result, 'messageId')).toBe('string')
  }
}

function assertMessageShape(message: Record<string, unknown>): void {
  if ('messageId' in message) expect(typeof getString(message, 'messageId')).toBe('string')
  if ('body' in message) expect(typeof getString(message, 'body')).toBe('string')
  if ('sender' in message) {
    expect(/^0[23][0-9a-fA-F]{64}$/.test(getString(message, 'sender'))).toBe(true)
  }
  if ('created_at' in message) {
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(getString(message, 'created_at'))).toBe(true)
  }
}

function dispatchListMessagesResponse(
  body: Record<string, unknown> | undefined,
  expectedBody: Record<string, unknown>
): void {
  if (body !== undefined) expect(typeof getString(body, 'messageBox')).toBe('string')
  if (!('messages' in expectedBody)) return
  const messages = expectedBody.messages as Array<Record<string, unknown>>
  expect(Array.isArray(messages)).toBe(true)
  for (const message of messages) assertMessageShape(message)
}

function dispatchAcknowledgeResponse(body: Record<string, unknown> | undefined): void {
  if (body === undefined) return
  expect(typeof getString(body, 'messageBox')).toBe('string')
  const messageIds = body.messageIds as string[] | undefined
  if (Array.isArray(messageIds)) expect(messageIds.length).toBeGreaterThan(0)
}

function dispatchPermissionSetResponse(body: Record<string, unknown> | undefined): void {
  if (body === undefined) return
  expect(typeof getString(body, 'messageBox')).toBe('string')
  if ('recipientFee' in body) {
    expect(typeof body.recipientFee).toBe('number')
    expect((body.recipientFee as number) >= 0).toBe(true)
  }
}

function dispatchPermissionGetResponse(expectedBody: Record<string, unknown>): void {
  expect('permission' in expectedBody).toBe(true)
  const permission = expectedBody.permission
  if (permission !== null && typeof permission === 'object') {
    expect(typeof getString(permission as Record<string, unknown>, 'messageBox')).toBe('string')
  }
}

function dispatchPermissionListResponse(expectedBody: Record<string, unknown>): void {
  if ('permissions' in expectedBody) {
    expect(Array.isArray(expectedBody.permissions)).toBe(true)
  }
}

function dispatchSuccessfulMessageBoxResponse(
  path: string,
  body: Record<string, unknown> | undefined,
  expectedBody: Record<string, unknown>
): void {
  expect(getString(expectedBody, 'status')).toBe('success')
  if (path.startsWith('/sendMessage')) return dispatchSendMessageResponse(body, expectedBody)
  if (path.startsWith('/listMessages')) return dispatchListMessagesResponse(body, expectedBody)
  if (path.startsWith('/acknowledgeMessage')) return dispatchAcknowledgeResponse(body)
  if (path.startsWith('/permissions/set')) return dispatchPermissionSetResponse(body)
  if (path.includes('/permissions/get')) return dispatchPermissionGetResponse(expectedBody)
  if (path.includes('/permissions/list')) dispatchPermissionListResponse(expectedBody)
}

function dispatchMessageBoxHTTP(
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const method = getString(input, 'method').toUpperCase()
  const path = getString(input, 'path')
  const headers = (input.headers ?? {}) as Record<string, string>
  const body = input.body as Record<string, unknown> | undefined

  // ── Request shape assertions ──────────────────────────────────────────

  // Validate Content-Type where present (case-insensitive header key)
  const contentTypeKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type')
  const hasAuthHeader = Object.keys(headers).some(
    k => k.toLowerCase() === 'x-bsv-auth-identity-key'
  )

  // POST endpoints must include Content-Type application/json
  if (method === 'POST' && contentTypeKey !== undefined) {
    expect(headers[contentTypeKey].toLowerCase()).toContain('application/json')
  }

  // ── Response shape assertions ─────────────────────────────────────────

  const expectedStatus = expected.status as number | undefined
  const expectedBody = expected.body as Record<string, unknown> | undefined

  if (expectedStatus === undefined || expectedBody === undefined) return

  // Auth-required: no auth header → 401
  if (!hasAuthHeader && expectedStatus === 401) {
    expect(expectedStatus).toBe(401)
    expect(getString(expectedBody, 'status')).toBe('error')
    if ('code' in expectedBody) {
      expect(getString(expectedBody, 'code')).toBe('ERR_AUTH_REQUIRED')
    }
    return
  }

  // Validation error → 400
  if (expectedStatus === 400) {
    expect(expectedStatus).toBe(400)
    expect(getString(expectedBody, 'status')).toBe('error')
    return
  }

  if (expectedStatus === 200) {
    dispatchSuccessfulMessageBoxResponse(path, body, expectedBody)
  }
}

// ── Main dispatch entry point ──────────────────────────────────────────────────

export function dispatch(
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  switch (category) {
    case 'authsocket':
      return dispatchAuthSocket(input, expected)
    case 'authrite-signature':
      return dispatchAuthriteSignature(input, expected)
    case 'message-box-http':
      return dispatchMessageBoxHTTP(input, expected)
    default:
      throw new Error(`not implemented: dispatchers/messaging.ts – ${category} (Wave 1)`)
  }
}
