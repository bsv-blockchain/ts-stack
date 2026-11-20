import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import { requireBrc38PackedRead, requireBrc38PackedWriter } from './Brc38NativePackedSchemaNode'
import {
  hasBrc38NativePreparedFieldsSchema,
  hasBrc38NativePreparedContentSchema,
  nativePreparedFieldsTable,
  type Brc38NativePreparedFamily
} from './Brc38NativePreparedFieldSchemaNode'

const issuer = Object.freeze({})
interface Lifetime {
  id: string
  family: Brc38NativePreparedFamily
  sha256: string
  expiresAt: number
}
interface NativeIdentity {
  token: object
  slot: number
}
function invalid(): never {
  throw new Error('Native prepared content differs from its actual issuer, original lifetime or current lease')
}
function identity(k: Knex.Transaction): NativeIdentity {
  requireBrc38PackedRead(k)
  const driver = require('./NativeProfileSqlite.cjs') as {
      nativeTransactionIdentity: (trx: Knex.Transaction) => NativeIdentity | undefined
    },
    actual = driver.nativeTransactionIdentity(k)
  if (actual === undefined || ![0, 3].includes(actual.slot)) invalid()
  return actual
}
function matches(actual: Lifetime | undefined, expected: Readonly<Lifetime>): boolean {
  return (
    actual?.id === expected.id &&
    actual.family === expected.family &&
    actual.sha256 === expected.sha256 &&
    actual.expiresAt === expected.expiresAt
  )
}
async function schema(k: Knex.Transaction): Promise<void> {
  if (!(await hasBrc38NativePreparedContentSchema(k))) invalid()
}
/** Actual issued lifetime, never source authentication, a completed content
 * proof, row-selection policy, write admission, durable ACK or activation.
 * The enclosing one-use field preparation still independently hashes bytes
 * and checks source/profile/primary/current row and native writer at effect. */
export class Brc38NativePreparedFieldLifetime {
  readonly #origin: object
  readonly #row: Readonly<Lifetime>
  readonly #deadline: number
  #released = false
  private constructor(token: object, origin: object, row: Readonly<Lifetime>) {
    if (token !== issuer) invalid()
    this.#origin = origin
    this.#row = row
    this.#deadline = performance.now() + Math.max(0, row.expiresAt - Date.now())
  }
  /** Begin inside the caller's actual currently owned writer. A caller must
   * return only after that transaction commits; rollback leaves no usable
   * lifetime because every subsequent check freshly requires its real row. */
  static async begin(
    k: Knex.Transaction,
    family: Brc38NativePreparedFamily,
    sha256: string,
    expiresAt: number,
    signal?: AbortSignal
  ): Promise<Brc38NativePreparedFieldLifetime> {
    signal?.throwIfAborted()
    requireBrc38PackedWriter(k)
    const origin = identity(k)
    if (
      !['binary', 'text'].includes(family) ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 3600000
    )
      invalid()
    await schema(k)
    const row = Object.freeze({ id: randomBytes(16).toString('hex'), family, sha256, expiresAt }),
      lifetime = new Brc38NativePreparedFieldLifetime(issuer, origin.token, row)
    await k(nativePreparedFieldsTable).insert(row)
    await lifetime.check(k, signal)
    return lifetime
  }
  async check(k: Knex.Transaction, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (
      this.#released ||
      Date.now() >= this.#row.expiresAt ||
      performance.now() >= this.#deadline ||
      identity(k).token !== this.#origin
    )
      invalid()
    await schema(k)
    const actual = (await k(nativePreparedFieldsTable)
      .where({ id: this.#row.id })
      .first('id', 'family', 'sha256', 'expiresAt')) as Lifetime | undefined
    if (
      !matches(actual, this.#row) ||
      this.#released ||
      Date.now() >= this.#row.expiresAt ||
      performance.now() >= this.#deadline ||
      identity(k).token !== this.#origin
    )
      invalid()
    signal?.throwIfAborted()
  }
  /** Cleanup may run after this lease expires. It still requires the ORIGINAL
   * live native producer and exact current schema/lease identity. Released
   * instances cannot be used again even if the surrounding writer rolls back;
   * cleanup itself remains idempotently retryable until its transaction commits.
   * Persistent chunks remain charged until finite provider GC drains them. */
  async release(k: Knex.Transaction): Promise<void> {
    requireBrc38PackedWriter(k)
    if (identity(k).token !== this.#origin) invalid()
    this.#released = true
    await schema(k)
    const actual = (await k(nativePreparedFieldsTable)
      .where({ id: this.#row.id })
      .first('id', 'family', 'sha256', 'expiresAt')) as Lifetime | undefined
    if (actual === undefined) return
    if (!matches(actual, this.#row) || (await k(nativePreparedFieldsTable).where(this.#row).delete()) !== 1) invalid()
    if (
      (await k(nativePreparedFieldsTable).where({ id: this.#row.id }).first('id')) !== undefined ||
      identity(k).token !== this.#origin
    )
      invalid()
  }
}
/** One finite expiry-retirement page in an actual owned writer. The persisted
 * deadlines are DATA for cleanup only; deleting them cannot admit a semantic
 * effect. Every field actor retains its own original monotone deadline too. */
export async function retireExpiredBrc38NativePreparedFields(
  k: Knex.Transaction,
  maximumRows: number,
  signal?: AbortSignal
): Promise<Readonly<{ retired: number; complete: boolean }>> {
  signal?.throwIfAborted()
  requireBrc38PackedWriter(k)
  identity(k)
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 32) invalid()
  if (!(await hasBrc38NativePreparedFieldsSchema(k))) return Object.freeze({ retired: 0, complete: true })
  await schema(k)
  const now = Date.now(),
    rows = (await k(nativePreparedFieldsTable)
      .where('expiresAt', '<=', now)
      .select('id', 'family', 'sha256', 'expiresAt')
      .orderBy('expiresAt')
      .orderBy('id')
      .limit(maximumRows)) as Lifetime[]
  for (const row of rows) {
    signal?.throwIfAborted()
    requireBrc38PackedWriter(k)
    identity(k)
    if (
      !/^[0-9a-f]{32}$/.test(row.id) ||
      !['binary', 'text'].includes(row.family) ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      !Number.isSafeInteger(row.expiresAt) ||
      row.expiresAt < 1 ||
      row.expiresAt > now ||
      (await k(nativePreparedFieldsTable).where(row).delete()) !== 1
    )
      invalid()
  }
  return Object.freeze({
    retired: rows.length,
    complete: (await k(nativePreparedFieldsTable).where('expiresAt', '<=', now).first('id')) === undefined
  })
}
