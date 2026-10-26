import { compareCodeUnits } from '../core/code-unit-order'
import { RevocationRecord, RevocationStore } from '../core/types'
import * as nodePath from 'node:path'
import { JsonFileStore } from '../server/json-file-store'

const MAX_REVOCATION_RECORDS = 100_000
const MAX_REVOCATION_BEEF_BYTES = 8 * 1024 * 1024

type RevocationRecords = Record<string, RevocationRecord>

function validSerial(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9+/=_-]{1,128}$/.test(value)
}

function ownBytes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_REVOCATION_BEEF_BYTES) {
    throw new Error('Stored revocation transaction is invalid')
  }
  const output: number[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor == null ||
      !('value' in descriptor) ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      throw new Error('Stored revocation transaction is invalid')
    }
    output.push(descriptor.value)
  }
  return output
}

function ownRecord(value: unknown): RevocationRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored revocation record is invalid')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors).sort(compareCodeUnits)
  if (
    keys.length !== 3 ||
    keys[0] !== 'beef' ||
    keys[1] !== 'outpoint' ||
    keys[2] !== 'secret' ||
    !('value' in descriptors.beef) ||
    !('value' in descriptors.outpoint) ||
    !('value' in descriptors.secret)
  ) {
    throw new Error('Stored revocation record is invalid')
  }
  const secret = descriptors.secret.value
  const outpoint = descriptors.outpoint.value
  if (
    typeof secret !== 'string' ||
    !/^[0-9a-f]{64}$/.test(secret) ||
    typeof outpoint !== 'string' ||
    !/^[0-9a-f]{64}\.(?:0|[1-9]\d{0,9})$/.test(outpoint) ||
    Number(outpoint.slice(outpoint.lastIndexOf('.') + 1)) > 0xffffffff
  ) {
    throw new Error('Stored revocation record is invalid')
  }
  return { secret, outpoint, beef: ownBytes(descriptors.beef.value) }
}

function ownRecords(value: unknown): RevocationRecords {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored revocation records are invalid')
  }
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
  if (entries.length > MAX_REVOCATION_RECORDS) {
    throw new Error('Stored revocation records exceed the configured limit')
  }
  const output: RevocationRecords = Object.create(null) as RevocationRecords
  for (const [serial, descriptor] of entries) {
    if (!validSerial(serial) || !('value' in descriptor)) {
      throw new Error('Stored revocation records are invalid')
    }
    output[serial] = ownRecord(descriptor.value)
  }
  return output
}

// ============================================================================
// FileRevocationStore (Node.js server only — not browser-safe)
// ============================================================================

export class FileRevocationStore implements RevocationStore {
  private readonly store: JsonFileStore<RevocationRecords>
  private mutex: Promise<void> = Promise.resolve()

  constructor(filePath?: string) {
    this.store = new JsonFileStore(
      filePath ?? nodePath.join(process.cwd(), '.revocation-secrets.json')
    )
  }

  private loadAll(): RevocationRecords {
    const value = this.store.load()
    return value == null ? (Object.create(null) as RevocationRecords) : ownRecords(value)
  }

  private async withLock<T>(fn: (records: RevocationRecords) => T): Promise<T> {
    const previous = this.mutex
    let release: (() => void) | undefined
    this.mutex = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      const records = this.loadAll()
      const result = fn(records)
      this.store.save(records)
      return result
    } finally {
      release?.()
    }
  }

  async save(serialNumber: string, record: RevocationRecord): Promise<void> {
    if (!validSerial(serialNumber)) throw new TypeError('Invalid revocation serial number')
    const owned = ownRecord(record)
    await this.withLock(records => {
      if (!(serialNumber in records) && Object.keys(records).length >= MAX_REVOCATION_RECORDS) {
        throw new Error('Stored revocation records exceed the configured limit')
      }
      records[serialNumber] = owned
    })
  }

  async load(serialNumber: string): Promise<RevocationRecord | undefined> {
    if (!validSerial(serialNumber)) throw new TypeError('Invalid revocation serial number')
    const record = this.loadAll()[serialNumber]
    return record == null ? undefined : ownRecord(record)
  }

  async delete(serialNumber: string): Promise<void> {
    if (!validSerial(serialNumber)) throw new TypeError('Invalid revocation serial number')
    await this.withLock(records => {
      delete records[serialNumber]
    })
  }

  async has(serialNumber: string): Promise<boolean> {
    if (!validSerial(serialNumber)) throw new TypeError('Invalid revocation serial number')
    return Object.prototype.hasOwnProperty.call(this.loadAll(), serialNumber)
  }

  async findByOutpoint(outpoint: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}\.(?:0|[1-9]\d{0,9})$/.test(outpoint)) {
      throw new TypeError('Invalid revocation outpoint')
    }
    return Object.values(this.loadAll()).some(record => record.outpoint === outpoint)
  }
}
