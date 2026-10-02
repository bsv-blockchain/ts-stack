import {
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputU64,
  parseOutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'
import type { ProtectedOperationPayload } from './ProtectedOperationPayload.js'
import {
  operationObjectCapacity,
  operationObjectDigest,
  ProtectedOperationObjectPlan,
  OPERATION_OBJECT_HEADER_BYTES,
  OPERATION_OBJECT_RECORD_BYTES
} from './ProtectedOperationObjectPlan.js'

const FORMAT = 'output-indexeddb-operation-objects/1'
export const OPERATION_OBJECT_HEAD = 'head'
export interface OperationObjectEnvelope {
  key: string
  revision: string
  payload: OutputJSONObject
}
export interface OperationObjectInventoryEntry {
  id: string
  complete: boolean
  digests: string[]
}
export interface OperationObjectInventory {
  revision: string
  entries: OperationObjectInventoryEntry[]
}

/** Browser-local ciphertext framing and inventory validation; no payment or disclosure authority. */
export class ProtectedOperationObjectCipher {
  readonly maximumRows: number
  readonly headBytes: number
  private readonly binding: string
  private readonly codecId: string
  private readonly plainBytes: number
  private readonly sealedBytes: number
  private readonly sealMethod: ProtectedOperationPayload['seal']
  private readonly openMethod: ProtectedOperationPayload['open']
  constructor(
    readonly plan: ProtectedOperationObjectPlan,
    private readonly codec: ProtectedOperationPayload
  ) {
    const config = plan.configuration,
      records = operationObjectCapacity(config.maximumObjectBytes).records
    this.maximumRows = config.maximumObjects * records + 1
    this.headBytes = 1024 + config.maximumObjects * (256 + records * 68)
    this.codecId = codec.id
    this.plainBytes = codec.maximumPlaintextBytes
    this.sealedBytes = codec.maximumSealedBytes
    this.sealMethod = codec.seal
    this.openMethod = codec.open
    outputAssert(
      typeof this.codecId === 'string' &&
        this.codecId.length > 0 &&
        this.codecId.length <= 128 &&
        Number.isSafeInteger(this.plainBytes) &&
        this.plainBytes >=
          Math.max(
            this.headBytes,
            OPERATION_OBJECT_HEADER_BYTES,
            Math.min(
              OPERATION_OBJECT_RECORD_BYTES,
              operationObjectCapacity(config.maximumObjectBytes).bytes -
                OPERATION_OBJECT_HEADER_BYTES
            )
          ) &&
        this.plainBytes <= 2097152 &&
        Number.isSafeInteger(this.sealedBytes) &&
        this.sealedBytes > 0 &&
        this.sealedBytes <= 4194304 &&
        this.maximumRows * this.sealedBytes <= 128 * 1024 * 1024,
      'Protected operation objects lack complete ciphertext capacity',
      'limited'
    )
    this.binding = operationObjectDigest(
      canonicalOutputJSON(
        {
          format: FORMAT,
          configuration: config,
          codec: this.codecId,
          plainBytes: this.plainBytes,
          sealedBytes: this.sealedBytes
        },
        { bytes: 32768 }
      )
    )
    this.current()
  }
  current(): void {
    outputAssert(
      this.codec.id === this.codecId &&
        this.codec.maximumPlaintextBytes === this.plainBytes &&
        this.codec.maximumSealedBytes === this.sealedBytes &&
        typeof this.sealMethod === 'function' &&
        typeof this.openMethod === 'function' &&
        this.codec.seal === this.sealMethod &&
        this.codec.open === this.openMethod,
      'Protected operation object custody capability changed',
      'context-changed'
    )
  }
  private aad(key: string, revision: string): OutputJSONObject {
    outputAssert(
      key === OPERATION_OBJECT_HEAD || outputHex32(key) === key,
      'Invalid protected object address'
    )
    return { format: FORMAT, binding: this.binding, key, revision: outputU64(revision).toString() }
  }
  envelope(input: unknown): OperationObjectEnvelope {
    const value = object(input, this.sealedBytes + 256)
    closedOutputObject(value, ['key', 'revision', 'payload'])
    outputAssert(
      typeof value.key === 'string' &&
        (value.key === OPERATION_OBJECT_HEAD || outputHex32(value.key) === value.key),
      'Invalid protected object row',
      'unavailable'
    )
    return {
      key: value.key,
      revision: outputU64(value.revision).toString(),
      payload: object(value.payload, this.sealedBytes)
    }
  }
  envelopeDigest(input: unknown): string {
    return operationObjectDigest(
      canonicalOutputJSON(this.envelope(input), { bytes: this.sealedBytes + 256 })
    )
  }
  async seal(
    key: string,
    revision: string,
    value: OutputJSONObject,
    maximum: number
  ): Promise<OperationObjectEnvelope> {
    this.current()
    const bytes = new TextEncoder().encode(canonicalOutputJSON(value, { bytes: maximum }))
    outputAssert(
      bytes.length <= this.plainBytes,
      'Protected object plaintext exceeds custody capacity',
      'limited'
    )
    try {
      const payload = await this.sealMethod.call(this.codec, this.aad(key, revision), bytes)
      this.current()
      return this.envelope({ key, revision, payload })
    } finally {
      bytes.fill(0)
    }
  }
  async open(
    input: unknown,
    key: string,
    revision: string,
    maximum: number
  ): Promise<OutputJSONObject> {
    this.current()
    const row = this.envelope(input)
    outputAssert(
      row.key === key && row.revision === revision,
      'Protected object row binding differs',
      'unavailable'
    )
    const bytes = await this.openMethod.call(this.codec, this.aad(key, revision), row.payload)
    try {
      this.current()
      outputAssert(
        bytes instanceof Uint8Array && bytes.length <= maximum && bytes.length <= this.plainBytes,
        'Protected object plaintext exceeds reserved capacity',
        'limited'
      )
      return object(parseOutputJSON(bytes, { bytes: maximum }), maximum)
    } finally {
      if (bytes instanceof Uint8Array) bytes.fill(0)
    }
  }
  async sealInventory(inventory: OperationObjectInventory): Promise<OperationObjectEnvelope> {
    this.validateInventory(inventory)
    return await this.seal(
      OPERATION_OBJECT_HEAD,
      inventory.revision,
      object({ format: FORMAT, ...inventory }, this.headBytes),
      this.headBytes
    )
  }
  async inventory(input: unknown, keys: readonly IDBValidKey[]): Promise<OperationObjectInventory> {
    const row = this.envelope(input)
    const plain = await this.open(row, OPERATION_OBJECT_HEAD, row.revision, this.headBytes)
    closedOutputObject(plain, ['format', 'revision', 'entries'])
    outputAssert(
      plain.format === FORMAT && plain.revision === row.revision && Array.isArray(plain.entries),
      'Protected object inventory differs',
      'unavailable'
    )
    const entries = plain.entries.map(value => {
      closedOutputObject(value, ['id', 'complete', 'digests'])
      outputAssert(
        typeof value.complete === 'boolean' && Array.isArray(value.digests),
        'Invalid protected object inventory entry',
        'unavailable'
      )
      return {
        id: outputHex32(value.id),
        complete: value.complete,
        digests: value.digests.map(outputHex32)
      }
    })
    const result = { revision: row.revision, entries }
    this.validateInventory(result)
    const expected = [
      OPERATION_OBJECT_HEAD,
      ...entries.flatMap(entry => this.addresses(entry.id))
    ].sort()
    outputAssert(
      keys.length === expected.length &&
        [...keys].sort().every((key, index) => key === expected[index]),
      'Protected object rows differ from authenticated inventory',
      'unavailable'
    )
    return result
  }
  addresses(id: string): string[] {
    return [
      this.plan.address(id, null),
      ...Array.from(
        { length: operationObjectCapacity(this.plan.configuration.maximumObjectBytes).records - 1 },
        (_, index) => this.plan.address(id, index)
      )
    ]
  }
  private validateInventory(inventory: OperationObjectInventory): void {
    const records = operationObjectCapacity(this.plan.configuration.maximumObjectBytes).records
    outputAssert(
      inventory.entries.length <= this.plan.configuration.maximumObjects,
      'Protected object inventory capacity exceeded',
      'limited'
    )
    let expectedRevision = 0
    inventory.entries.forEach((entry, index) => {
      outputHex32(entry.id)
      outputAssert(
        index === 0 || inventory.entries[index - 1].id < entry.id,
        'Protected object inventory order differs',
        'unavailable'
      )
      outputAssert(
        typeof entry.complete === 'boolean' && entry.digests.length === records,
        'Protected object inventory framing differs',
        'unavailable'
      )
      entry.digests.forEach(outputHex32)
      expectedRevision += entry.complete ? 2 : 1
    })
    outputAssert(
      inventory.revision === String(expectedRevision),
      'Protected object inventory revision differs',
      'unavailable'
    )
  }
}
function object(input: unknown, bytes: number): OutputJSONObject {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes }), { bytes })
  outputAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected protected object record'
  )
  return value
}
