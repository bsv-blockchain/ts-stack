import { createHash } from 'node:crypto'
import {
  ownOutputJSON,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  type OutputJSONObject
} from '@bsv/sdk'
import type { PrivateServiceIdentity } from './PrivateServiceIdentity.js'
import { nativeOutputBytes } from './NativeOutputBytes.js'
import type { ProtectedLedgerChange, ProtectedLedgerRecord } from './ProtectedLedgerCodec.js'

const CHUNK_BYTES = 786432
export interface PrivateAcquisitionPayload {
  format: 'private-acquisition-payload/1'
  acquisitionId: string
  requestDigest: string
  purpose: 'material' | 'result'
  maximumBytes: number
  chunks: number
  bytes: number | null
  digest: string | null
}

export function parsePrivateAcquisitionPayload(input: unknown): PrivateAcquisitionPayload {
  const value = ownOutputJSON(input, { bytes: 4096 }).value
  closedOutputObject(value, [
    'format',
    'acquisitionId',
    'requestDigest',
    'purpose',
    'maximumBytes',
    'chunks',
    'bytes',
    'digest'
  ])
  outputAssert(
    value.format === 'private-acquisition-payload/1',
    'Unsupported acquisition payload',
    'unsupported'
  )
  outputAssert(
    value.purpose === 'material' || value.purpose === 'result',
    'Unknown acquisition payload purpose'
  )
  outputAssert(
    typeof value.maximumBytes === 'number' &&
      Number.isSafeInteger(value.maximumBytes) &&
      value.maximumBytes >= 1 &&
      value.maximumBytes <= 4194304,
    'Invalid acquisition payload allowance'
  )
  outputAssert(
    value.chunks === Math.ceil(value.maximumBytes / CHUNK_BYTES),
    'Acquisition payload reservation is incomplete'
  )
  outputAssert(
    (value.bytes === null) === (value.digest === null),
    'Acquisition payload completion fields differ'
  )
  if (value.bytes !== null)
    outputAssert(
      typeof value.bytes === 'number' &&
        Number.isSafeInteger(value.bytes) &&
        value.bytes >= 0 &&
        value.bytes <= value.maximumBytes,
      'Invalid acquisition payload length'
    )
  return {
    format: value.format,
    acquisitionId: outputHex32(value.acquisitionId),
    requestDigest: outputHex32(value.requestDigest),
    purpose: value.purpose,
    maximumBytes: value.maximumBytes,
    chunks: value.chunks as number,
    bytes: value.bytes as number | null,
    digest: value.digest === null ? null : outputHex32(value.digest)
  }
}

/**
 * Bounded protected slots: material is frozen before quoting; result slots can be
 * filled once after payment-dependent issuance. Commit the descriptor and every
 * slot together with the acquisition state. No method here commits or authorizes
 * release, and public catalogue retention never owns these acquisition records.
 */
export class PrivateAcquisitionPayloads {
  constructor(private readonly identity: PrivateServiceIdentity) {}
  private binding(value: PrivateAcquisitionPayload) {
    return {
      acquisitionId: value.acquisitionId,
      requestDigest: value.requestDigest,
      purpose: value.purpose
    }
  }
  private address(value: PrivateAcquisitionPayload, index: number) {
    return this.identity.address('delivery', {
      purpose: 'private-acquisition-payload',
      payload: this.binding(value),
      index
    })
  }
  private frame(
    value: PrivateAcquisitionPayload,
    index: number,
    digest: string | null,
    data: string | null
  ): OutputJSONObject {
    return {
      format: 'private-acquisition-payload-slot/1',
      ...this.binding(value),
      index,
      digest,
      data
    }
  }
  private allowance(value: PrivateAcquisitionPayload, index: number): number {
    const capacity = Math.min(CHUNK_BYTES, value.maximumBytes - index * CHUNK_BYTES)
    return (
      Buffer.byteLength(canonicalOutputJSON(this.frame(value, index, '0'.repeat(64), ''))) +
      4 * Math.ceil(capacity / 3)
    )
  }
  private digest(value: PrivateAcquisitionPayload, data: Uint8Array): string {
    return createHash('sha256')
      .update('private-acquisition-payload/1\0')
      .update(canonicalOutputJSON(this.binding(value)))
      .update('\0')
      .update(data)
      .digest('hex')
  }
  private data(value: PrivateAcquisitionPayload, data: unknown): Buffer {
    return nativeOutputBytes(data, value.maximumBytes)
  }
  addresses(input: PrivateAcquisitionPayload) {
    const value = parsePrivateAcquisitionPayload(input)
    return Array.from({ length: value.chunks }, (_, i) => this.address(value, i))
  }
  /** Include every returned change in the quote's atomic capacity reservation. */
  reserve(
    acquisitionId: string,
    requestDigest: string,
    purpose: PrivateAcquisitionPayload['purpose'],
    maximumBytes: number,
    payload?: string
  ): { descriptor: PrivateAcquisitionPayload; changes: ProtectedLedgerChange[] } {
    let descriptor = parsePrivateAcquisitionPayload({
      format: 'private-acquisition-payload/1',
      acquisitionId,
      requestDigest,
      purpose,
      maximumBytes,
      chunks: Math.ceil(maximumBytes / CHUNK_BYTES),
      bytes: null,
      digest: null
    })
    const data = payload === undefined ? null : this.data(descriptor, payload)
    if (data !== null)
      descriptor = { ...descriptor, bytes: data.length, digest: this.digest(descriptor, data) }
    return {
      descriptor,
      changes: this.addresses(descriptor).map((address, index) => ({
        ...address,
        expectedRevision: null,
        reservedBytes: this.allowance(descriptor, index),
        reservedUpdates: data === null ? 1 : 0,
        value: this.frame(
          descriptor,
          index,
          descriptor.digest,
          data === null
            ? null
            : data.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64')
        )
      }))
    }
  }
  private slots(
    value: PrivateAcquisitionPayload,
    rows: readonly (ProtectedLedgerRecord | undefined)[]
  ): (string | null)[] {
    outputAssert(
      Array.isArray(rows) && rows.length === value.chunks,
      'Acquisition payload slots are incomplete',
      'unavailable'
    )
    return rows.map((row, index) => {
      const address = this.address(value, index)
      outputAssert(
        row?.kind === address.kind &&
          row.key === address.key &&
          row.reservedBytes === this.allowance(value, index) &&
          row.reservedUpdates === (value.digest === null ? 1 : 0),
        'Acquisition payload slot reservation differs',
        'unavailable'
      )
      const body = row.value
      closedOutputObject(body, [
        'format',
        'acquisitionId',
        'requestDigest',
        'purpose',
        'index',
        'digest',
        'data'
      ])
      outputAssert(
        body.format === 'private-acquisition-payload-slot/1' &&
          body.acquisitionId === value.acquisitionId &&
          body.requestDigest === value.requestDigest &&
          body.purpose === value.purpose &&
          body.index === index &&
          body.digest === value.digest,
        'Acquisition payload slot binding differs',
        'unavailable'
      )
      if (value.digest === null)
        outputAssert(
          body.data === null,
          'Unfinished acquisition payload contains unbound data',
          'unavailable'
        )
      else
        outputAssert(
          typeof body.data === 'string',
          'Completed acquisition payload data is missing',
          'unavailable'
        )
      return body.data as string | null
    })
  }
  /** Fill previously reserved slots exactly once; commit descriptor and changes atomically. */
  seal(
    input: PrivateAcquisitionPayload,
    rows: readonly (ProtectedLedgerRecord | undefined)[],
    payload: string
  ): { descriptor: PrivateAcquisitionPayload; changes: ProtectedLedgerChange[] } {
    const value = parsePrivateAcquisitionPayload(input),
      data = this.data(value, payload)
    this.slots(value, rows)
    const digest = this.digest(value, data)
    if (value.digest !== null) {
      outputAssert(
        value.digest === digest && value.bytes === data.length,
        'Acquisition payload is already immutable',
        'conflict'
      )
      // Identical retries still check actual retained bytes, not only metadata.
      this.read(value, rows)
      return { descriptor: value, changes: [] }
    }
    const descriptor = { ...value, bytes: data.length, digest }
    return {
      descriptor,
      changes: rows.map((row, index) => ({
        ...this.address(value, index),
        expectedRevision: row!.revision,
        reservedBytes: row!.reservedBytes,
        reservedUpdates: 0,
        value: this.frame(
          value,
          index,
          digest,
          data.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64')
        )
      }))
    }
  }
  /** Caller separately restores domain meaning and current recipient authorization. */
  read(
    input: PrivateAcquisitionPayload,
    rows: readonly (ProtectedLedgerRecord | undefined)[]
  ): string {
    const value = parsePrivateAcquisitionPayload(input)
    outputAssert(
      value.bytes !== null && value.digest !== null,
      'Acquisition payload is not yet complete',
      'unavailable'
    )
    const chunks = this.slots(value, rows).map((part, index) => {
      const chunk = nativeOutputBytes(part, CHUNK_BYTES)
      outputAssert(
        chunk.length === Math.min(CHUNK_BYTES, Math.max(0, value.bytes! - index * CHUNK_BYTES)),
        'Acquisition payload chunk length differs',
        'unavailable'
      )
      return chunk
    })
    const data = Buffer.concat(chunks)
    outputAssert(
      data.length === value.bytes && this.digest(value, data) === value.digest,
      'Acquisition payload integrity differs',
      'unavailable'
    )
    return data.toString('base64')
  }
}
