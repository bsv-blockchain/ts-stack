import { parseSnapshotArchiveReaderRequest, type SnapshotArchiveReaderRequest } from './SnapshotArchiveReaderRequest'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import {
  parseSnapshotArchiveRequest,
  type SnapshotArchiveRequest,
  type SnapshotArchiveRequestReceipt
} from './SnapshotArchiveRequest'
import { validateSnapshotArchiveRequestReceipt } from './SnapshotArchiveProtocol'

/** Only pre-admission capacity refusals carry this type; cleanup errors do not. */
export class SnapshotArchiveAdmissionLimitError extends SnapshotResourceLimitError {}

export type SnapshotArchiveAdmission =
  | { version: 1; outcome: 'accepted'; receipt: Readonly<SnapshotArchiveRequestReceipt> }
  | { version: 1; outcome: 'resource-limited'; requestId: string; expiresAt: number }

function invalid(): never {
  throw new TypeError('Invalid snapshot archive admission outcome')
}

/** A refusal is transient and never stands in for an immutable durable receipt. */
export function validateSnapshotArchiveAdmission(
  input: unknown,
  value: SnapshotArchiveRequest | SnapshotArchiveReaderRequest
): Readonly<SnapshotArchiveAdmission> {
  const version =
    value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'version')?.value : undefined
  const request = version === 2 ? parseSnapshotArchiveReaderRequest(value) : parseSnapshotArchiveRequest(value)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid()
  const property = Object.getOwnPropertyDescriptor(input, 'outcome')
  if (property === undefined || !('value' in property)) invalid()
  const names =
    property.value === 'accepted' ? ['version', 'outcome', 'receipt'] : ['version', 'outcome', 'requestId', 'expiresAt']
  if (Reflect.ownKeys(input).length !== names.length) invalid()
  const fields: Record<string, unknown> = {}
  for (const name of names) {
    const item = Object.getOwnPropertyDescriptor(input, name)
    if (item === undefined || !('value' in item) || !item.enumerable) invalid()
    fields[name] = item.value
  }
  if (fields.version !== 1) invalid()
  if (fields.outcome === 'accepted')
    return Object.freeze({
      version: 1,
      outcome: 'accepted',
      receipt: validateSnapshotArchiveRequestReceipt(fields.receipt, request)
    })
  if (
    fields.outcome !== 'resource-limited' ||
    fields.requestId !== request.requestId ||
    fields.expiresAt !== request.notAfter
  )
    invalid()
  return Object.freeze({
    version: 1,
    outcome: 'resource-limited',
    requestId: request.requestId,
    expiresAt: request.notAfter
  })
}
