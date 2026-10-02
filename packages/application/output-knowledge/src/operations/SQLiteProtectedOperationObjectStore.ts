import { outputAssert, outputHex32, type OutputJSONObject } from '@bsv/sdk'
import { SQLiteProtectedLedger } from '../private/SQLiteProtectedLedger.js'
import type { NodeProtectedPayloadCodec } from '../private/NodeProtectedPayloadCodec.js'
import type {
  ProtectedLedgerAddress,
  ProtectedLedgerChange,
  ProtectedLedgerRecord,
  ProtectedLedgerConfiguration
} from '../private/ProtectedLedgerCodec.js'
import {
  ProtectedOperationObjectPlan,
  operationObjectCapacity,
  OPERATION_OBJECT_HEADER_BYTES,
  OPERATION_OBJECT_RECORD_BYTES,
  type OperationObjectHeader
} from './ProtectedOperationObjectPlan.js'
import type {
  ProtectedOperationObjectConfiguration,
  ProtectedOperationObjectReceipt,
  ProtectedOperationObjectReservation,
  ProtectedOperationObjectStatus,
  ProtectedOperationObjectStore
} from './ProtectedOperationObjectStore.js'

const clock = (): string => '0'
const guard = (): void => undefined
/**
 * Recipient-owned immutable operation objects over the existing native protected
 * ledger. All completion slots and revisions are reserved atomically before a
 * caller can pay. Store identity, custody and restoration remain explicit; this
 * owner never deletes a result, initializes on read or decides material validity.
 */
export class SQLiteProtectedOperationObjectStore implements ProtectedOperationObjectStore {
  readonly durability = 'durable' as const
  private readonly plan: ProtectedOperationObjectPlan
  private readonly ledger: SQLiteProtectedLedger
  get configuration(): ProtectedOperationObjectConfiguration {
    return this.plan.configuration
  }
  private constructor(
    path: string,
    configuration: ProtectedOperationObjectConfiguration,
    codec: NodeProtectedPayloadCodec,
    create: boolean
  ) {
    this.plan = new ProtectedOperationObjectPlan(configuration)
    const installed = this.plan.configuration,
      capacity = operationObjectCapacity(installed.maximumObjectBytes)
    const ledgerConfiguration: ProtectedLedgerConfiguration = {
      storeId: installed.storeId,
      binding: {
        format: 'output-protected-operation-object-store/1',
        recipient: installed.recipient,
        application: installed.binding,
        maximumObjects: installed.maximumObjects,
        maximumObjectBytes: installed.maximumObjectBytes
      },
      maximumRecords: installed.maximumObjects * capacity.records,
      maximumReservedBytes: installed.maximumObjects * capacity.bytes,
      maximumRecordBytes: OPERATION_OBJECT_RECORD_BYTES
    }
    this.ledger = create
      ? SQLiteProtectedLedger.create(path, ledgerConfiguration, codec)
      : SQLiteProtectedLedger.open(path, ledgerConfiguration, codec)
  }
  static create(
    path: string,
    configuration: ProtectedOperationObjectConfiguration,
    codec: NodeProtectedPayloadCodec
  ): SQLiteProtectedOperationObjectStore {
    return new SQLiteProtectedOperationObjectStore(path, configuration, codec, true)
  }
  static open(
    path: string,
    configuration: ProtectedOperationObjectConfiguration,
    codec: NodeProtectedPayloadCodec
  ): SQLiteProtectedOperationObjectStore {
    return new SQLiteProtectedOperationObjectStore(path, configuration, codec, false)
  }
  private headerAddress(id: string): ProtectedLedgerAddress {
    return { kind: 'delivery', key: this.plan.address(id, null) }
  }
  private addresses(id: string): ProtectedLedgerAddress[] {
    const count = operationObjectCapacity(this.plan.configuration.maximumObjectBytes).records - 1
    return [
      this.headerAddress(id),
      ...Array.from({ length: count }, (_, index): ProtectedLedgerAddress => ({
        kind: 'delivery',
        key: this.plan.address(id, index)
      }))
    ]
  }
  private snapshot(
    id: string,
    binding: OutputJSONObject
  ): {
    revision: string
    rows: (ProtectedLedgerRecord | undefined)[]
    header?: OperationObjectHeader
    bytes?: Uint8Array | null
  } {
    outputHex32(id)
    // Validate and own the original binding even when the requested record is absent.
    const original = this.plan.reservation(id, binding, 1).originalBinding
    const { revision, records: rows } = this.ledger.read(this.addresses(id), clock, guard)
    if (rows[0] === undefined) {
      outputAssert(
        rows.every(row => row === undefined),
        'Protected operation object has orphaned completion slots',
        'unavailable'
      )
      return { revision, rows }
    }
    const header = this.plan.parse(rows[0].value, id, original)
    outputAssert(
      rows[0].reservedBytes === OPERATION_OBJECT_HEADER_BYTES &&
        rows[0].reservedUpdates === (header.receipt === null ? 1 : 0),
      'Protected operation object header reservation differs',
      'unavailable'
    )
    const slots = this.plan.slots({ ...header, receipt: null })
    for (let index = 0; index < slots.length; index++) {
      const row = rows[index + 1]
      outputAssert(
        row !== undefined &&
          row.key === slots[index].key &&
          row.reservedBytes === slots[index].reservedBytes &&
          row.reservedUpdates === (header.receipt === null ? 1 : 0),
        'Protected operation object completion reservation differs',
        'unavailable'
      )
    }
    return {
      revision,
      rows,
      header,
      bytes: this.plan.restore(
        header,
        rows.slice(1).map(row => row!.value)
      )
    }
  }
  async reserve(
    id: string,
    originalBinding: OutputJSONObject,
    maximumBytes: number
  ): Promise<ProtectedOperationObjectReservation> {
    const wanted = this.plan.reservation(id, originalBinding, maximumBytes),
      saved = this.snapshot(id, wanted.originalBinding)
    if (saved.header !== undefined) {
      outputAssert(
        saved.header.maximumBytes === wanted.maximumBytes,
        'Protected operation object reservation changed',
        'conflict'
      )
      return { id: wanted.id, bindingDigest: wanted.bindingDigest, maximumBytes }
    }
    const changes: ProtectedLedgerChange[] = [
      {
        ...this.headerAddress(id),
        expectedRevision: null,
        reservedBytes: OPERATION_OBJECT_HEADER_BYTES,
        reservedUpdates: 1,
        value: this.plan.frame(wanted)
      },
      ...this.plan.slots(wanted).map(slot => ({
        kind: 'delivery' as const,
        key: slot.key,
        expectedRevision: null,
        reservedBytes: slot.reservedBytes,
        reservedUpdates: 1,
        value: slot.value
      }))
    ]
    this.ledger.commit(saved.revision, changes, clock, guard)
    return { id: wanted.id, bindingDigest: wanted.bindingDigest, maximumBytes }
  }
  async read(
    id: string,
    originalBinding: OutputJSONObject
  ): Promise<ProtectedOperationObjectStatus> {
    const saved = this.snapshot(id, originalBinding)
    if (saved.header === undefined) return { state: 'absent' }
    const { id: originalId, bindingDigest, maximumBytes, receipt } = saved.header
    if (receipt === null)
      return { state: 'reserved', reservation: { id: originalId, bindingDigest, maximumBytes } }
    return { state: 'stored', receipt, bytes: saved.bytes! as Uint8Array }
  }
  async put(
    id: string,
    originalBinding: OutputJSONObject,
    input: Uint8Array
  ): Promise<ProtectedOperationObjectReceipt> {
    outputAssert(
      input instanceof Uint8Array && input.byteLength <= this.plan.configuration.maximumObjectBytes,
      'Protected operation object exceeds installed capacity',
      'limited'
    )
    const bytes = new Uint8Array(input)
    try {
      const saved = this.snapshot(id, originalBinding)
      outputAssert(
        saved.header !== undefined,
        'Protected operation object requires its original reservation',
        'unavailable'
      )
      const completed = this.plan.complete(saved.header, bytes)
      if (saved.header.receipt !== null) {
        outputAssert(
          saved.bytes !== null &&
            saved.bytes !== undefined &&
            saved.bytes.length === bytes.length &&
            saved.bytes.every((byte, index) => byte === bytes[index]),
          'Protected operation object first bytes differ',
          'conflict'
        )
        return completed.receipt!
      }
      const slots = this.plan.slots(completed, bytes)
      const changes: ProtectedLedgerChange[] = [
        {
          ...this.headerAddress(id),
          expectedRevision: saved.rows[0]!.revision,
          reservedBytes: OPERATION_OBJECT_HEADER_BYTES,
          reservedUpdates: 0,
          value: this.plan.frame(completed)
        },
        ...slots.map((slot, index) => ({
          kind: 'delivery' as const,
          key: slot.key,
          expectedRevision: saved.rows[index + 1]!.revision,
          reservedBytes: slot.reservedBytes,
          reservedUpdates: 0,
          value: slot.value
        }))
      ]
      this.ledger.commit(saved.revision, changes, clock, guard, {
        maximumBatchBytes:
          operationObjectCapacity(this.plan.configuration.maximumObjectBytes).bytes + 65536
      })
      return completed.receipt!
    } finally {
      bytes.fill(0)
    }
  }
  async close(): Promise<void> {
    this.ledger.close()
  }
}
