import type {
  IdentityVerificationAcknowledgment,
  IdentityVerificationRequest,
  IdentityVerificationResponse,
  Invoice,
  PeerMessage,
  Receipt,
  RemittanceEnvelope,
  RemittanceKind,
  Settlement,
  Termination
} from './types.js'
import { isUnsafeRecordKey } from '../primitives/SafeRecord.js'

const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024
const MAX_GRAPH_NODES = 250_000
const MAX_GRAPH_DEPTH = 128
const MAX_GRAPH_DATA_UNITS = 16 * 1024 * 1024
const MAX_IDENTIFIER_LENGTH = 4096
const MAX_TEXT_LENGTH = 64 * 1024
const MAX_LINE_ITEMS = 10_000
const MAX_OPTIONS = 1_000
const kinds = new Set<RemittanceKind>([
  'invoice',
  'identityVerificationRequest',
  'identityVerificationResponse',
  'identityVerificationAcknowledgment',
  'settlement',
  'receipt',
  'termination'
])

type DataRecord = Record<string, unknown>

export function record(value: unknown, label: string): DataRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object`)
  }
  const prototype = Object.getPrototypeOf(value)
  const constructorDescriptor =
    prototype == null ? undefined : Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const isCrossRealmPlainObject =
    prototype != null &&
    Object.getPrototypeOf(prototype) === null &&
    constructorDescriptor != null &&
    'value' in constructorDescriptor &&
    typeof constructorDescriptor.value === 'function' &&
    constructorDescriptor.value.name === 'Object'
  if (prototype !== Object.prototype && prototype !== null && !isCrossRealmPlainObject) {
    throw new TypeError(`${label} must be a plain data object`)
  }
  return value as DataRecord
}

function dataProperty(source: DataRecord, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor == null || !('value' in descriptor)) {
    throw new TypeError(`${label} must be an own data property`)
  }
  return descriptor.value
}

function optionalDataProperty(source: DataRecord, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor == null) return undefined
  if (!('value' in descriptor)) throw new TypeError(`${label} must be an own data property`)
  return descriptor.value
}

export function string(value: unknown, label: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be a bounded non-empty string`)
  }
  return value
}

export function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe-integer Unix timestamp`)
  }
  return value
}

export function denseArray(value: unknown, label: string, maxLength = MAX_LINE_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new TypeError(`${label} must be a bounded dense array`)
  }
  const copy: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor == null || !('value' in descriptor)) {
      throw new TypeError(`${label} must be a bounded dense array`)
    }
    copy.push(descriptor.value)
  }
  return copy
}

function recordEntries(
  value: unknown,
  label: string,
  maxLength = MAX_OPTIONS
): Array<[string, unknown]> {
  const source = record(value, label)
  const keys = Reflect.ownKeys(source)
  if (keys.length > maxLength) throw new TypeError(`${label} contains too many fields`)
  return keys.map(key => {
    if (typeof key !== 'string' || isUnsafeRecordKey(key)) {
      throw new TypeError(`${label} contains an unsafe field`)
    }
    return [key, dataProperty(source, key, `${label}.${key}`)]
  })
}

function optionalString(
  source: DataRecord,
  key: string,
  label: string,
  maxLength = MAX_TEXT_LENGTH
): void {
  const value = optionalDataProperty(source, key, label)
  if (value !== undefined) string(value, label, maxLength)
}

export function decimal(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ||
    !/[1-9]/.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded positive canonical decimal string`)
  }
  return value
}

function validateAmount(value: unknown, label: string): void {
  const amount = record(value, label)
  decimal(dataProperty(amount, 'value', `${label} value`), `${label} value`)
  const unit = record(dataProperty(amount, 'unit', `${label} unit`), `${label} unit`)
  string(dataProperty(unit, 'namespace', `${label} unit namespace`), `${label} unit namespace`)
  string(dataProperty(unit, 'code', `${label} unit code`), `${label} unit code`)
  const decimals = optionalDataProperty(unit, 'decimals', `${label} unit decimals`)
  if (
    decimals !== undefined &&
    (typeof decimals !== 'number' ||
      !Number.isSafeInteger(decimals) ||
      decimals < 0 ||
      decimals > 255)
  ) {
    throw new TypeError(`${label} unit decimals must be a uint8`)
  }
}

function assertSafeDataGraph(root: unknown): void {
  const completed = new WeakSet<object>()
  const active = new WeakSet<object>()
  const pending: Array<{ value: unknown; depth: number; leaving?: boolean }> = [
    { value: root, depth: 0 }
  ]
  let values = 0
  let dataUnits = 0

  while (pending.length > 0) {
    const { value, depth, leaving } = pending.pop()!
    if (leaving === true) {
      active.delete(value as object)
      completed.add(value as object)
      continue
    }
    values++
    if (values > MAX_GRAPH_NODES || depth > MAX_GRAPH_DEPTH) {
      throw new TypeError('Remittance data exceeds the supported structural limits')
    }
    if (typeof value === 'string') {
      dataUnits += value.length
      if (dataUnits > MAX_GRAPH_DATA_UNITS) {
        throw new TypeError('Remittance data exceeds the supported aggregate data limit')
      }
      continue
    }
    if (value == null || typeof value !== 'object') continue
    if (active.has(value)) throw new TypeError('Remittance data must not contain cycles')
    if (completed.has(value)) continue

    const prototype = Object.getPrototypeOf(value)
    if (prototype === Uint8Array.prototype) {
      dataUnits += (value as Uint8Array).byteLength
      if (dataUnits > MAX_GRAPH_DATA_UNITS) {
        throw new TypeError('Remittance data exceeds the supported aggregate data limit')
      }
      completed.add(value)
      continue
    }

    active.add(value)

    const constructorDescriptor =
      prototype == null ? undefined : Object.getOwnPropertyDescriptor(prototype, 'constructor')
    const isCrossRealmPlainObject =
      prototype != null &&
      Object.getPrototypeOf(prototype) === null &&
      constructorDescriptor != null &&
      'value' in constructorDescriptor &&
      typeof constructorDescriptor.value === 'function' &&
      constructorDescriptor.value.name === 'Object'
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null &&
      !isCrossRealmPlainObject
    ) {
      throw new TypeError('Remittance data must contain only JSON data objects and arrays')
    }
    pending.push({ value, depth, leaving: true })
    let arrayEntries = 0
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        typeof key !== 'string' ||
        descriptor == null ||
        !('value' in descriptor) ||
        isUnsafeRecordKey(key)
      ) {
        throw new TypeError('Remittance data contains an unsafe property')
      }
      if (Array.isArray(value)) {
        if (key === 'length') continue
        if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError('Remittance data arrays must contain only dense indexed values')
        }
        arrayEntries++
      }
      pending.push({ value: descriptor.value, depth: depth + 1 })
    }
    if (Array.isArray(value) && arrayEntries !== value.length) {
      throw new TypeError('Remittance data arrays must contain only dense indexed values')
    }
  }
}

/** Safely copy persisted remittance data without invoking accessors or retaining external aliases. */
export function copyRemittanceData<T>(value: T): T {
  assertSafeDataGraph(value)
  return structuredClone(value)
}

function commonPayload(
  value: unknown,
  kind: Exclude<RemittanceKind, 'termination'>,
  threadId: string
): DataRecord {
  const payload = record(value, 'Remittance envelope payload')
  if (dataProperty(payload, 'kind', 'Remittance payload kind') !== kind) {
    throw new TypeError('Remittance payload kind does not match its envelope')
  }
  if (dataProperty(payload, 'threadId', 'Remittance payload threadId') !== threadId) {
    throw new TypeError('Remittance payload threadId does not match its envelope')
  }
  return payload
}

function validateInvoice(value: unknown, threadId: string): Invoice {
  const payload = commonPayload(value, 'invoice', threadId)
  string(dataProperty(payload, 'payee', 'Invoice payee'), 'Invoice payee')
  string(dataProperty(payload, 'payer', 'Invoice payer'), 'Invoice payer')
  string(dataProperty(payload, 'invoiceNumber', 'Invoice number'), 'Invoice number')
  timestamp(dataProperty(payload, 'createdAt', 'Invoice createdAt'), 'Invoice createdAt')
  const expiresAt = optionalDataProperty(payload, 'expiresAt', 'Invoice expiresAt')
  if (expiresAt !== undefined) timestamp(expiresAt, 'Invoice expiresAt')
  const lineItems = denseArray(
    dataProperty(payload, 'lineItems', 'Invoice lineItems'),
    'Invoice lineItems',
    MAX_LINE_ITEMS
  )
  for (let index = 0; index < lineItems.length; index++) {
    const item = record(lineItems[index], `Invoice line item ${index}`)
    optionalString(item, 'id', `Invoice line item ${index} id`, MAX_IDENTIFIER_LENGTH)
    string(
      dataProperty(item, 'description', `Invoice line item ${index} description`),
      `Invoice line item ${index} description`,
      MAX_TEXT_LENGTH
    )
    const quantity = optionalDataProperty(item, 'quantity', `Invoice line item ${index} quantity`)
    if (quantity !== undefined) decimal(quantity, `Invoice line item ${index} quantity`)
    const unitPrice = optionalDataProperty(
      item,
      'unitPrice',
      `Invoice line item ${index} unit price`
    )
    if (unitPrice !== undefined) validateAmount(unitPrice, `Invoice line item ${index} unit price`)
    const amount = optionalDataProperty(item, 'amount', `Invoice line item ${index} amount`)
    if (amount !== undefined) validateAmount(amount, `Invoice line item ${index} amount`)
    const metadata = optionalDataProperty(item, 'metadata', `Invoice line item ${index} metadata`)
    if (metadata !== undefined) recordEntries(metadata, `Invoice line item ${index} metadata`)
  }
  validateAmount(dataProperty(payload, 'total', 'Invoice total'), 'Invoice total')
  optionalString(payload, 'note', 'Invoice note')
  const arbitrary = optionalDataProperty(payload, 'arbitrary', 'Invoice arbitrary data')
  if (arbitrary !== undefined) recordEntries(arbitrary, 'Invoice arbitrary data')
  recordEntries(dataProperty(payload, 'options', 'Invoice options'), 'Invoice options').forEach(
    ([optionId]) => string(optionId, 'Invoice option id')
  )
  return payload as unknown as Invoice
}

function validateSettlement(value: unknown, threadId: string): Settlement {
  const payload = commonPayload(value, 'settlement', threadId)
  string(dataProperty(payload, 'moduleId', 'Settlement moduleId'), 'Settlement moduleId')
  string(dataProperty(payload, 'optionId', 'Settlement optionId'), 'Settlement optionId')
  string(dataProperty(payload, 'sender', 'Settlement sender'), 'Settlement sender')
  timestamp(dataProperty(payload, 'createdAt', 'Settlement createdAt'), 'Settlement createdAt')
  optionalString(payload, 'note', 'Settlement note')
  dataProperty(payload, 'artifact', 'Settlement artifact')
  return payload as unknown as Settlement
}

function validateReceipt(value: unknown, threadId: string): Receipt {
  const payload = commonPayload(value, 'receipt', threadId)
  string(dataProperty(payload, 'moduleId', 'Receipt moduleId'), 'Receipt moduleId')
  string(dataProperty(payload, 'optionId', 'Receipt optionId'), 'Receipt optionId')
  string(dataProperty(payload, 'payee', 'Receipt payee'), 'Receipt payee')
  string(dataProperty(payload, 'payer', 'Receipt payer'), 'Receipt payer')
  timestamp(dataProperty(payload, 'createdAt', 'Receipt createdAt'), 'Receipt createdAt')
  dataProperty(payload, 'receiptData', 'Receipt data')
  return payload as unknown as Receipt
}

function validateIdentityRequest(value: unknown, threadId: string): IdentityVerificationRequest {
  const payload = commonPayload(value, 'identityVerificationRequest', threadId)
  const request = record(
    dataProperty(payload, 'request', 'Identity verification request'),
    'Identity verification request'
  )
  for (const [type, fieldsValue] of recordEntries(
    dataProperty(request, 'types', 'Identity verification types'),
    'Identity verification types'
  )) {
    string(type, 'Identity verification certificate type')
    const fields = denseArray(fieldsValue, `Identity verification fields for ${type}`, MAX_OPTIONS)
    for (const field of fields) string(field, 'Identity verification field')
  }
  const certifiers = denseArray(
    dataProperty(request, 'certifiers', 'Identity verification certifiers'),
    'Identity verification certifiers',
    MAX_OPTIONS
  )
  for (const certifier of certifiers) string(certifier, 'Identity verification certifier')
  return payload as unknown as IdentityVerificationRequest
}

function validateIdentityResponse(value: unknown, threadId: string): IdentityVerificationResponse {
  const payload = commonPayload(value, 'identityVerificationResponse', threadId)
  const certificates = denseArray(
    dataProperty(payload, 'certificates', 'Identity verification certificates'),
    'Identity verification certificates',
    MAX_OPTIONS
  )
  for (let index = 0; index < certificates.length; index++) {
    const certificate = record(certificates[index], `Identity certificate ${index}`)
    string(
      dataProperty(certificate, 'type', `Identity certificate ${index} type`),
      'Certificate type'
    )
    string(
      dataProperty(certificate, 'certifier', `Identity certificate ${index} certifier`),
      'Certificate certifier'
    )
    string(
      dataProperty(certificate, 'subject', `Identity certificate ${index} subject`),
      'Certificate subject'
    )
    for (const [field, fieldValue] of recordEntries(
      dataProperty(certificate, 'fields', `Identity certificate ${index} fields`),
      `Identity certificate ${index} fields`
    )) {
      string(field, 'Certificate field name')
      string(fieldValue, 'Certificate field value', MAX_TEXT_LENGTH)
    }
    string(
      dataProperty(certificate, 'signature', `Identity certificate ${index} signature`),
      'Certificate signature',
      MAX_TEXT_LENGTH
    )
    string(
      dataProperty(certificate, 'serialNumber', `Identity certificate ${index} serial number`),
      'Certificate serial number'
    )
    string(
      dataProperty(
        certificate,
        'revocationOutpoint',
        `Identity certificate ${index} revocation outpoint`
      ),
      'Certificate revocation outpoint'
    )
    for (const [field, keyValue] of recordEntries(
      dataProperty(
        certificate,
        'keyringForVerifier',
        `Identity certificate ${index} verifier keyring`
      ),
      `Identity certificate ${index} verifier keyring`
    )) {
      string(field, 'Certificate keyring field name')
      string(keyValue, 'Certificate keyring value', MAX_TEXT_LENGTH)
    }
  }
  return payload as unknown as IdentityVerificationResponse
}

function validateIdentityAcknowledgment(
  value: unknown,
  threadId: string
): IdentityVerificationAcknowledgment {
  return commonPayload(
    value,
    'identityVerificationAcknowledgment',
    threadId
  ) as unknown as IdentityVerificationAcknowledgment
}

function validateTermination(value: unknown): Termination {
  const payload = record(value, 'Termination payload')
  string(dataProperty(payload, 'code', 'Termination code'), 'Termination code')
  string(
    dataProperty(payload, 'message', 'Termination message'),
    'Termination message',
    MAX_TEXT_LENGTH
  )
  return payload as unknown as Termination
}

/** Structurally validate a copied remittance payload against its declared kind and thread. */
export function validateRemittancePayload(
  kind: RemittanceKind,
  threadId: string,
  rawPayload: unknown
): RemittanceEnvelope['payload'] {
  switch (kind) {
    case 'invoice':
      return validateInvoice(rawPayload, threadId)
    case 'identityVerificationRequest':
      return validateIdentityRequest(rawPayload, threadId)
    case 'identityVerificationResponse':
      return validateIdentityResponse(rawPayload, threadId)
    case 'identityVerificationAcknowledgment':
      return validateIdentityAcknowledgment(rawPayload, threadId)
    case 'settlement':
      return validateSettlement(rawPayload, threadId)
    case 'receipt':
      return validateReceipt(rawPayload, threadId)
    case 'termination':
      return validateTermination(rawPayload)
  }
}

/** Parse and structurally validate an untrusted remittance envelope. */
export function parseRemittanceEnvelope(body: unknown): RemittanceEnvelope | undefined {
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_ENVELOPE_BYTES) {
    return undefined
  }
  try {
    const parsed = JSON.parse(body) as unknown
    assertSafeDataGraph(parsed)
    const envelope = record(parsed, 'Remittance envelope')
    if (dataProperty(envelope, 'v', 'Remittance envelope version') !== 1) return undefined
    const id = string(
      dataProperty(envelope, 'id', 'Remittance envelope id'),
      'Remittance envelope id'
    )
    const kindValue = dataProperty(envelope, 'kind', 'Remittance envelope kind')
    if (typeof kindValue !== 'string' || !kinds.has(kindValue as RemittanceKind)) return undefined
    const kind = kindValue as RemittanceKind
    const threadId = string(
      dataProperty(envelope, 'threadId', 'Remittance envelope threadId'),
      'Remittance envelope threadId'
    )
    const createdAt = timestamp(
      dataProperty(envelope, 'createdAt', 'Remittance envelope createdAt'),
      'Remittance envelope createdAt'
    )
    const payload = validateRemittancePayload(
      kind,
      threadId,
      dataProperty(envelope, 'payload', 'Remittance envelope payload')
    )
    return { v: 1, id, kind, threadId, createdAt, payload }
  } catch {
    return undefined
  }
}

/** Copy and bind a transport message before any protocol state is consulted. */
export function validatePeerMessage(
  value: unknown,
  expectedRecipient: string,
  expectedMessageBox: string
): PeerMessage {
  const message = record(value, 'Remittance transport message')
  const copy: PeerMessage = {
    messageId: string(
      dataProperty(message, 'messageId', 'Transport messageId'),
      'Transport messageId'
    ),
    sender: string(dataProperty(message, 'sender', 'Transport sender'), 'Transport sender'),
    recipient: string(
      dataProperty(message, 'recipient', 'Transport recipient'),
      'Transport recipient'
    ),
    messageBox: string(
      dataProperty(message, 'messageBox', 'Transport messageBox'),
      'Transport messageBox'
    ),
    body: dataProperty(message, 'body', 'Transport body') as string
  }
  if (typeof copy.body !== 'string' || copy.body.length > MAX_ENVELOPE_BYTES) {
    throw new TypeError('Transport body must be a bounded string')
  }
  if (copy.recipient !== expectedRecipient || copy.messageBox !== expectedMessageBox) {
    throw new TypeError('Transport message is not addressed to this remittance inbox')
  }
  return copy
}

/** Snapshot an untrusted list result without invoking element accessors. */
export function validatePeerMessageList(value: unknown): unknown[] {
  return denseArray(value, 'Remittance message list', 10_000)
}
