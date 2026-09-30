import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  canonicalOutputJSON,
  outputHex32,
  outputPacketDigest,
  OutputProtocolError,
  type OutputLookupOpen
} from '@bsv/sdk'
import type { SQLiteLookupBridge } from './SQLiteLookupBridge.js'
import type {
  LookupOpeningIdentity,
  LookupOriginalRequest,
  LookupSessionCapacity
} from './LookupSessionStorage.js'
import type {
  LookupSessionCodec,
  LookupSessionOpening,
  LookupSessionHeader
} from './LookupSessionCodec.js'
import { bytes, decimal, position } from './SQLiteLookupEncoding.js'

export interface LookupEpochRecord {
  epoch: string
  secret: string
  acceptsNew: boolean
}
export interface LookupOpeningFence {
  epoch: string
  key: string
  requestDigest: string
  manifestDigest: string
  principalKey: string
  session: string
  expiresAt: string
  replayUntil: string
  state: 'open' | 'closed' | 'expired'
}
export interface LookupSessionInventory {
  clock: string
  epochs: number
  guards: number
  fences: number
  sessions: number
  bytes: number
}

function retainedHex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new OutputProtocolError('reset-required', 'Invalid retained lookup identifier')
  return value
}

/** SQL record framing only. The owner supplies the surrounding write transaction. */
export class SQLiteLookupSessionRecords {
  constructor(
    readonly bridge: SQLiteLookupBridge,
    private readonly codec: LookupSessionCodec,
    private readonly configuration: string,
    private readonly capacity: Readonly<LookupSessionCapacity>
  ) {}

  digest(kind: string, ...fields: string[]): string {
    const hash = createHash('sha256')
    for (const field of ['output-lookup-session-record/1', this.bridge.namespace, kind, ...fields])
      hash.update(String(bytes(field)) + ':').update(field)
    return hash.digest('hex')
  }

  private keyed(epoch: LookupEpochRecord, kind: string, value: unknown): string {
    return createHmac('sha256', Buffer.from(epoch.secret, 'hex'))
      .update(canonicalOutputJSON({ namespace: this.bridge.namespace, kind, value }))
      .digest('hex')
  }

  metadata(): LookupSessionInventory {
    const row = this.bridge.database
      .prepare(
        `SELECT CASE WHEN length(CAST(configuration AS BLOB))<=65536 THEN configuration END AS configuration,
        CASE WHEN length(clock)=16 THEN clock END AS clock,
        epochs,guards,fences,sessions,payload_bytes FROM output_lookup_session_meta WHERE namespace=?`
      )
      .get(this.bridge.namespace)
    if (!row) throw new OutputProtocolError('reset-required', 'Lookup session namespace is missing')
    if (row.configuration !== this.configuration)
      throw new OutputProtocolError('context-changed', 'Lookup session configuration changed')
    const result = {
      epochs: row.epochs,
      guards: row.guards,
      fences: row.fences,
      sessions: row.sessions,
      bytes: row.payload_bytes
    }
    for (const key of Object.keys(result) as (keyof typeof result)[])
      if (
        !Number.isSafeInteger(result[key]) ||
        Number(result[key]) < 0 ||
        Number(result[key]) > this.capacity[key]
      )
        throw new OutputProtocolError('reset-required', 'Lookup session inventory is invalid')
    return { clock: decimal(row.clock), ...result } as LookupSessionInventory
  }

  verifyInventory(): void {
    const meta = this.metadata()
    const { database, namespace } = this.bridge
    const counts = [
      ['output_lookup_epochs', meta.epochs],
      ['output_lookup_guards', meta.guards],
      ['output_lookup_openings', meta.fences],
      ['output_lookup_sessions', meta.sessions]
    ] as const
    for (const [table, expected] of counts) {
      // Table names are a fixed local list, never request data.
      const row = database
        .prepare(`SELECT count(*) AS count FROM ${table} WHERE namespace=?`)
        .get(namespace)!
      if (row.count !== expected)
        throw new OutputProtocolError('reset-required', 'Lookup session inventory is incomplete')
    }
    const payload = database
      .prepare(
        'SELECT coalesce(sum(payload_bytes),0) AS bytes FROM output_lookup_sessions WHERE namespace=?'
      )
      .get(namespace)!
    if (payload.bytes !== meta.bytes)
      throw new OutputProtocolError(
        'reset-required',
        'Lookup session payload inventory is incomplete'
      )
  }

  epoch(id: string): LookupEpochRecord {
    outputHex32(id)
    const row = this.bridge.database
      .prepare(
        `SELECT
      CASE WHEN length(secret)=64 THEN secret END AS secret, accepts_new,
      CASE WHEN length(digest)=64 THEN digest END AS digest
      FROM output_lookup_epochs WHERE namespace=? AND epoch=?`
      )
      .get(this.bridge.namespace, id)
    if (
      !row ||
      typeof row.secret !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.secret) ||
      (row.accepts_new !== 0 && row.accepts_new !== 1) ||
      row.digest !== this.digest('epoch', id, row.secret, String(row.accepts_new))
    )
      throw new OutputProtocolError('reset-required', 'Lookup serving epoch is unavailable')
    return { epoch: id, secret: row.secret, acceptsNew: row.accepts_new === 1 }
  }

  createEpoch(): string {
    if (this.metadata().epochs >= this.capacity.epochs)
      throw new OutputProtocolError('limited', 'Lookup serving epoch capacity is full')
    const active = this.bridge.database
      .prepare('SELECT epoch FROM output_lookup_epochs WHERE namespace=? AND accepts_new=1')
      .all(this.bridge.namespace)
    for (const row of active) this.retireEpoch(this.epoch(retainedHex(row.epoch)))
    const epoch = randomBytes(32).toString('hex'),
      secret = randomBytes(32).toString('hex')
    this.bridge.database
      .prepare('INSERT INTO output_lookup_epochs VALUES (?,?,?,?,?)')
      .run(this.bridge.namespace, epoch, secret, 1, this.digest('epoch', epoch, secret, '1'))
    this.bridge.database
      .prepare('UPDATE output_lookup_session_meta SET epochs=epochs+1 WHERE namespace=?')
      .run(this.bridge.namespace)
    return epoch
  }

  retireEpoch(epoch: LookupEpochRecord): void {
    this.bridge.database
      .prepare(
        'UPDATE output_lookup_epochs SET accepts_new=0,digest=? WHERE namespace=? AND epoch=?'
      )
      .run(this.digest('epoch', epoch.epoch, epoch.secret, '0'), this.bridge.namespace, epoch.epoch)
  }

  collectEpoch(
    epoch: LookupEpochRecord,
    maximum: number,
    now: string
  ): { removed: number; complete: boolean } {
    if (epoch.acceptsNew)
      throw new OutputProtocolError(
        'conflict',
        'An accepted lookup epoch cannot lose its opening fences'
      )
    const { database, namespace } = this.bridge
    const promised = database
      .prepare(
        `SELECT 1 FROM output_lookup_openings AS opening
      LEFT JOIN output_lookup_sessions AS session ON session.namespace=opening.namespace AND session.session=opening.session
      WHERE opening.namespace=? AND opening.epoch=? AND (opening.replay_until>? OR session.session IS NOT NULL) LIMIT 1`
      )
      .get(namespace, epoch.epoch, position(now))
    if (promised)
      throw new OutputProtocolError(
        'unavailable',
        'Retired lookup epoch still retains replay promises or payloads'
      )
    const removed = Number(
      database
        .prepare(
          `DELETE FROM output_lookup_openings
      WHERE namespace=? AND epoch=? AND opening_key IN (
        SELECT opening_key FROM output_lookup_openings WHERE namespace=? AND epoch=? ORDER BY opening_key LIMIT ?)`
        )
        .run(namespace, epoch.epoch, namespace, epoch.epoch, maximum).changes
    )
    const complete = !database
      .prepare('SELECT 1 FROM output_lookup_openings WHERE namespace=? AND epoch=? LIMIT 1')
      .get(namespace, epoch.epoch)
    if (complete)
      database
        .prepare('DELETE FROM output_lookup_epochs WHERE namespace=? AND epoch=?')
        .run(namespace, epoch.epoch)
    database
      .prepare(
        'UPDATE output_lookup_session_meta SET fences=fences-?,epochs=epochs-? WHERE namespace=?'
      )
      .run(removed, complete ? 1 : 0, namespace)
    return { removed, complete }
  }

  openingKey(epoch: LookupEpochRecord, identity: LookupOpeningIdentity): string {
    return this.keyed(epoch, 'original-open', {
      service: identity.open.service,
      principal: identity.principal,
      requestId: identity.open.requestId
    })
  }

  originalEpoch(request: LookupOriginalRequest): LookupEpochRecord | null {
    this.verifyInventory()
    const rows = this.bridge.database
      .prepare('SELECT epoch FROM output_lookup_epochs WHERE namespace=? ORDER BY epoch')
      .all(this.bridge.namespace)
    for (const row of rows) {
      const epoch = this.epoch(retainedHex(row.epoch))
      const key = this.openingKey(epoch, { ...request, epoch: epoch.epoch })
      const fence = this.fence(epoch, key)
      if (fence?.manifestDigest === request.manifestDigest) return epoch
    }
    return null
  }

  requestDigest(epoch: LookupEpochRecord, open: OutputLookupOpen): string {
    return this.keyed(epoch, 'original-parameters', open)
  }

  principalKey(principal: string | null): string {
    // A quota partition only, never an authentication decision. Anonymous sessions
    // share one partition rather than bypassing the quota with new bearer IDs.
    return this.digest('principal-quota', canonicalOutputJSON(principal))
  }

  fence(epoch: LookupEpochRecord, key: string): LookupOpeningFence | null {
    const row = this.bridge.database
      .prepare(
        `SELECT
      CASE WHEN length(request_digest)=64 THEN request_digest END AS request_digest,
      CASE WHEN length(manifest_digest)=64 THEN manifest_digest END AS manifest_digest,
      CASE WHEN length(principal_key)=64 THEN principal_key END AS principal_key,
      CASE WHEN length(session)=64 THEN session END AS session,
      CASE WHEN length(expires_at)=16 THEN expires_at END AS expires_at,
      CASE WHEN length(replay_until)=16 THEN replay_until END AS replay_until,
      CASE WHEN length(state)<=7 THEN state END AS state,
      CASE WHEN length(digest)=64 THEN digest END AS digest
      FROM output_lookup_openings WHERE namespace=? AND epoch=? AND opening_key=?`
      )
      .get(this.bridge.namespace, epoch.epoch, key)
    if (!row) return null
    if (row.state !== 'open' && row.state !== 'closed' && row.state !== 'expired')
      throw new OutputProtocolError('reset-required', 'Invalid lookup opening fence')
    const fence: LookupOpeningFence = {
      epoch: epoch.epoch,
      key,
      requestDigest: retainedHex(row.request_digest),
      manifestDigest: retainedHex(row.manifest_digest),
      principalKey: retainedHex(row.principal_key),
      session: retainedHex(row.session),
      expiresAt: decimal(row.expires_at),
      replayUntil: decimal(row.replay_until),
      state: row.state
    }
    if (row.digest !== this.keyed(epoch, 'fence', fence))
      throw new OutputProtocolError('reset-required', 'Lookup opening fence integrity failed')
    return fence
  }

  bySession(session: string): { epoch: LookupEpochRecord; fence: LookupOpeningFence } | null {
    const row = this.bridge.database
      .prepare(
        `SELECT
      CASE WHEN length(epoch)=64 THEN epoch END AS epoch,
      CASE WHEN length(opening_key)=64 THEN opening_key END AS opening_key
      FROM output_lookup_openings WHERE namespace=? AND session=?`
      )
      .get(this.bridge.namespace, session)
    if (!row) return null
    const epoch = this.epoch(retainedHex(row.epoch))
    const fence = this.fence(epoch, retainedHex(row.opening_key))
    if (!fence || fence.session !== session)
      throw new OutputProtocolError('reset-required', 'Lookup session identity is incomplete')
    return { epoch, fence }
  }

  saveFence(epoch: LookupEpochRecord, fence: LookupOpeningFence): void {
    this.bridge.database
      .prepare(
        `INSERT INTO output_lookup_openings VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(namespace,epoch,opening_key) DO UPDATE SET state=excluded.state,digest=excluded.digest`
      )
      .run(
        this.bridge.namespace,
        fence.epoch,
        fence.key,
        fence.requestDigest,
        fence.manifestDigest,
        fence.principalKey,
        fence.session,
        position(fence.expiresAt),
        position(fence.replayUntil),
        fence.state,
        this.keyed(epoch, 'fence', fence)
      )
  }

  saveOpening(epoch: LookupEpochRecord, value: LookupSessionOpening): void {
    const columns = this.codec.encode(value)
    const header = this.codec.header(value)
    const headerJSON = canonicalOutputJSON(header, { bytes: 131072 })
    const total = Object.values(columns).reduce(
      (sum, column) => sum + bytes(column),
      bytes(headerJSON)
    )
    const meta = this.metadata()
    const principalKey = this.principalKey(value.principal)
    const principal = this.bridge.database
      .prepare(
        `SELECT count(*) AS count FROM output_lookup_openings AS opening
      INNER JOIN output_lookup_sessions AS session ON session.namespace=opening.namespace AND session.session=opening.session
      WHERE opening.namespace=? AND opening.principal_key=?`
      )
      .get(this.bridge.namespace, principalKey)!
    if (
      meta.fences >= this.capacity.fences ||
      meta.sessions >= this.capacity.sessions ||
      Number(principal.count) >= this.capacity.sessionsPerPrincipal ||
      meta.bytes + total > this.capacity.bytes
    )
      throw new OutputProtocolError('limited', 'Lookup original opening capacity is full')
    const manifestDigest = outputPacketDigest('capabilities', value.contract.manifest.body)
    const identity = {
      epoch: value.epoch,
      principal: value.principal,
      open: value.open,
      manifestDigest
    }
    const fence: LookupOpeningFence = {
      epoch: value.epoch,
      key: this.openingKey(epoch, identity),
      requestDigest: this.requestDigest(epoch, value.open),
      manifestDigest,
      principalKey,
      session: value.session,
      expiresAt: value.first.expiresAt,
      replayUntil: value.first.replayUntil,
      state: 'open'
    }
    this.saveFence(epoch, fence)
    this.bridge.database
      .prepare('INSERT INTO output_lookup_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        this.bridge.namespace,
        value.session,
        position(fence.replayUntil),
        columns.metadata,
        columns.open,
        columns.contract,
        columns.first,
        headerJSON,
        this.keyed(epoch, 'header', headerJSON),
        total,
        this.digest(
          'opening',
          value.session,
          columns.metadata,
          columns.open,
          columns.contract,
          columns.first,
          headerJSON
        )
      )
    this.bridge.database
      .prepare(
        `UPDATE output_lookup_session_meta
      SET fences=fences+1,sessions=sessions+1,payload_bytes=payload_bytes+? WHERE namespace=?`
      )
      .run(total, this.bridge.namespace)
  }

  header(epoch: LookupEpochRecord, fence: LookupOpeningFence): LookupSessionHeader {
    const row = this.bridge.database
      .prepare(
        `SELECT
      CASE WHEN length(CAST(header AS BLOB))<=131072 THEN header END AS header,
      CASE WHEN length(header_digest)=64 THEN header_digest END AS header_digest
      FROM output_lookup_sessions WHERE namespace=? AND session=?`
      )
      .get(this.bridge.namespace, fence.session)
    if (!row || typeof row.header !== 'string')
      throw new OutputProtocolError('reset-required', 'Lookup retained header is unavailable')
    if (row.header_digest !== this.keyed(epoch, 'header', row.header))
      throw new OutputProtocolError('reset-required', 'Lookup retained header integrity failed')
    const header = JSON.parse(row.header) as LookupSessionHeader
    // Only this owner creates the MAC, after full opening/contract validation.
    // Check it before interpreting any private retained authorization fields.
    if (
      header.epoch !== epoch.epoch ||
      header.session !== fence.session ||
      header.first.expiresAt !== fence.expiresAt ||
      header.first.replayUntil !== fence.replayUntil ||
      this.principalKey(header.principal) !== fence.principalKey
    )
      throw new OutputProtocolError('reset-required', 'Lookup retained header integrity failed')
    return header
  }

  opening(epoch: LookupEpochRecord, fence: LookupOpeningFence): LookupSessionOpening {
    const row = this.bridge.database
      .prepare(
        `SELECT
      CASE WHEN length(CAST(metadata AS BLOB))<=65536 THEN metadata END AS metadata,
      CASE WHEN length(CAST(original_open AS BLOB))<=1048576 THEN original_open END AS original_open,
      CASE WHEN length(CAST(contract AS BLOB))<=524288 THEN contract END AS contract,
      CASE WHEN length(CAST(first_batch AS BLOB))<=4194304 THEN first_batch END AS first_batch,
      CASE WHEN length(CAST(header AS BLOB))<=131072 THEN header END AS header,
      CASE WHEN length(replay_until)=16 THEN replay_until END AS replay_until,
      payload_bytes, CASE WHEN length(digest)=64 THEN digest END AS digest
      FROM output_lookup_sessions WHERE namespace=? AND session=?`
      )
      .get(this.bridge.namespace, fence.session)
    if (
      !row ||
      typeof row.metadata !== 'string' ||
      typeof row.original_open !== 'string' ||
      typeof row.contract !== 'string' ||
      typeof row.first_batch !== 'string' ||
      typeof row.header !== 'string'
    )
      throw new OutputProtocolError('reset-required', 'Lookup opening payload is unavailable')
    const columns = {
      metadata: row.metadata,
      open: row.original_open,
      contract: row.contract,
      first: row.first_batch
    }
    if (
      row.payload_bytes !==
        Object.values(columns).reduce((sum, column) => sum + bytes(column), bytes(row.header)) ||
      row.digest !==
        this.digest(
          'opening',
          fence.session,
          columns.metadata,
          columns.open,
          columns.contract,
          columns.first,
          row.header
        ) ||
      row.replay_until !== position(fence.replayUntil)
    )
      throw new OutputProtocolError('reset-required', 'Lookup opening payload integrity failed')
    const opening = this.codec.decode(columns)
    if (
      canonicalOutputJSON(this.codec.header(opening), { bytes: 131072 }) !== row.header ||
      canonicalOutputJSON(this.header(epoch, fence), { bytes: 131072 }) !== row.header
    )
      throw new OutputProtocolError(
        'reset-required',
        'Lookup retained header changed its original opening'
      )
    const identity = {
      epoch: opening.epoch,
      principal: opening.principal,
      open: opening.open,
      manifestDigest: fence.manifestDigest
    }
    if (
      opening.epoch !== epoch.epoch ||
      opening.session !== fence.session ||
      opening.first.expiresAt !== fence.expiresAt ||
      opening.first.replayUntil !== fence.replayUntil ||
      this.principalKey(opening.principal) !== fence.principalKey ||
      this.openingKey(epoch, identity) !== fence.key ||
      this.requestDigest(epoch, opening.open) !== fence.requestDigest ||
      outputPacketDigest('capabilities', opening.contract.manifest.body) !== fence.manifestDigest
    )
      throw new OutputProtocolError('reset-required', 'Lookup opening lost its original binding')
    return opening
  }
}
