import { validateSnapshotArchiveOffer, type SnapshotArchiveOffer } from './SnapshotArchiveProtocol'
import {
  validateSnapshotArchiveReaderRequest,
  validateSnapshotArchiveReaderOptions,
  type SnapshotArchiveReaderRequest,
  type SnapshotArchiveReaderOptions
} from './SnapshotArchiveReaderRequest'
export { validateSnapshotArchiveReaderOptions, type SnapshotArchiveReaderOptions } from './SnapshotArchiveReaderRequest'

/** A refused offer has no request and cannot have started a capture. */
export type SnapshotArchiveReaderOffer =
  | {
      version: 1
      outcome: 'offered'
      offer: Readonly<SnapshotArchiveOffer>
      request: Readonly<SnapshotArchiveReaderRequest>
    }
  | { version: 1; outcome: 'resource-limited' }

function invalid(): never {
  throw new TypeError('Invalid snapshot archive reader offer')
}

function record(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid()
  if (Reflect.ownKeys(input).length !== names.length) invalid()
  const result: Record<string, unknown> = {}
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(input, name)
    if (field === undefined || !('value' in field) || !field.enumerable) invalid()
    result[name] = field.value
  }
  return result
}

export function validateSnapshotArchiveReaderOffer(
  input: unknown,
  options: SnapshotArchiveReaderOptions,
  storageIdentityKey: string,
  chain: 'main' | 'test'
): Readonly<SnapshotArchiveReaderOffer> {
  const expected = validateSnapshotArchiveReaderOptions(options)
  const outcome =
    input !== null && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'outcome')?.value : undefined
  const fields = record(
    input,
    outcome === 'offered' ? ['version', 'outcome', 'offer', 'request'] : ['version', 'outcome']
  )
  if (fields.version !== 1) invalid()
  if (fields.outcome === 'resource-limited') return Object.freeze({ version: 1, outcome: 'resource-limited' })
  if (fields.outcome !== 'offered') invalid()
  const offer = validateSnapshotArchiveOffer(fields.offer, storageIdentityKey, chain)
  const request = validateSnapshotArchiveReaderRequest(fields.request, offer.serverTime)
  if (request.notAfter !== offer.serverTime + expected.lifetimeMs || request.maxBytes !== expected.maxBytes) invalid()
  return Object.freeze({ version: 1, outcome: 'offered', offer, request })
}
