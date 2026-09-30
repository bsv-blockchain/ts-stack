import { closeSync, openSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  incrementOutputU64,
  outputAssert,
  outputHex32,
  outputU64,
  OutputProtocolError
} from '@bsv/sdk'
import type { RootEvictionConfiguration, RootEvictionHead } from './RootEvictionStorage.js'
import { rootConfiguration, rootDecimal, rootPosition } from './RootEvictionCodec.js'

/** Internal shared connection: every decision and final enqueue uses this same write lock. */
export class SQLiteRootEvictionDatabase {
  readonly configuration: ReturnType<typeof rootConfiguration>
  private readonly database: DatabaseSync
  private closed = false
  private active = false

  constructor(
    path: string,
    configuration: RootEvictionConfiguration,
    policy: string | undefined,
    upgradeCoordination = false
  ) {
    this.configuration = rootConfiguration(configuration)
    outputAssert(
      !upgradeCoordination ||
        (policy === undefined && this.configuration.coordination !== undefined),
      'Root coordination upgrade requires an existing journal and explicit configuration'
    )
    outputAssert(
      path.length > 0 && path !== ':memory:' && !path.startsWith('file:'),
      'Root journal requires a file'
    )
    if (policy !== undefined) {
      outputHex32(policy)
      // Explicit creation never adopts or truncates an existing identity.
      closeSync(openSync(path, 'ax', 0o600))
    } else closeSync(openSync(path, 'r+'))
    this.database = new DatabaseSync(path, {
      allowExtension: false,
      enableForeignKeyConstraints: true
    })
    try {
      this.database.exec(
        'PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
      )
      if (policy !== undefined) this.initialize(policy)
      if (upgradeCoordination) this.upgradeCoordination()
      this.transaction(() => {
        this.head()
        this.inventory()
      })
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  private initialize(policy: string): void {
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE root_meta (
        id INTEGER PRIMARY KEY CHECK(id=1), configuration TEXT NOT NULL,
        policy TEXT NOT NULL, revision TEXT NOT NULL
      ) STRICT;
      CREATE TABLE root_requests (
        digest TEXT PRIMARY KEY, requester TEXT NOT NULL, request_id TEXT NOT NULL,
        packet TEXT NOT NULL, policy TEXT NOT NULL, revision TEXT NOT NULL,
        bytes INTEGER NOT NULL, targets INTEGER NOT NULL,
        UNIQUE(requester,request_id)
      ) STRICT;
      CREATE TABLE root_actions (
        request_digest TEXT NOT NULL REFERENCES root_requests(digest), target_index INTEGER NOT NULL,
        action_status TEXT NOT NULL, reason TEXT NOT NULL, revision TEXT NOT NULL,
        decision TEXT, affected TEXT,
        PRIMARY KEY(request_digest,target_index)
      ) STRICT;
      CREATE TABLE root_bases (
        decision TEXT PRIMARY KEY, target_key TEXT NOT NULL, advertisement_digest TEXT NOT NULL,
        requester TEXT NOT NULL, request_digest TEXT NOT NULL REFERENCES root_requests(digest),
        policy TEXT NOT NULL, revision TEXT NOT NULL, lifted_by TEXT
      ) STRICT;
      CREATE INDEX root_active_bases ON root_bases(target_key,lifted_by,decision);
      CREATE TABLE root_views (
        target_key TEXT PRIMARY KEY, target TEXT NOT NULL, revision TEXT NOT NULL, projection_revision TEXT NOT NULL,
        eligible INTEGER NOT NULL CHECK(eligible IN (0,1)), ready INTEGER NOT NULL CHECK(ready IN (0,1))
      ) STRICT;
      CREATE TABLE root_projections (
        target_key TEXT PRIMARY KEY REFERENCES root_views(target_key), revision TEXT NOT NULL,
        membership TEXT NOT NULL CHECK(membership IN ('withdraw','include'))
      ) STRICT;
      CREATE TABLE root_assessments (
        operation_id TEXT PRIMARY KEY, semantic TEXT NOT NULL,
        policy TEXT NOT NULL, revision TEXT NOT NULL
      ) STRICT;
    `)
    if (this.configuration.coordination) this.createContracts()
    // The constructor owns cleanup. Closing the connection rolls back any
    // incomplete initialization, including failures while creating the schema.
    this.database
      .prepare('INSERT INTO root_meta VALUES (1,?,?,?)')
      .run(this.configuration.seal, policy, rootPosition('0'))
    this.database.exec('COMMIT')
  }

  private createContracts(): void {
    this.database.exec(`CREATE TABLE root_contracts (
      request_digest TEXT PRIMARY KEY REFERENCES root_requests(digest),
      selector TEXT NOT NULL, record TEXT NOT NULL, bytes INTEGER NOT NULL
    ) STRICT`)
  }

  /** Explicit, transactional format migration. Ordinary open never creates missing tables. */
  private upgradeCoordination(): void {
    const { root, chain, capacity } = this.configuration
    const original = rootConfiguration({ root, chain, capacity }).seal
    this.database.exec('BEGIN IMMEDIATE')
    this.active = true
    try {
      const row = this.get('SELECT configuration FROM root_meta WHERE id=1')
      outputAssert(
        row?.configuration === original || row?.configuration === this.configuration.seal,
        'Root coordination upgrade differs from the original journal configuration',
        'context-changed'
      )
      if (row.configuration === original) {
        this.createContracts()
        this.run('UPDATE root_meta SET configuration=? WHERE id=1', this.configuration.seal)
      }
      this.completionRevisions()
      this.inventory()
      this.database.exec('COMMIT')
    } catch (error) {
      // Constructor cleanup closes the connection and rolls back any still-open transaction.
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      this.active = false
    }
  }

  /** Call only from within transaction; SQL text is authored here, never provided by a peer. */
  get(sql: string, ...values: SQLInputValue[]): Record<string, unknown> | undefined {
    return this.statement(sql).get(...values)
  }
  all(sql: string, ...values: SQLInputValue[]): Record<string, unknown>[] {
    return this.statement(sql).all(...values)
  }
  run(sql: string, ...values: SQLInputValue[]): void {
    this.statement(sql).run(...values)
  }
  private statement(sql: string) {
    outputAssert(
      this.active && !this.closed,
      'Root journal operation requires its transaction',
      'unavailable'
    )
    outputAssert(sql.trim().length > 0, 'Root journal SQL is empty')
    return this.database.prepare(sql)
  }
  head(): RootEvictionHead {
    const row = this.get('SELECT configuration,policy,revision FROM root_meta WHERE id=1')
    outputAssert(
      row?.configuration === this.configuration.seal,
      'Root journal configuration changed',
      'context-changed'
    )
    return { policyDigest: outputHex32(row.policy), revision: rootDecimal(row.revision) }
  }
  advance(): string {
    const next = incrementOutputU64(this.head().revision)
    this.run('UPDATE root_meta SET revision=? WHERE id=1', rootPosition(next))
    return next
  }

  private inventory(): void {
    const row = this.get(
      'SELECT count(*) AS requests,coalesce(sum(bytes),0) AS bytes,coalesce(sum(targets),0) AS targets FROM root_requests'
    )!
    const capacity = this.configuration.capacity
    outputAssert(
      Number.isSafeInteger(row.requests) &&
        Number.isSafeInteger(row.bytes) &&
        Number.isSafeInteger(row.targets) &&
        Number(row.requests) <= capacity.requests &&
        Number(row.bytes) <= capacity.requestBytes &&
        Number(row.targets) <= capacity.targets &&
        Number(row.bytes) >= 0 &&
        Number(row.targets) >= 0,
      'Root journal exceeds its retained capacity',
      'unavailable'
    )
    outputAssert(
      this.all('PRAGMA foreign_key_check').length === 0,
      'Root journal reference integrity failed',
      'unavailable'
    )
    outputAssert(
      !this.get(
        `SELECT 1 FROM root_requests WHERE bytes!=length(CAST(packet AS BLOB)) OR bytes<1 OR bytes>1048576 OR targets<1 OR targets>64 LIMIT 1`
      ),
      'Root journal request accounting failed',
      'unavailable'
    )
    outputAssert(
      Number(this.get('SELECT count(*) AS n FROM root_views')!.n) <= capacity.targets &&
        Number(this.get('SELECT count(*) AS n FROM root_assessments')!.n) <= capacity.assessments,
      'Root serving history exceeds its capacity',
      'unavailable'
    )
    outputAssert(
      !this.get(
        `SELECT 1 FROM root_actions a JOIN root_requests r ON a.request_digest=r.digest WHERE a.target_index<0 OR a.target_index>=r.targets LIMIT 1`
      ),
      'Root journal target index failed',
      'unavailable'
    )
    outputAssert(
      !this.get(
        'SELECT target_key FROM root_bases WHERE lifted_by IS NULL GROUP BY target_key HAVING count(*)>? LIMIT 1',
        capacity.blockers
      ),
      'Root journal blocker capacity failed',
      'unavailable'
    )
    if (this.configuration.coordination) this.contractInventory()
  }

  private contractInventory(): void {
    const row = this.get(
      'SELECT count(*) AS records,coalesce(sum(bytes),0) AS bytes FROM root_contracts'
    )!
    outputAssert(
      Number.isSafeInteger(row.records) &&
        Number(row.records) <= this.configuration.capacity.requests &&
        Number.isSafeInteger(row.bytes) &&
        Number(row.bytes) >= 0 &&
        Number(row.bytes) <= this.configuration.coordination!.contractBytes,
      'Root original-contract capacity failed',
      'unavailable'
    )
    outputAssert(
      !this.get(`SELECT 1 FROM root_contracts WHERE bytes<1 OR bytes>524288
        OR bytes!=length(CAST(record AS BLOB)) OR length(selector)!=64 LIMIT 1`),
      'Root original-contract accounting failed',
      'unavailable'
    )
  }

  /**
   * BEGIN IMMEDIATE deliberately pairs final synchronous send-queue admission
   * with every writer, including writers in another process using this file.
   * No callback may await, schedule later writes, or enter another root method.
   */
  transaction<T>(work: () => T): T {
    outputAssert(!this.closed && !this.active, 'Root journal is closed or reentered', 'unavailable')
    outputAssert(
      work.constructor.name !== 'AsyncFunction',
      'Root journal callbacks must be synchronous'
    )
    try {
      this.database.exec('BEGIN IMMEDIATE')
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'errcode' in error &&
        (error.errcode === 5 || error.errcode === 6)
      )
        throw new OutputProtocolError('unavailable', 'Root journal is busy', true)
      throw error
    }
    this.active = true
    try {
      this.completionRevisions()
      const result = work()
      outputAssert(
        !(
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          'then' in result
        ),
        'Root journal callback returned asynchronous work'
      )
      this.completionRevisions()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // COMMIT may have completed before the driver reported an error. Do
        // not reuse an uncertain connection: reopen and recover the durable key.
        // This also avoids requiring DatabaseSync.isTransaction (Node 22.16+).
        this.closed = true
        this.database.close()
      }
      throw error
    } finally {
      this.active = false
    }
  }
  private completionRevisions(): void {
    const row = this.get(`SELECT
      (SELECT coalesce(sum(targets),0) FROM root_requests) - (SELECT count(*) FROM root_actions) AS pending,
      (SELECT count(*) FROM root_projections) AS projections`)!
    outputAssert(
      Number.isSafeInteger(row.pending) &&
        Number(row.pending) >= 0 &&
        Number.isSafeInteger(row.projections) &&
        Number(row.projections) >= 0,
      'Invalid root completion accounting',
      'unavailable'
    )
    // Every pending target can need a terminal decision and a later projection
    // acknowledgement. Existing intents also retain their own acknowledgement
    // slot. Ordinary local work cannot consume these held revision numbers.
    const held = 2n * BigInt(Number(row.pending)) + BigInt(Number(row.projections))
    outputAssert(
      outputU64(this.head().revision) + held <= 18446744073709551615n,
      'Root journal cannot reserve completion revisions',
      'limited'
    )
  }
  close(): void {
    outputAssert(!this.active, 'Cannot close root journal during its transaction', 'unavailable')
    if (!this.closed) {
      this.database.close()
      this.closed = true
    }
  }
}
