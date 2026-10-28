import type { Knex } from 'knex'
import {
  brc38NativeLocalFieldCoordinate,
  brc38NativeLocalFieldProtocolMatches,
  encodeBrc38NativeLocalFieldRead,
  type Brc38NativeLocalFieldCoordinate,
  type Brc38NativeLocalFieldRead
} from './Brc38NativeLocalFieldProtocol'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'

interface NativeLocalReader {
  isOwnedNativeTransaction(value: unknown): boolean
  readOwnedNativeLocalField(trx: Knex.Transaction, input: Brc38NativeLocalFieldRead): Promise<Uint8Array>
}
const driver: NativeLocalReader = require('./NativeProfileSqlite.cjs')
function actual(trx: Knex.Transaction): void {
  if (!driver.isOwnedNativeTransaction(trx)) throw new Error('An actual retained native local-field view is required')
}
/** Lower transport only. The baseline factory must independently authenticate
 * its real source/schema/profile/primary and own this coherent transaction.
 * A matching length, ABI or packet is never an admission/capability. */
export async function readBrc38NativeLocalFieldBytes(
  trx: Knex.Transaction,
  selected: Brc38NativeLocalFieldCoordinate,
  signal?: AbortSignal
): Promise<number | null> {
  const input = Object.freeze({ ...selected }),
    coordinate = brc38NativeLocalFieldCoordinate(input)
  signal?.throwIfAborted()
  actual(trx)
  const rows = (await trx.raw(
    'SELECT brc38_local_field_protocol() AS abi,brc38_local_field_extent_bytes(CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER)) AS bytes',
    [coordinate[0], coordinate[1], input.rowId]
  )) as Array<{ abi: number; bytes: number | null }>
  signal?.throwIfAborted()
  actual(trx)
  if (
    rows.length !== 1 ||
    !brc38NativeLocalFieldProtocolMatches(input, rows[0].abi) ||
    (rows[0].bytes !== null &&
      (!Number.isSafeInteger(rows[0].bytes) || rows[0].bytes < 0 || rows[0].bytes > 1000000000))
  )
    throw new Error('Local native field metadata differs from its actual view')
  return rows[0].bytes
}
/** Scoped ownership keeps the finite transport/decoded bytes charged until
 * the consumer finishes. The concrete buffer is wiped on every exit. */
export async function withBrc38NativeLocalFieldExtent<T>(
  trx: Knex.Transaction,
  selected: Brc38NativeLocalFieldRead,
  working: Brc38WorkingAllocation,
  work: (bytes: Uint8Array) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const input = Object.freeze({ ...selected })
  encodeBrc38NativeLocalFieldRead(input)
  signal?.throwIfAborted()
  actual(trx)
  brc38WorkingAllocation(working)
  const charge = working.claim(4096 + 32 * input.length)
  let bytes: Uint8Array | undefined
  try {
    if ((await readBrc38NativeLocalFieldBytes(trx, input, signal)) !== input.totalBytes)
      throw new Error('Local native field length differs before read')
    bytes = await driver.readOwnedNativeLocalField(trx, input)
    signal?.throwIfAborted()
    actual(trx)
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== input.length ||
      (await readBrc38NativeLocalFieldBytes(trx, input, signal)) !== input.totalBytes
    )
      throw new Error('Local native field extent differs from its retained view')
    const result = await work(bytes)
    signal?.throwIfAborted()
    actual(trx)
    return result
  } finally {
    bytes?.fill(0)
    charge.close()
  }
}
