import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  Hash,
  outputAssert,
  outputHex32,
  outputIdentity,
  parseOutputJSON,
  Utils,
  type OutputJSONObject
} from '@bsv/sdk'
import type {
  ProtectedOperationObjectConfiguration,
  ProtectedOperationObjectReceipt,
  ProtectedOperationObjectReservation
} from './ProtectedOperationObjectStore.js'

export const OPERATION_OBJECT_CHUNK_BYTES = 786432
export const OPERATION_OBJECT_HEADER_BYTES = 32768
export const OPERATION_OBJECT_RECORD_BYTES = 1052672
const FORMAT = 'output-protected-operation-object/1'
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)
export function operationObjectDigest(text: string | Uint8Array): string {
  return Utils.toHex(Hash.sha256(typeof text === 'string' ? bytesOf(text) : text))
}
function integer(value: unknown, maximum: number): number {
  outputAssert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum,
    'Invalid protected operation object capacity'
  )
  return value
}
function object(value: unknown, maximum: number): OutputJSONObject {
  const result = parseOutputJSON(canonicalOutputJSON(value, { bytes: maximum }), { bytes: maximum })
  outputAssert(
    result !== null && typeof result === 'object' && !Array.isArray(result),
    'Expected protected operation object object'
  )
  return result
}
export function operationObjectConfiguration(
  input: ProtectedOperationObjectConfiguration
): ProtectedOperationObjectConfiguration {
  const value = object(input, 32768)
  closedOutputObject(value, [
    'storeId',
    'recipient',
    'binding',
    'maximumObjects',
    'maximumObjectBytes'
  ])
  const result = {
    storeId: outputHex32(value.storeId),
    recipient: outputIdentity(value.recipient),
    binding: object(value.binding, 16384),
    maximumObjects: integer(value.maximumObjects, 1024),
    maximumObjectBytes: integer(value.maximumObjectBytes, 4194304)
  }
  outputAssert(
    result.maximumObjects * operationObjectCapacity(result.maximumObjectBytes).bytes <=
      64 * 1024 * 1024 &&
      result.maximumObjects * operationObjectCapacity(result.maximumObjectBytes).records <= 4096,
    'Protected operation object installation exceeds local reservation capacity',
    'limited'
  )
  return result
}
/** Complete retained plaintext framing; crypto expansion is separately reserved by the backing owner. */
export function operationObjectCapacity(maximum: number): { records: number; bytes: number } {
  integer(maximum, 4194304)
  const chunks = Math.ceil(maximum / OPERATION_OBJECT_CHUNK_BYTES)
  return {
    records: chunks + 1,
    bytes:
      OPERATION_OBJECT_HEADER_BYTES +
      Array.from({ length: chunks }, (_, index) => chunkCapacity(maximum, index)).reduce(
        (a, b) => a + b,
        0
      )
  }
}
export function chunkCapacity(maximum: number, index: number): number {
  const length = Math.min(
    OPERATION_OBJECT_CHUNK_BYTES,
    maximum - index * OPERATION_OBJECT_CHUNK_BYTES
  )
  outputAssert(
    Number.isSafeInteger(index) && index >= 0 && length > 0,
    'Invalid protected object chunk index'
  )
  return 4 * Math.ceil(length / 3) + 4096
}
export interface OperationObjectHeader extends ProtectedOperationObjectReservation {
  originalBinding: OutputJSONObject
  receipt: ProtectedOperationObjectReceipt | null
}
export interface OperationObjectSlot {
  key: string
  reservedBytes: number
  value: OutputJSONObject
}
/** Deterministic local addressing includes the independent installation, original operation and role. */
export class ProtectedOperationObjectPlan {
  private readonly installed: ProtectedOperationObjectConfiguration
  get configuration(): ProtectedOperationObjectConfiguration {
    return operationObjectConfiguration(this.installed)
  }
  private readonly configurationDigest: string
  constructor(configuration: ProtectedOperationObjectConfiguration) {
    this.installed = operationObjectConfiguration(configuration)
    this.configurationDigest = operationObjectDigest(
      FORMAT + '\0' + canonicalOutputJSON(this.configuration, { bytes: 32768 })
    )
  }
  reservation(id: string, binding: OutputJSONObject, maximumBytes: number): OperationObjectHeader {
    const originalBinding = object(binding, 16384)
    return {
      id: outputHex32(id),
      bindingDigest: operationObjectDigest(
        FORMAT + '\0' + canonicalOutputJSON(originalBinding, { bytes: 16384 })
      ),
      maximumBytes: integer(maximumBytes, this.configuration.maximumObjectBytes),
      originalBinding,
      receipt: null
    }
  }
  address(id: string, index: number | null): string {
    outputAssert(
      index === null || (Number.isSafeInteger(index) && index >= 0 && index < 6),
      'Invalid protected object address'
    )
    return operationObjectDigest(
      FORMAT +
        '\0' +
        canonicalOutputJSON({ configuration: this.configurationDigest, id: outputHex32(id), index })
    )
  }
  frame(header: OperationObjectHeader): OutputJSONObject {
    return object({ format: FORMAT, ...header }, OPERATION_OBJECT_HEADER_BYTES)
  }
  parse(input: unknown, id: string, originalBinding: OutputJSONObject): OperationObjectHeader {
    const value = object(input, OPERATION_OBJECT_HEADER_BYTES)
    closedOutputObject(value, [
      'format',
      'id',
      'bindingDigest',
      'maximumBytes',
      'originalBinding',
      'receipt'
    ])
    const expected = this.reservation(id, originalBinding, value.maximumBytes as number)
    outputAssert(
      value.format === FORMAT &&
        value.id === expected.id &&
        value.bindingDigest === expected.bindingDigest &&
        canonicalOutputJSON(value.originalBinding, { bytes: 16384 }) ===
          canonicalOutputJSON(expected.originalBinding, { bytes: 16384 }),
      'Protected operation object original binding differs',
      'context-changed'
    )
    if (value.receipt === null) return expected
    closedOutputObject(value.receipt, ['id', 'bindingDigest', 'maximumBytes', 'bytes', 'digest'])
    const receipt = value.receipt
    outputAssert(
      receipt.id === expected.id &&
        receipt.bindingDigest === expected.bindingDigest &&
        receipt.maximumBytes === expected.maximumBytes &&
        typeof receipt.bytes === 'number' &&
        Number.isSafeInteger(receipt.bytes) &&
        receipt.bytes >= 0 &&
        receipt.bytes <= expected.maximumBytes,
      'Protected operation object receipt differs',
      'unavailable'
    )
    return {
      ...expected,
      receipt: {
        id: expected.id,
        bindingDigest: expected.bindingDigest,
        maximumBytes: expected.maximumBytes,
        bytes: receipt.bytes,
        digest: outputHex32(receipt.digest)
      }
    }
  }
  slots(header: OperationObjectHeader, input?: Uint8Array): OperationObjectSlot[] {
    outputAssert(
      (header.receipt === null) === (input === undefined),
      'Protected operation object completion framing differs'
    )
    return Array.from(
      { length: Math.ceil(this.installed.maximumObjectBytes / OPERATION_OBJECT_CHUNK_BYTES) },
      (_, index) => ({
        key: this.address(header.id, index),
        reservedBytes: chunkCapacity(this.installed.maximumObjectBytes, index),
        value: {
          format: FORMAT + '/chunk',
          id: header.id,
          bindingDigest: header.bindingDigest,
          index,
          digest: header.receipt?.digest ?? null,
          data:
            input === undefined
              ? null
              : Utils.toBase64(
                  Array.from(
                    input.subarray(
                      index * OPERATION_OBJECT_CHUNK_BYTES,
                      (index + 1) * OPERATION_OBJECT_CHUNK_BYTES
                    )
                  )
                )
        }
      })
    )
  }
  complete(header: OperationObjectHeader, bytes: Uint8Array): OperationObjectHeader {
    outputAssert(
      bytes instanceof Uint8Array && bytes.length <= header.maximumBytes,
      'Protected operation object exceeds original reservation',
      'limited'
    )
    const receipt = {
      id: header.id,
      bindingDigest: header.bindingDigest,
      maximumBytes: header.maximumBytes,
      bytes: bytes.length,
      digest: operationObjectDigest(bytes)
    }
    if (header.receipt !== null)
      outputAssert(
        canonicalOutputJSON(header.receipt) === canonicalOutputJSON(receipt),
        'Protected operation object is already immutable',
        'conflict'
      )
    return { ...header, receipt }
  }
  restore(header: OperationObjectHeader, values: readonly OutputJSONObject[]): Uint8Array | null {
    const expected = this.slots({ ...header, receipt: null })
    outputAssert(
      values.length === expected.length,
      'Protected operation object chunks are incomplete',
      'unavailable'
    )
    const data = new Uint8Array(header.receipt?.bytes ?? 0)
    for (let index = 0; index < expected.length; index++) {
      const value = object(values[index], expected[index].reservedBytes)
      closedOutputObject(value, ['format', 'id', 'bindingDigest', 'index', 'digest', 'data'])
      outputAssert(
        value.format === FORMAT + '/chunk' &&
          value.id === header.id &&
          value.bindingDigest === header.bindingDigest &&
          value.index === index &&
          value.digest === (header.receipt?.digest ?? null),
        'Protected operation object chunk binding differs',
        'unavailable'
      )
      if (header.receipt === null)
        outputAssert(
          value.data === null,
          'Unfinished protected operation object has unbound bytes',
          'unavailable'
        )
      else {
        const part = new Uint8Array(decodeOutputBytes(value.data, OPERATION_OBJECT_CHUNK_BYTES))
        outputAssert(
          part.length ===
            Math.min(
              OPERATION_OBJECT_CHUNK_BYTES,
              Math.max(0, data.length - index * OPERATION_OBJECT_CHUNK_BYTES)
            ),
          'Protected operation object chunk length differs',
          'unavailable'
        )
        data.set(part, Math.min(index * OPERATION_OBJECT_CHUNK_BYTES, data.length))
      }
    }
    if (header.receipt === null) return null
    outputAssert(
      operationObjectDigest(data) === header.receipt.digest,
      'Protected operation object digest differs',
      'unavailable'
    )
    return data
  }
}
