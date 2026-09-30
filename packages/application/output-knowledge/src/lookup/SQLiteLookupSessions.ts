import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputLookupBatch,
  parseOutputLookupOpen,
  type OutputLookupBatch
} from '@bsv/sdk'
import { synchronousPromise } from '../internal/synchronousPromise.js'
import { sqliteLookupBridge, type SQLiteLookupBridge } from './SQLiteLookupBridge.js'
import type { SQLiteLookupIndex } from './SQLiteLookupIndex.js'
import {
  LookupSessionCodec,
  normalizeLookupDisclosureGuards,
  type LookupSessionOpening,
  type LookupSessionHeader
} from './LookupSessionCodec.js'
import type {
  LookupOpeningIdentity,
  LookupOriginalRequest,
  LookupDisclosureState,
  LookupSessionAuthorization,
  LookupSessionCapacity,
  LookupSessionStorage
} from './LookupSessionStorage.js'
import {
  initializeLookupSessions,
  lookupSessionCapacity,
  sessionConfiguration
} from './SQLiteLookupSessionSchema.js'
import {
  SQLiteLookupSessionRecords,
  type LookupEpochRecord,
  type LookupOpeningFence
} from './SQLiteLookupSessionRecords.js'
import { SQLiteLookupDisclosure } from './SQLiteLookupDisclosure.js'
import { prepareLookupStatement, decimal, position } from './SQLiteLookupEncoding.js'
import { LookupCursorCodec } from './LookupCursorCodec.js'

function principal(value: unknown): string | null {
  return value === null ? null : outputIdentity(value)
}
function identity(value: LookupOpeningIdentity): LookupOpeningIdentity {
  closedOutputObject(value, ['epoch', 'principal', 'open', 'manifestDigest'])
  return {
    epoch: outputHex32(value.epoch),
    principal: principal(value.principal),
    open: parseOutputLookupOpen(value.open),
    manifestDigest: outputHex32(value.manifestDigest)
  }
}
function authorization(value: LookupSessionAuthorization): LookupSessionAuthorization {
  closedOutputObject(value, ['principal', 'access', 'guards'])
  return {
    principal: principal(value.principal),
    access: outputString(value.access),
    guards: normalizeLookupDisclosureGuards(value.guards)
  }
}

function workBound(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024)
    throw new OutputProtocolError('invalid', 'Invalid lookup session compaction bound')
}

/**
 * Node-only durable session companion sharing the index's actual connection and
 * transaction. The trusted clock returns Unix seconds and is sampled after the
 * write lock is acquired. Current authorization is supplied by the service, with
 * persisted guards checked again in the final synchronous response gate.
 * Neither this private store nor an index alone advertises BRC-193.
 */
export class SQLiteLookupSessions implements LookupSessionStorage {
  readonly durability = 'durable' as const
  readonly capacity: Readonly<LookupSessionCapacity>
  private readonly bridge: SQLiteLookupBridge
  private readonly records: SQLiteLookupSessionRecords
  private readonly disclosure: SQLiteLookupDisclosure

  private constructor(
    index: SQLiteLookupIndex,
    private readonly codec: LookupSessionCodec,
    private readonly clock: () => string,
    options: Partial<LookupSessionCapacity>,
    initialize: boolean
  ) {
    this.bridge = index[sqliteLookupBridge]()
    this.capacity = lookupSessionCapacity(options)
    const configuration = sessionConfiguration(this.capacity)
    if (initialize) initializeLookupSessions(this.bridge, configuration)
    this.records = new SQLiteLookupSessionRecords(this.bridge, codec, configuration, this.capacity)
    this.disclosure = new SQLiteLookupDisclosure(this.records, this.capacity)
    this.bridge.transaction(() => this.records.verifyInventory())
  }

  static create(
    index: SQLiteLookupIndex,
    codec: LookupSessionCodec,
    clock: () => string,
    capacity: Partial<LookupSessionCapacity> = {}
  ): SQLiteLookupSessions {
    return new SQLiteLookupSessions(index, codec, clock, capacity, true)
  }
  static open(
    index: SQLiteLookupIndex,
    codec: LookupSessionCodec,
    clock: () => string,
    capacity: Partial<LookupSessionCapacity> = {}
  ): SQLiteLookupSessions {
    return new SQLiteLookupSessions(index, codec, clock, capacity, false)
  }

  /** Failed operations roll back their work, but not a successfully observed clock. */
  private run<T>(work: (now: string, sample: () => string) => T): T {
    const result = this.bridge.transaction(() => {
      let latest = this.records.metadata().clock
      const head = this.bridge.head()
      const sample = (): string => {
        const current = outputU64(this.clock()).toString()
        if (
          outputU64(current) < outputU64(latest) ||
          outputU64(current) < outputU64(head.recordedAt) ||
          outputU64(current) < outputU64(head.retention.checkedAt)
        )
          throw new OutputProtocolError('context-changed', 'Lookup session clock moved backwards')
        latest = current
        return current
      }
      const now = sample()
      this.bridge.database.exec('SAVEPOINT lookup_session_work')
      let outcome: { ok: true; value: T } | { ok: false; error: unknown }
      try {
        const value = work(now, sample)
        this.bridge.database.exec('RELEASE lookup_session_work')
        outcome = { ok: true, value }
      } catch (error) {
        this.bridge.database.exec('ROLLBACK TO lookup_session_work; RELEASE lookup_session_work')
        outcome = { ok: false, error }
      }
      prepareLookupStatement(
        this.bridge.database,
        'UPDATE output_lookup_session_meta SET clock=? WHERE namespace=?'
      ).run(position(latest), this.bridge.namespace)
      return outcome
    })
    if (!result.ok) throw result.error
    return result.value
  }

  createEpoch(): Promise<string> {
    return synchronousPromise(() =>
      this.run(() => {
        this.records.verifyInventory()
        return this.records.createEpoch()
      })
    )
  }
  retireEpoch(epoch: string): Promise<void> {
    return synchronousPromise(() =>
      this.run(() => this.records.retireEpoch(this.records.epoch(epoch)))
    )
  }

  collectEpoch(
    epoch: string,
    maximumFences: number
  ): Promise<{ removed: number; complete: boolean }> {
    return synchronousPromise(() => {
      workBound(maximumFences)
      return this.run(now => {
        this.records.verifyInventory()
        return this.records.collectEpoch(this.records.epoch(epoch), maximumFences, now)
      })
    })
  }

  initializeGuard(id: string): Promise<string> {
    return synchronousPromise(() =>
      this.run(() => {
        this.records.verifyInventory()
        return this.disclosure.initialize(id)
      })
    )
  }
  guard(id: string): Promise<string> {
    return synchronousPromise(() => this.run(() => this.disclosure.guard(id)))
  }
  guardState(id: string): Promise<LookupDisclosureState> {
    return synchronousPromise(() => this.run(() => this.disclosure.state(id)))
  }
  advanceGuard(id: string, expected: string): Promise<string> {
    return synchronousPromise(() => this.run(() => this.disclosure.advance(id, expected)))
  }
  blockGuard(id: string, expected: string, operation: string): Promise<string> {
    return synchronousPromise(() =>
      this.run(() => this.disclosure.transition(id, expected, operation, true))
    )
  }
  releaseGuard(id: string, expected: string, operation: string): Promise<string> {
    return synchronousPromise(() =>
      this.run(() => this.disclosure.transition(id, expected, operation, false))
    )
  }

  private recovered(
    value: LookupOpeningIdentity,
    epoch: LookupEpochRecord,
    now: string
  ): LookupSessionOpening | null {
    const fence = this.records.fence(epoch, this.records.openingKey(epoch, value))
    if (!fence) {
      // Absence is usable only while the complete permanent-fence inventory is
      // present. Losing a fence must never create a second original snapshot.
      this.records.verifyInventory()
      if (!epoch.acceptsNew)
        throw new OutputProtocolError('reset-required', 'Lookup serving epoch is retired')
      return null
    }
    if (fence.requestDigest !== this.records.requestDigest(epoch, value.open))
      throw new OutputProtocolError('conflict', 'Original lookup Open parameters changed')
    if (fence.manifestDigest !== value.manifestDigest)
      throw new OutputProtocolError('context-changed', 'Original lookup selection changed')
    this.live(fence, now, 'expired')
    const opening = this.records.opening(epoch, fence)
    this.requirePin(opening)
    this.disclosure.check(opening.guards)
    return opening
  }

  recover(input: LookupOpeningIdentity): Promise<LookupSessionOpening | null> {
    return synchronousPromise(() => {
      const value = identity(input)
      return this.run(now => this.recovered(value, this.records.epoch(value.epoch), now))
    })
  }

  recoverOriginal(input: LookupOriginalRequest): Promise<LookupSessionOpening | null> {
    return synchronousPromise(() => {
      closedOutputObject(input, ['principal', 'open', 'manifestDigest'])
      const value = {
        principal: principal(input.principal),
        open: parseOutputLookupOpen(input.open),
        manifestDigest: outputHex32(input.manifestDigest)
      }
      return this.run(now => {
        const epoch = this.records.originalEpoch(value)
        return epoch === null ? null : this.recovered({ ...value, epoch: epoch.epoch }, epoch, now)
      })
    })
  }

  commit(input: LookupSessionOpening): Promise<LookupSessionOpening> {
    return synchronousPromise(() => {
      const value = this.codec.normalize(input)
      const original: LookupOpeningIdentity = {
        epoch: value.epoch,
        principal: value.principal,
        open: value.open,
        manifestDigest: outputPacketDigest('capabilities', value.contract.manifest.body)
      }
      return this.run(now => {
        const epoch = this.records.epoch(value.epoch)
        const existing = this.recovered(original, epoch, now)
        if (existing) return existing
        const head = this.bridge.head()
        if (
          outputU64(value.time) > outputU64(now) ||
          outputU64(value.time) > outputU64(head.processedThrough)
        )
          throw new OutputProtocolError('unavailable', 'Lookup opening time is not fully processed')
        if (
          outputU64(now) >= outputU64(value.first.expiresAt) ||
          outputU64(now) >= outputU64(value.first.replayUntil)
        )
          throw new OutputProtocolError('expired', 'Lookup opening expired before its commit')
        this.disclosure.check(value.guards)
        this.bridge.retainSnapshot(this.pinKey(value), value.watermark, value.first.replayUntil)
        this.records.saveOpening(epoch, value)
        return value
      })
    })
  }

  private live(fence: LookupOpeningFence, now: string, expiry: 'expired' | 'reset-required'): void {
    if (fence.state === 'closed')
      throw new OutputProtocolError('expired', 'Lookup session is closed')
    if (
      fence.state === 'expired' ||
      outputU64(now) >= outputU64(fence.expiresAt) ||
      outputU64(now) >= outputU64(fence.replayUntil)
    )
      throw new OutputProtocolError(expiry, 'Lookup session expired')
  }

  private pinKey(opening: Pick<LookupSessionHeader, 'epoch' | 'session'>): string {
    return this.records.digest('session-pin', opening.epoch, opening.session)
  }
  private requirePin(
    opening: Pick<LookupSessionHeader, 'epoch' | 'session' | 'watermark' | 'first'>
  ): void {
    const row = prepareLookupStatement(
      this.bridge.database,
      `SELECT
      CASE WHEN length(watermark)=16 THEN watermark END AS watermark,
      CASE WHEN length(replay_until)=16 THEN replay_until END AS replay_until
      FROM output_lookup_pins WHERE namespace=? AND pin_key=?`
    ).get(this.bridge.namespace, this.pinKey(opening))
    const head = this.bridge.head()
    if (
      row?.watermark !== position(opening.watermark) ||
      row.replay_until !== position(opening.first.replayUntil) ||
      outputU64(head.retention.floor) > outputU64(opening.watermark)
    )
      throw new OutputProtocolError('reset-required', 'Lookup session lost its promised history')
  }

  private readSession(id: string, who: string | null, now: string): LookupSessionOpening {
    const saved = this.records.bySession(id)
    if (saved?.fence.principalKey !== this.records.principalKey(who))
      throw new OutputProtocolError('reset-required', 'Lookup session is unavailable')
    this.live(saved.fence, now, 'reset-required')
    const opening = this.records.opening(saved.epoch, saved.fence)
    this.requirePin(opening)
    this.disclosure.check(opening.guards)
    return opening
  }
  private readHeader(id: string, who: string | null, now: string): LookupSessionHeader {
    const saved = this.records.bySession(id)
    if (saved?.fence.principalKey !== this.records.principalKey(who))
      throw new OutputProtocolError('reset-required', 'Lookup session is unavailable')
    this.live(saved.fence, now, 'reset-required')
    const header = this.records.header(saved.epoch, saved.fence)
    this.requirePin(header)
    this.disclosure.check(header.guards)
    return header
  }
  session(id: string, who: string | null): Promise<LookupSessionOpening> {
    return synchronousPromise(() => {
      outputString(id)
      const owned = principal(who)
      return this.run(now => this.readSession(id, owned, now))
    })
  }

  serialize(
    id: string,
    input: LookupSessionAuthorization,
    inputBatch: OutputLookupBatch
  ): Promise<string> {
    return synchronousPromise(() => {
      outputString(id)
      const auth = authorization(input)
      const batch = parseOutputLookupBatch(inputBatch)
      return this.run((now, sample) => {
        const opening = this.readHeader(id, auth.principal, now)
        this.disclosure.authorize(opening, auth)
        this.checkResponse(opening, batch)
        const finalTime = outputU64(sample())
        if (
          finalTime >= outputU64(opening.first.expiresAt) ||
          finalTime >= outputU64(opening.first.replayUntil)
        )
          throw new OutputProtocolError(
            'reset-required',
            'Lookup session expired before serialization'
          )
        // No await/callback between the durable authorization gate and complete
        // body serialization. A later Close may not retract this earlier gate.
        return canonicalOutputJSON(batch, { bytes: batch.limits.maxBytes })
      })
    })
  }

  private checkResponse(opening: LookupSessionHeader, batch: OutputLookupBatch): void {
    if (
      batch.session !== opening.session ||
      batch.expiresAt !== opening.first.expiresAt ||
      batch.replayUntil !== opening.first.replayUntil ||
      canonicalOutputJSON(batch.scope) !== canonicalOutputJSON(opening.first.scope)
    )
      throw new OutputProtocolError('context-changed', 'Lookup response changed its retained scope')
    for (const key of ['maxBytes', 'maxObservations', 'waitMs'] as const)
      if (batch.limits[key] > opening.maximums[key])
        throw new OutputProtocolError(
          'context-changed',
          'Lookup response exceeds its original selected limits'
        )
    if (outputU64(batch.highWater) > outputU64(this.bridge.head().sequence))
      throw new OutputProtocolError(
        'context-changed',
        'Lookup response is ahead of the committed index'
      )
    const cursor = new LookupCursorCodec(opening.secret, opening.session, opening.epoch).open(
      batch.cursor
    )
    if (
      (cursor.phase === 'snapshot' && cursor.watermark !== opening.watermark) ||
      (cursor.phase === 'live' && cursor.through !== batch.through)
    )
      throw new OutputProtocolError(
        'context-changed',
        'Lookup response changed its cursor boundary'
      )
    if (
      batch.phase === 'snapshot' &&
      (batch.through !== opening.watermark || batch.snapshotComplete !== (cursor.phase === 'live'))
    )
      throw new OutputProtocolError(
        'context-changed',
        'Lookup response changed its snapshot boundary'
      )
    if (
      batch.phase === 'live' &&
      (cursor.phase !== 'live' || outputU64(batch.through) < outputU64(opening.watermark))
    )
      throw new OutputProtocolError(
        'context-changed',
        'Lookup live response regressed before its snapshot'
      )
  }

  closeSession(
    id: string,
    input: LookupSessionAuthorization | null
  ): Promise<{ version: 1; closed: true }> {
    return synchronousPromise(() => {
      outputString(id)
      const auth = input === null ? null : authorization(input)
      return this.run(now => {
        const saved = this.records.bySession(id)
        if (
          saved &&
          auth &&
          saved.fence.state === 'open' &&
          outputU64(now) < outputU64(saved.fence.expiresAt) &&
          saved.fence.principalKey === this.records.principalKey(auth.principal)
        ) {
          const opening = this.records.header(saved.epoch, saved.fence)
          try {
            this.disclosure.authorize(opening, auth)
            this.records.saveFence(saved.epoch, { ...saved.fence, state: 'closed' })
          } catch (error) {
            if (
              !(error instanceof OutputProtocolError) ||
              !['unauthorized', 'reset-required'].includes(error.code)
            )
              throw error
          }
        }
        return { version: 1 as const, closed: true as const }
      })
    })
  }

  compact(maximumSessions: number): Promise<number> {
    return synchronousPromise(() => {
      workBound(maximumSessions)
      return this.run(now => {
        this.records.verifyInventory()
        const rows = prepareLookupStatement(
          this.bridge.database,
          `SELECT session,payload_bytes,replay_until FROM output_lookup_sessions
          WHERE namespace=? AND replay_until<=? ORDER BY replay_until,session LIMIT ?`
        ).all(this.bridge.namespace, position(now), maximumSessions)
        for (const row of rows)
          this.compactSession(
            outputHex32(row.session),
            decimal(row.replay_until),
            Number(row.payload_bytes),
            now
          )
        return rows.length
      })
    })
  }

  private compactSession(id: string, replayUntil: string, size: number, now: string): void {
    const saved = this.records.bySession(id)
    if (
      replayUntil !== saved?.fence.replayUntil ||
      outputU64(now) < outputU64(saved.fence.replayUntil) ||
      !Number.isSafeInteger(size) ||
      size < 1
    )
      throw new OutputProtocolError(
        'reset-required',
        'Lookup session compaction lost its original fence'
      )
    this.records.saveFence(saved.epoch, { ...saved.fence, state: 'expired' })
    prepareLookupStatement(
      this.bridge.database,
      'DELETE FROM output_lookup_sessions WHERE namespace=? AND session=?'
    ).run(this.bridge.namespace, id)
    prepareLookupStatement(
      this.bridge.database,
      'UPDATE output_lookup_session_meta SET sessions=sessions-1,payload_bytes=payload_bytes-? WHERE namespace=?'
    ).run(size, this.bridge.namespace)
  }
}
