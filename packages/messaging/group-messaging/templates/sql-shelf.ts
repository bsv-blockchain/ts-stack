/**
 * A `PrivateHalfShelf` that outlives the client.
 *
 * Source to copy into your host and own. It is not part of the package's API
 * and carries no compatibility promise.
 *
 * `MemoryShelf` in `managed-invitations.ts` lasts as long as the object holding
 * it, and its own doc comment says to replace it. The first real integration
 * did not, and rebuilt one per client open — so a relay change, a navigation
 * that re-keyed a cache, or a reset between `accept` and its Welcome dropped
 * the private half and the join became unrecoverable. The window is one relay
 * round trip wide, which is seconds, which is often.
 * `__tests__/host-lifecycle.test.ts` reproduces it.
 *
 * ## This writes key material to your database
 *
 * The half is an MLS private KeyPackage. The library never stores it — that is
 * invariant 1, and it holds — but a shelf that survives a restart necessarily
 * does, and that is a real trade against losing joins, not a free upgrade.
 * Before copying this in:
 *
 * - If your database is not already encrypted at rest, encrypt these two
 *   columns or put them in the platform keystore and keep only the pointer
 *   here. `half` is the one that matters; `keyPackage` is public.
 * - Call {@link SqlShelf.reap} on open. It bounds time since a half was last
 *   shelved, not since it was first answered: a join that fails is retried,
 *   and `managed-invitations` takes the record before re-shelving it, so that
 *   is a fresh row on a fresh clock. A half whose Welcome never came is
 *   waste, and key material you are still holding a year later is a liability.
 *   The default of a week is longer than any live exchange and short enough
 *   that nothing accumulates.
 * - Keep it out of backups and crash reports if those are not encrypted too.
 *
 * A host that cannot meet that should keep `MemoryShelf` and accept that an
 * interrupted accept is lost — which is a defensible choice, as long as it is
 * a choice. Tell the user the invitation needs accepting again rather than
 * leaving them with a chat that never arrives.
 *
 * ## What it still leaves to you
 *
 * - **Scoping.** One table serves one identity. If several accounts share a
 *   database, give each its own `tableName` or add an identity column; a half
 *   read under the wrong identity joins the wrong chat.
 * - **Decoding BLOBs.** If your driver returns a BLOB as a string, decode it
 *   there. This throws rather than guessing, because guessing wrong on the
 *   private half fails later, inside MLS, pointing nowhere near here.
 * - **Concurrency between processes.** `take` claims a record with the
 *   DELETE's `changes`, which is atomic within one SQLite connection. Two
 *   *processes* on one file are a different question; one client per identity
 *   per process (invariant 8) is what keeps that from arising.
 * - **Encryption**, as above. This stores what it is given.
 */
import type {
  KeyPackageBytes,
  KeyPackageRef,
  PrivateKeyPackageBytes,
  SqlDriver
} from '@bsv/group-messaging'
import type { PrivateHalfShelf, ShelvedInvitation } from './managed-invitations.js'

/** A week. Longer than any live exchange, short enough that nothing piles up. */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const DEFAULT_TABLE = 'group_messaging_private_halves'

/** Rejects anything that is not a bare identifier: the name is interpolated. */
const validName = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unusable table name: ${name}`)
  return name
}

interface Row {
  ref: string
  inviteId: string
  peer: string
  chatId: string
  /** Whatever the host's driver spells a BLOB as; `bytes` narrows it. */
  half: Uint8Array | ArrayBuffer | number[] | string
  keyPackage: Uint8Array | ArrayBuffer | number[] | string
}

export interface SqlShelfOptions {
  /** Override only to give a second identity its own table. */
  tableName?: string
  /** Defaults to `Date.now`. */
  now?: () => number
}

export class SqlShelf implements PrivateHalfShelf {
  readonly #driver: SqlDriver
  readonly #table: string
  readonly #now: () => number

  private constructor(driver: SqlDriver, table: string, now: () => number) {
    this.#driver = driver
    this.#table = table
    this.#now = now
  }

  /** Creates the table if it is missing. Call once per open. */
  static async open(driver: SqlDriver, options: SqlShelfOptions = {}): Promise<SqlShelf> {
    const table = validName(options.tableName ?? DEFAULT_TABLE)
    await driver.execAsync(
      `CREATE TABLE IF NOT EXISTS ${table} (
        ref TEXT PRIMARY KEY,
        inviteId TEXT NOT NULL,
        peer TEXT NOT NULL,
        chatId TEXT NOT NULL,
        half BLOB NOT NULL,
        keyPackage BLOB NOT NULL,
        heldAt INTEGER NOT NULL
      )`
    )
    await driver.execAsync(`CREATE INDEX IF NOT EXISTS idx_${table}_invite ON ${table}(inviteId)`)
    return new SqlShelf(driver, table, options.now ?? Date.now)
  }

  async hold(record: ShelvedInvitation): Promise<void> {
    // Upsert rather than insert: a repeated `hold` for one ref is a retry of
    // the same answer, not a second one, so it must not raise a constraint.
    // `heldAt` is deliberately NOT updated on that path — a retry is the same
    // shelving and should age on the original clock.
    //
    // A re-shelve after a failed join is a different thing: `managed-invitations`
    // takes the record before it retries, so that INSERT is a fresh row with a
    // fresh clock. That is correct — the half is actively being retried — but
    // it does mean `reap` bounds time since the last shelving, not time since
    // the first.
    await this.#driver.runAsync(
      `INSERT INTO ${this.#table}
        (ref, inviteId, peer, chatId, half, keyPackage, heldAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         inviteId = excluded.inviteId,
         peer = excluded.peer,
         chatId = excluded.chatId,
         half = excluded.half,
         keyPackage = excluded.keyPackage`,
      [
        record.ref,
        record.inviteId,
        record.peer,
        record.chatId,
        record.half,
        record.keyPackage,
        this.#now()
      ]
    )
  }

  async peek(ref: string): Promise<ShelvedInvitation | undefined> {
    return this.#one(`WHERE ref = ?`, [ref])
  }

  async forInvite(inviteId: string): Promise<ShelvedInvitation | undefined> {
    // Oldest first, as `MemoryShelf` does by insertion order. Without it the
    // row is whatever the query plan yields, and two shelves disagree.
    return this.#one(`WHERE inviteId = ? ORDER BY heldAt ASC, ref ASC`, [inviteId])
  }

  /**
   * Claim the record, or return nothing because someone else claimed it first.
   *
   * `MemoryShelf.take` is a `get` and a `delete` with no await between them, so
   * it is atomic by accident. A read-then-delete over SQL is not, and the
   * racing callers live inside a *single* client: `#retire` (from `decline` or
   * `abandon`) does `forInvite` then `take`, while an arriving Welcome does
   * `peek` then `take`. `managed-invitations.ts` guards accept against accept
   * and join against join, but nothing guards those two against each other — so
   * "one client per identity" is the wrong invariant to lean on here. Two
   * winners means the user declines and the chat is joined anyway.
   *
   * The DELETE decides. Its `changes` is the claim.
   */
  async take(ref: string): Promise<ShelvedInvitation | undefined> {
    const record = await this.peek(ref)
    if (record === undefined) return undefined
    const result = await this.#driver.runAsync(`DELETE FROM ${this.#table} WHERE ref = ?`, [ref])
    return result.changes === 1 ? record : undefined
  }

  /**
   * Drop halves older than `maxAgeMs`, and return how many went.
   *
   * A Welcome that has not arrived within a week is not going to. Until this
   * runs, every one of those rows is key material at rest.
   */
  async reap(maxAgeMs: number = DEFAULT_MAX_AGE_MS): Promise<number> {
    const result = await this.#driver.runAsync(`DELETE FROM ${this.#table} WHERE heldAt < ?`, [
      this.#now() - maxAgeMs
    ])
    return result.changes
  }

  async #one(where: string, params: string[]): Promise<ShelvedInvitation | undefined> {
    const row = await this.#driver.getFirstAsync<Row>(
      `SELECT ref, inviteId, peer, chatId, half, keyPackage FROM ${this.#table} ${where}`,
      params
    )
    if (row === null || row === undefined) return undefined
    return {
      ref: row.ref as KeyPackageRef,
      inviteId: row.inviteId,
      peer: row.peer,
      chatId: row.chatId,
      // Reading a brand back out of storage is the one place the cast is
      // unavoidable: a database column has no type beyond BLOB. Everything
      // between here and `hold` keeps it.
      half: bytes(row.half) as PrivateKeyPackageBytes,
      keyPackage: bytes(row.keyPackage) as KeyPackageBytes
    }
  }
}

/**
 * Drivers hand back `Uint8Array`, `Buffer`, `ArrayBuffer` or a plain array
 * depending on the host. A driver that hands back a *string* — base64, say —
 * would silently produce a zero-length key through `new Uint8Array(string)`,
 * and this is the private half, so it throws instead. The library's own
 * `toBytes` takes the same position.
 */
const bytes = (value: Uint8Array | ArrayBuffer | number[] | string): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return Uint8Array.from(value)
  if (typeof value === 'string') {
    throw new Error('Driver returned a BLOB as a string; decode it in your driver')
  }
  return new Uint8Array(value)
}
