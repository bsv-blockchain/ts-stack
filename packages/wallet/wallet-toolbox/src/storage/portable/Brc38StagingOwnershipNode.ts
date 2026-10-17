import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import createKnex, { type Knex } from 'knex'
import { requirePrivatePath, createPrivateFile, closePrivateDescriptor } from './Brc38PrivateFilesystemNode'
import { join } from 'node:path'

const filename = 'brc38-owner.sqlite'
const protocol = 'brc38-private-owner/v1'
const ownerIssuer = Symbol('actual private staging owner factory')
const actualOwners = new WeakSet<Brc38StagingOwnershipNode>()
interface OwnerRow {
  slot: number
  protocol: string
  binding: string
  expiresAt: number
}
interface FileIdentity {
  dev: string
  ino: string
}
export type Brc38OwnerPurpose = 'resume' | 'cleanup'
function binding(value: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new TypeError('A fixed private import binding digest is required')
}
function deadline(value: number): void {
  const now = Date.now()
  if (!Number.isSafeInteger(value) || value <= now || value - now > 86400000)
    throw new RangeError('Private import ownership requires a fixed deadline within 24 hours')
}
async function privateDirectory(directory: string): Promise<void> {
  await requirePrivatePath(directory, true)
}
async function ownedFile(directory: string): Promise<FileIdentity> {
  const value = await requirePrivatePath(join(directory, filename), false)
  if (value.size > 16384n) throw new Error('Invalid private import ownership database')
  return { dev: value.dev.toString(), ino: value.ino.toString() }
}
function database(directory: string): Knex {
  return createKnex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, filename) },
    useNullAsDefault: true,
    acquireConnectionTimeout: 1000,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (
        connection: { exec: (sql: string) => unknown },
        done: (error: Error | null, value?: unknown) => void
      ) => {
        try {
          connection.exec(
            'PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA max_page_count=4;'
          )
          done(null, connection)
        } catch (cause) {
          done(cause instanceof Error ? cause : new Error('Private import owner connection setup failed'), connection)
        }
      }
    }
  })
}
async function cleanupFailure(db: Knex, connection: object | undefined, cause: unknown): Promise<never> {
  let released = false
  const cleanup = async () => {
    if (connection !== undefined && !released) {
      await db.client.releaseConnection(connection)
      released = true
    }
    await db.destroy()
  }
  try {
    await cleanup()
  } catch (error_) {
    throw new Brc38StagingCleanupError(
      [cause, error_],
      'Private import ownership claim and physical cleanup both failed',
      cleanup
    )
  }
  // Never unlink another possible claimant's file.
  throw cause
}

/** A separate private SQLite writer lock remains pinned across every commit to
 * the staging DB. A second process cannot claim it while this process holds it;
 * OS process exit releases the physical lock without a guessed PID/lease proof.
 * Standalone prospective component: stage reopen/admission/activation are not
 * implemented by this lock alone. No active wallet database is locked. */
export class Brc38StagingOwnershipNode {
  #retired = false
  #releasing = false
  #connectionReleased = false
  #gone = false
  readonly #identity: Readonly<FileIdentity>
  readonly #monotonicDeadline: number
  private constructor(
    private readonly db: Knex,
    private readonly connection: object,
    readonly directory: string,
    readonly binding: string,
    readonly expiresAt: number,
    readonly purpose: Brc38OwnerPurpose,
    identity: Readonly<FileIdentity>,
    issuer: typeof ownerIssuer,
    monotonicDeadline: number
  ) {
    if (issuer !== ownerIssuer) throw new Error('Private staging owner requires its actual factory')
    this.#identity = Object.freeze({ dev: identity.dev, ino: identity.ino })
    this.#monotonicDeadline = monotonicDeadline
    actualOwners.add(this)
  }
  static async create(directory: string, digest: string, expiresAt: number): Promise<Brc38StagingOwnershipNode> {
    const monotonicDeadline = performance.now() + Math.max(0, expiresAt - Date.now())
    binding(digest)
    deadline(expiresAt)
    await privateDirectory(directory)
    const file = await createPrivateFile(join(directory, filename))
    await closePrivateDescriptor(file)
    const before = await ownedFile(directory),
      db = database(directory)
    let connection: object | undefined
    try {
      await db.transaction(async trx => {
        await trx.schema.createTable('owner', table => {
          table.integer('slot').primary()
          table.string('protocol', 32).notNullable()
          table.string('binding', 64).notNullable()
          table.bigInteger('expiresAt').notNullable()
        })
        await trx('owner').insert({
          slot: 1,
          protocol,
          binding: digest,
          expiresAt
        })
      })
      connection = (await db.client.acquireConnection()) as object
      await db.raw('BEGIN IMMEDIATE').connection(connection)
      await Brc38StagingOwnershipNode.#verifyFile(directory, before)
      const owner = new Brc38StagingOwnershipNode(
        db,
        connection,
        directory,
        digest,
        expiresAt,
        'resume',
        before,
        ownerIssuer,
        monotonicDeadline
      )
      owner.assertLive()
      return owner
    } catch (cause) {
      return await cleanupFailure(db, connection, cause)
    }
  }
  /** Only a locked root catalog may grant incomplete-creation cleanup. Its
   * unpublished reservation excludes every creator before this lock is taken. */
  static async claimForCleanup(
    directory: string,
    expectedBinding: string,
    originalExpiry: number,
    incomplete: boolean
  ): Promise<Brc38StagingOwnershipNode> {
    if (!Number.isSafeInteger(originalExpiry) || originalExpiry < 1)
      throw new RangeError('Invalid original private import deadline')
    return await this.#claim(directory, expectedBinding, 'cleanup', {
      originalExpiry,
      incomplete
    })
  }
  static async claimExisting(
    directory: string,
    expectedBinding: string,
    purpose: Brc38OwnerPurpose = 'resume'
  ): Promise<Brc38StagingOwnershipNode> {
    return await this.#claim(directory, expectedBinding, purpose)
  }
  static async #claim(
    directory: string,
    expectedBinding: string,
    purpose: Brc38OwnerPurpose,
    creation?: { originalExpiry: number; incomplete: boolean }
  ): Promise<Brc38StagingOwnershipNode> {
    const began = performance.now(),
      wall = Date.now()
    binding(expectedBinding)
    if (purpose !== 'resume' && purpose !== 'cleanup') throw new TypeError('Invalid private ownership purpose')
    await privateDirectory(directory)
    const before = await ownedFile(directory),
      db = database(directory)
    let connection: object | undefined
    try {
      connection = (await db.client.acquireConnection()) as object
      await db.raw('BEGIN IMMEDIATE').connection(connection)
      await Brc38StagingOwnershipNode.#verifyFile(directory, before)
      const tables = (await db
        .raw("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'owner' LIMIT 1")
        .connection(connection)) as Array<{ name: string }>
      const row =
        tables.length === 0 ? undefined : await db<OwnerRow>('owner').where({ slot: 1 }).first().connection(connection)
      if (row === undefined && creation?.incomplete === true)
        return new Brc38StagingOwnershipNode(
          db,
          connection,
          directory,
          expectedBinding,
          creation.originalExpiry,
          'cleanup',
          before,
          ownerIssuer,
          began + Math.max(0, creation.originalExpiry - wall)
        )
      if (
        row === undefined ||
        row.protocol !== protocol ||
        row.binding !== expectedBinding ||
        !Number.isSafeInteger(row.expiresAt) ||
        row.expiresAt < 1 ||
        (creation !== undefined && row.expiresAt !== creation.originalExpiry)
      )
        throw new Error('Private import owner binding or metadata is invalid')
      const owner = new Brc38StagingOwnershipNode(
        db,
        connection,
        directory,
        row.binding,
        row.expiresAt,
        purpose,
        before,
        ownerIssuer,
        began + Math.max(0, row.expiresAt - wall)
      )
      if (purpose === 'resume') owner.assertLive()
      return owner
    } catch (cause) {
      return await cleanupFailure(db, connection, cause)
    }
  }
  static async #verifyFile(directory: string, before: FileIdentity): Promise<void> {
    const after = await ownedFile(directory)
    if (after.dev !== before.dev || after.ino !== before.ino)
      throw new Error('Private ownership file was replaced while acquiring its lock')
  }
  assertLive(): void {
    if (
      this.#retired ||
      this.#gone ||
      this.purpose !== 'resume' ||
      Date.now() >= this.expiresAt ||
      performance.now() >= this.#monotonicDeadline
    )
      throw new Error('Private import ownership is unavailable or expired')
  }
  /** Fresh actual source-only kernel claim, never native receiver authority.
   * The original driver connection must still hold its write transaction;
   * descriptor identity and current owner SQL are checked on every call. */
  async assertCurrentSource(directory: string, digest: string, expiresAt: number): Promise<void> {
    if (
      !actualOwners.has(this) ||
      directory !== this.directory ||
      digest !== this.binding ||
      expiresAt !== this.expiresAt
    )
      throw new Error('Structured source requires its actual private staging claim')
    this.assertLive()
    const connection = this.connection as { open?: boolean; inTransaction?: boolean; readonly?: boolean }
    if (connection.open !== true || connection.inTransaction !== true || connection.readonly !== false)
      throw new Error('Structured source lost its actual private kernel transaction')
    await privateDirectory(this.directory)
    await Brc38StagingOwnershipNode.#verifyFile(this.directory, this.#identity)
    const rows = (await this.db<OwnerRow>('owner')
      .where({ slot: 1 })
      .select(
        this.db.raw(
          "CASE WHEN typeof(protocol)='text' AND length(CAST(protocol AS BLOB))<=32 THEN protocol ELSE NULL END AS protocol"
        ),
        this.db.raw(
          "CASE WHEN typeof(binding)='text' AND length(CAST(binding AS BLOB))=64 THEN binding ELSE NULL END AS binding"
        ),
        this.db.raw("CASE WHEN typeof(expiresAt)='integer' THEN expiresAt ELSE NULL END AS expiresAt")
      )
      .limit(2)
      .connection(this.connection)) as unknown as Array<Readonly<Record<string, unknown>>>
    if (
      rows.length !== 1 ||
      rows[0].protocol !== protocol ||
      rows[0].binding !== digest ||
      rows[0].expiresAt !== expiresAt ||
      connection.open !== true ||
      connection.inTransaction !== true ||
      connection.readonly !== false
    )
      throw new Error('Structured source current kernel binding differs')
    this.assertLive()
  }
  async release(): Promise<void> {
    if (this.#gone) return
    if (this.#releasing) throw new Error('Private ownership teardown is already running')
    this.#retired = true
    this.#releasing = true
    try {
      // Caller must first await staging/source I/O and its SQL pool teardown.
      // Pool destruction closes the pinned raw transaction and physical lock.
      if (!this.#connectionReleased) {
        await this.db.client.releaseConnection(this.connection)
        this.#connectionReleased = true
      }
      await this.db.destroy()
      this.#gone = true
    } finally {
      this.#releasing = false
    }
  }
}
