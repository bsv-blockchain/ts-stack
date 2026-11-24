import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startLookupProcess } from './lookup-process-fixture.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHmac } from 'node:crypto'
import { SQLiteLookupSessionRecords } from '../src/lookup/SQLiteLookupSessionRecords.js'
import { sqliteLookupBridge } from '../src/lookup/SQLiteLookupBridge.js'
import {
  lookupSessionCapacity,
  sessionConfiguration
} from '../src/lookup/SQLiteLookupSessionSchema.js'
import {
  canonicalOutputJSON,
  outputPacketDigest,
  PrivateKey,
  retainOutputCapability,
  signOutputPacket,
  OutputProtocolError
} from '@bsv/sdk'
import { SQLiteLookupIndex } from '../src/lookup/SQLiteLookupIndex.js'
import {
  SQLiteLookupSessions,
  sqliteLookupSessionComposition
} from '../src/lookup/SQLiteLookupSessions.js'
import { LookupSessionCodec, type LookupSessionOpening } from '../src/lookup/LookupSessionCodec.js'
import { SQLiteLookupDisclosure } from '../src/lookup/SQLiteLookupDisclosure.js'
import { LookupCursorCodec } from '../src/lookup/LookupCursorCodec.js'
import type { LookupSessionCapacity } from '../src/lookup/LookupSessionStorage.js'
import { lookupSessionFixture } from './lookup-session-fixture.js'
import { liveFixture } from './live-lookup-fixture.js'

const processes = new Set<ChildProcess>()
const script = fileURLToPath(new URL('./fixtures/lookup-session-process.mjs', import.meta.url))
const stores: SQLiteLookupIndex[] = [],
  directories: string[] = []
const binding = { service: 'records', rules: 'test' }
const compact = { groups: 1024, versions: 1024, pins: 1024 }
const pages = { records: 10, bytes: 65536 }
const original = (value: LookupSessionOpening) => ({
  epoch: value.epoch,
  principal: value.principal,
  open: value.open,
  manifestDigest: outputPacketDigest('capabilities', value.contract.manifest.body)
})
const originalRequest = (value: LookupSessionOpening) => {
  const { principal, open, manifestDigest } = original(value)
  return { principal, open, manifestDigest }
}
const auth = (value: LookupSessionOpening) => ({
  principal: value.principal,
  access: value.access,
  guards: value.guards
})
function another(value: LookupSessionOpening, id = '02'): LookupSessionOpening {
  const clone = structuredClone(value)
  clone.open.requestId = id.repeat(32)
  clone.session = id.repeat(32)
  clone.first.session = clone.session
  clone.first.cursor = new LookupCursorCodec(clone.secret, clone.session, clone.epoch).seal({
    phase: 'live',
    through: clone.watermark
  })
  return clone
}
async function fixture(
  options: Partial<LookupSessionCapacity> = {},
  authentication: 'none' | 'brc103' = 'none'
) {
  const directory = await mkdtemp(join(tmpdir(), 'lookup-sessions-'))
  directories.push(directory)
  const path = join(directory, 'index.db')
  const index = SQLiteLookupIndex.create(path, 'records', binding)
  stores.push(index)
  const clock = { now: '1000' }
  const codec = new LookupSessionCodec(liveFixture({}, undefined, authentication).selection)
  const sessions = SQLiteLookupSessions.create(index, codec, () => clock.now, options)
  const epoch = await sessions.createEpoch()
  await sessions.initializeGuard('serving')
  await index.advanceTime('1000', 10)
  const { value } = lookupSessionFixture(authentication, epoch, '0')
  const peer = () => {
    const peerIndex = SQLiteLookupIndex.open(path, 'records', binding)
    stores.push(peerIndex)
    return {
      index: peerIndex,
      sessions: SQLiteLookupSessions.open(peerIndex, codec, () => clock.now, options)
    }
  }
  return { path, index, sessions, value, clock, codec, peer }
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(
    [...processes].map(
      child =>
        new Promise<void>(resolve => {
          child.once('exit', () => resolve())
          if (!child.kill('SIGKILL')) resolve()
        })
    )
  )
  processes.clear()
  for (const store of stores.splice(0)) await store.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('durable original lookup sessions', () => {
  it('commits and releases an actual SQL savepoint on the supported legacy bridge', async () => {
    const { index, codec, clock, value } = await fixture(),
      bridge = index[sqliteLookupBridge]()
    delete bridge.savepoint
    const sessions = SQLiteLookupSessions[sqliteLookupSessionComposition](
      bridge,
      codec,
      () => clock.now,
      {},
      false
    )
    const transaction = bridge.transaction
    bridge.transaction = work =>
      transaction(() => {
        const result = work()
        // Probe before the outer COMMIT can automatically release a leaked
        // nested savepoint. A successful operation must already have released it.
        expect(() => bridge.database.exec('ROLLBACK TO lookup_session_work')).toThrow(
          'no such savepoint'
        )
        return result
      })
    expect(await sessions.commit(value)).toEqual(value)
    expect(await sessions.session(value.session, null)).toEqual(value)
    expect((await index.head()).retained.pins).toBe(1)
  })

  it('rolls back rejected legacy SQL work while retaining its successfully observed clock', async () => {
    const { index, codec, clock, value, path } = await fixture(),
      bridge = index[sqliteLookupBridge]()
    delete bridge.savepoint
    const sessions = SQLiteLookupSessions[sqliteLookupSessionComposition](
      bridge,
      codec,
      () => clock.now,
      {},
      false
    )
    bridge.database.exec(
      "CREATE TRIGGER reject_legacy_open BEFORE INSERT ON output_lookup_sessions BEGIN SELECT RAISE(ABORT,'legacy opening failure'); END"
    )
    clock.now = '1001'
    await expect(sessions.commit(value)).rejects.toThrow('legacy opening failure')
    expect((await index.head()).retained.pins).toBe(0)
    bridge.database.exec('DROP TRIGGER reject_legacy_open')
    expect(await sessions.recover(original(value))).toBeNull()
    const reopened = SQLiteLookupIndex.open(path, 'records', binding)
    stores.push(reopened)
    const past = SQLiteLookupSessions.open(reopened, codec, () => '1000')
    await expect(past.createEpoch()).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Lookup session clock moved backwards'
    })
    expect(await sessions.commit(value)).toEqual(value)
  })

  it('recovers the original wire selector across manifest rotation and restart', async () => {
    const { sessions, value, peer, clock } = await fixture()
    const request = originalRequest(value)
    expect(await sessions.recoverOriginal(request)).toBeNull()
    await sessions.commit(value)
    await sessions.createEpoch()
    expect(await peer().sessions.recoverOriginal(request)).toEqual(value)
    await expect(
      sessions.recoverOriginal({ ...request, open: { ...request.open, query: { changed: true } } })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(
      await sessions.recoverOriginal({ ...request, manifestDigest: 'ff'.repeat(32) })
    ).toBeNull()
    clock.now = '1900'
    await sessions.compact(1)
    await expect(sessions.recoverOriginal(request)).rejects.toMatchObject({ code: 'expired' })
  })

  it('does not interpret a lost original opening fence as a fresh wire request', async () => {
    const { path, sessions, value } = await fixture()
    await sessions.commit(value)
    const request = originalRequest(value)
    const sql = new DatabaseSync(path)
    try {
      sql.exec('DELETE FROM output_lookup_sessions; DELETE FROM output_lookup_openings')
      await expect(sessions.recoverOriginal(request)).rejects.toMatchObject({
        code: 'reset-required'
      })
    } finally {
      sql.close()
    }
  })

  it.each(['before-payload', 'after-commit'])(
    'recovers the whole opening after process termination at %s',
    async stage => {
      const { path, index, value, peer } = await fixture()
      await index.close()
      const child = startLookupProcess(
        script,
        { path, binding, stage, opening: value, now: '1000' },
        processes
      )
      await child.started
      child.child.send('go')
      expect(await child.finished).toMatchObject({ signal: 'SIGKILL', timedOut: false })
      const recovered = peer()
      expect((await recovered.index.head()).retained.pins).toBe(stage === 'after-commit' ? 1 : 0)
      expect(await recovered.sessions.recover(original(value))).toEqual(
        stage === 'after-commit' ? value : null
      )
      expect(await recovered.sessions.commit(value)).toEqual(value)
      expect((await recovered.index.head()).retained.pins).toBe(1)
    }
  )

  it('chooses one exact original response across two actual writer processes', async () => {
    const { path, index, value, peer } = await fixture()
    const candidate = another(value)
    candidate.open = value.open
    await index.close()
    const contenders = [value, candidate].map(opening =>
      startLookupProcess(
        script,
        { path, binding, stage: 'normal', opening, now: '1000' },
        processes
      )
    )
    await Promise.all(contenders.map(child => child.started))
    for (const child of contenders) child.child.send('go')
    const exits = await Promise.all(contenders.map(child => child.finished))
    expect(exits.every(result => result.code === 0 && !result.timedOut)).toBe(true)
    const outcomes = contenders
      .flatMap(child => child.messages)
      .filter(message => message.status !== 'ready')
    expect(outcomes).toHaveLength(2)
    expect(outcomes.every(message => message.status === 'committed')).toBe(true)
    expect(new Set(outcomes.map(message => message.session)).size).toBe(1)
    const recovered = peer()
    const winner = await recovered.sessions.recover(original(value))
    expect(winner).toEqual(outcomes[0].session === value.session ? value : candidate)
    expect((await recovered.index.head()).retained.pins).toBe(1)
  })

  it('rolls back interrupted session compaction while retaining the original expired fence', async () => {
    const { path, index, sessions, value, clock, peer } = await fixture()
    await sessions.commit(value)
    await index.close()
    const child = startLookupProcess(
      script,
      { path, binding, stage: 'during-compaction', opening: value, now: '1900' },
      processes
    )
    await child.started
    child.child.send('go')
    expect(await child.finished).toMatchObject({ signal: 'SIGKILL', timedOut: false })
    clock.now = '1900'
    const recovered = peer()
    expect(await recovered.sessions.compact(1)).toBe(1)
    await expect(recovered.sessions.recover(original(value))).rejects.toMatchObject({
      code: 'expired'
    })
  })

  it('samples the authoritative time after waiting for a real cross-process write lock', async () => {
    const { path, sessions, value } = await fixture()
    await sessions.commit(value)
    const clockFile = path + '.clock'
    await writeFile(clockFile, '1299')
    const child = startLookupProcess(
      script,
      { path, binding, stage: 'serialize', opening: value, clockFile },
      processes
    )
    await child.started
    const locking = new Promise<void>(resolve =>
      child.child.on('message', message => {
        if ((message as { status: string }).status === 'locking') resolve()
      })
    )
    const sql = new DatabaseSync(path)
    try {
      sql.exec('BEGIN IMMEDIATE')
      child.child.send('go')
      await Promise.race([
        locking,
        child.finished.then(() => {
          throw new Error('Child exited before locking')
        })
      ])
      await writeFile(clockFile, '1300')
      sql.exec('COMMIT')
      expect(await child.finished).toMatchObject({ code: 0, timedOut: false })
      expect(child.messages.at(-1)).toMatchObject({ status: 'failed', code: 'reset-required' })
    } finally {
      sql.close()
    }
  })

  it('retains exact first bytes and the snapshot promise across later writes, reads and restart', async () => {
    const { index, sessions, value, peer, clock } = await fixture()
    expect(await sessions.recover(original(value))).toBeNull()
    const retained = await sessions.commit(value)
    retained.open.query = { changed: true }
    expect((await index.head()).retained.pins).toBe(1)
    await index.commit({
      base: '0',
      evaluatedAt: '1001',
      edits: [{ key: '01', previous: null, next: { data: {}, expiresAt: null } }],
      event: {}
    })
    clock.now = '1100'
    expect((await index.compact('1100', compact)).head.retention.floor).toBe('0')
    const live = {
      ...value.first,
      phase: 'live' as const,
      through: '1',
      highWater: '1',
      cursor: new LookupCursorCodec(value.secret, value.session, value.epoch).seal({
        phase: 'live',
        through: '1'
      })
    }
    expect(JSON.parse(await sessions.serialize(value.session, auth(value), live))).toEqual(live)
    const reopened = peer()
    expect(await reopened.sessions.recover(original(value))).toEqual(value)
    expect(await reopened.sessions.serialize(value.session, auth(value), value.first)).toBe(
      canonicalOutputJSON(value.first)
    )
  })

  it('returns the first winning opening when a concurrent candidate chose another session and snapshot', async () => {
    const { index, sessions, value, peer, clock } = await fixture()
    await sessions.commit(value)
    await index.commit({
      base: '0',
      evaluatedAt: '1001',
      edits: [{ key: '01', previous: null, next: { data: {}, expiresAt: null } }],
      event: {}
    })
    clock.now = '1001'
    const candidate = another(value)
    candidate.open = value.open
    candidate.time = candidate.contract.selectedAt = '1001'
    candidate.watermark = candidate.first.through = candidate.first.highWater = '1'
    candidate.first.expiresAt = '1301'
    candidate.first.replayUntil = '1901'
    candidate.first.cursor = new LookupCursorCodec(
      candidate.secret,
      candidate.session,
      candidate.epoch
    ).seal({ phase: 'live', through: '1' })
    expect(await peer().sessions.commit(candidate)).toEqual(value)
    expect((await index.head()).retained.pins).toBe(1)
    await expect(sessions.session(candidate.session, null)).rejects.toMatchObject({
      code: 'reset-required'
    })
  })

  it('preserves changed-parameter conflicts after Close, expiry, payload compaction and restart', async () => {
    const { index, sessions, value, peer, clock } = await fixture()
    await sessions.commit(value)
    const changed = original(value)
    changed.open = { ...value.open, query: { changed: true } }
    await expect(sessions.recover(changed)).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      sessions.recover({ ...original(value), manifestDigest: 'ff'.repeat(32) })
    ).rejects.toMatchObject({ code: 'context-changed' })
    await sessions.closeSession(value.session, auth(value))
    await expect(sessions.recover(original(value))).rejects.toMatchObject({ code: 'expired' })
    expect(await sessions.compact(1)).toBe(0)
    expect((await index.head()).retained.pins).toBe(1)
    clock.now = '1900'
    expect(await sessions.compact(1)).toBe(1)
    await index.compact('1900', compact)
    const reopened = peer().sessions
    await expect(reopened.recover(changed)).rejects.toMatchObject({ code: 'conflict' })
    await expect(reopened.recover(original(value))).rejects.toMatchObject({ code: 'expired' })
    await expect(reopened.commit(value)).rejects.toMatchObject({ code: 'expired' })
    expect(await reopened.closeSession(value.session, auth(value))).toEqual({
      version: 1,
      closed: true
    })
  })

  it('linearizes serialization and Close without disclosing inaccessible session existence', async () => {
    const { sessions, value, peer } = await fixture({}, 'brc103')
    await sessions.commit(value)
    const wrong = { ...auth(value), principal: new PrivateKey(3).toPublicKey().toString() }
    for (const [id, authority] of [
      [value.session, wrong],
      ['unknown', auth(value)],
      [value.session, null]
    ] as const)
      expect(await sessions.closeSession(id, authority)).toEqual({ version: 1, closed: true })
    const first = sessions.serialize(value.session, auth(value), value.first)
    await peer().sessions.closeSession(value.session, auth(value))
    expect(await first).toBe(canonicalOutputJSON(value.first))
    await expect(sessions.serialize(value.session, auth(value), value.first)).rejects.toMatchObject(
      { code: 'expired' }
    )
    await expect(sessions.session(value.session, wrong.principal)).rejects.toMatchObject({
      code: 'reset-required'
    })
  })

  it('rechecks expiry immediately before serialization and retains that later clock on failure', async () => {
    const { sessions, value, clock } = await fixture()
    await sessions.commit(value)
    let samples = 0
    Object.defineProperty(clock, 'now', {
      configurable: true,
      get: () => (++samples === 1 ? '1299' : '1300')
    })
    await expect(sessions.serialize(value.session, auth(value), value.first)).rejects.toMatchObject(
      { code: 'reset-required' }
    )
    expect(samples).toBe(2)
    Object.defineProperty(clock, 'now', { configurable: true, writable: true, value: '1299' })
    await expect(sessions.session(value.session, null)).rejects.toMatchObject({
      code: 'context-changed'
    })
  })

  it('allows Close using its checked small header even when first-response payload bytes are damaged', async () => {
    const { path, sessions, value } = await fixture()
    await sessions.commit(value)
    const sql = new DatabaseSync(path)
    try {
      sql.exec("UPDATE output_lookup_sessions SET first_batch='damaged'")
      await expect(sessions.recover(original(value))).rejects.toMatchObject({
        code: 'reset-required'
      })
      expect(await sessions.closeSession(value.session, auth(value))).toEqual({
        version: 1,
        closed: true
      })
      await expect(
        sessions.serialize(value.session, auth(value), value.first)
      ).rejects.toMatchObject({ code: 'expired' })
    } finally {
      sql.close()
    }
  })

  it('checks retained small-header integrity before using its access or guard fields', async () => {
    const { path, sessions, value } = await fixture()
    await sessions.commit(value)
    const sql = new DatabaseSync(path)
    try {
      sql.exec("UPDATE output_lookup_sessions SET header=json_set(header,'$.access','different')")
      await expect(
        sessions.serialize(value.session, auth(value), value.first)
      ).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup retained header integrity failed'
      })
      await expect(sessions.closeSession(value.session, auth(value))).rejects.toMatchObject({
        code: 'reset-required'
      })
    } finally {
      sql.close()
    }
  })

  it('expires at the fixed boundary and retains the observed clock even after an error', async () => {
    const { sessions, value, clock, peer } = await fixture()
    await sessions.commit(value)
    clock.now = '1299'
    await expect(sessions.session(value.session, null)).resolves.toEqual(value)
    clock.now = '1300'
    await expect(sessions.session(value.session, null)).rejects.toMatchObject({
      code: 'reset-required'
    })
    await expect(sessions.recover(original(value))).rejects.toMatchObject({ code: 'expired' })
    clock.now = '1299'
    await expect(peer().sessions.session(value.session, null)).rejects.toMatchObject({
      code: 'context-changed'
    })
  })

  it.each(['unauthorized', 'reset-required'] as const)(
    'gates candidate commit and historical disclosure on a changed %s premise',
    async failure => {
      const { index, sessions, value, peer } = await fixture()
      value.guards[0].failure = failure
      await sessions.commit(value)
      const authorizedBefore = auth(await sessions.session(value.session, null))
      await peer().sessions.advanceGuard('serving', '0')
      await expect(
        sessions.serialize(value.session, authorizedBefore, value.first)
      ).rejects.toMatchObject({ code: failure })
      await expect(sessions.recover(original(value))).rejects.toMatchObject({ code: failure })
      await expect(sessions.commit(another(value))).rejects.toMatchObject({ code: failure })
      expect((await index.head()).retained.pins).toBe(1)
      await expect(sessions.advanceGuard('serving', '0')).rejects.toMatchObject({
        code: 'conflict'
      })
      expect(await sessions.initializeGuard('serving')).toBe('1')
    }
  )

  it('blocks both old and newly prepared sessions while external privacy changes are incomplete', async () => {
    const { sessions, value, peer, index } = await fixture()
    value.guards[0].failure = 'unauthorized'
    await sessions.commit(value)
    const operation = 'a1'.repeat(32)
    expect(await sessions.guardState('serving')).toEqual({
      revision: '0',
      blocked: false,
      operation: null
    })
    expect(await peer().sessions.blockGuard('serving', '0', operation)).toBe('1')
    // Lost acknowledgment recovers the same block; a competing owner cannot release it.
    expect(await sessions.blockGuard('serving', '0', operation)).toBe('1')
    await expect(sessions.blockGuard('serving', '0', 'a2'.repeat(32))).rejects.toMatchObject({
      code: 'conflict'
    })
    await expect(sessions.releaseGuard('serving', '1', 'a2'.repeat(32))).rejects.toMatchObject({
      code: 'conflict'
    })
    await expect(sessions.advanceGuard('serving', '1')).rejects.toMatchObject({ code: 'conflict' })
    await expect(sessions.serialize(value.session, auth(value), value.first)).rejects.toMatchObject(
      { code: 'unauthorized' }
    )
    const during = another(value)
    during.guards[0].revision = '1'
    await expect(sessions.commit(during)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(await peer().sessions.guardState('serving')).toEqual({
      revision: '1',
      blocked: true,
      operation
    })
    expect((await index.head()).retained.pins).toBe(1)
    // The external owner finishes its durable change before releasing disclosure.
    expect(await sessions.releaseGuard('serving', '1', operation)).toBe('2')
    expect(await peer().sessions.releaseGuard('serving', '1', operation)).toBe('2')
    const after = another(value, '03')
    after.guards[0].revision = '2'
    expect(await sessions.commit(after)).toEqual(after)
    await expect(sessions.serialize(value.session, auth(value), value.first)).rejects.toMatchObject(
      { code: 'unauthorized' }
    )
    expect(await sessions.serialize(after.session, auth(after), after.first)).toBe(
      canonicalOutputJSON(after.first)
    )
    await expect(sessions.blockGuard('serving', '0', operation)).rejects.toMatchObject({
      code: 'conflict'
    })
    await expect(sessions.releaseGuard('serving', '2', operation)).rejects.toMatchObject({
      code: 'conflict'
    })
    expect(await sessions.advanceGuard('serving', '2')).toBe('3')
    expect(await sessions.guardState('serving')).toEqual({
      revision: '3',
      blocked: false,
      operation: null
    })
  })

  it('keeps scope and authorizer premises fixed even if a caller presents another valid current guard', async () => {
    const { sessions, value } = await fixture()
    await sessions.initializeGuard('other')
    await sessions.commit(value)
    for (const authority of [
      { ...auth(value), access: 'different' },
      {
        ...auth(value),
        guards: [{ id: 'other', revision: '0', failure: 'reset-required' as const }]
      },
      {
        ...auth(value),
        guards: [
          ...value.guards,
          { id: 'other', revision: '0', failure: 'reset-required' as const }
        ]
      }
    ])
      await expect(
        sessions.serialize(
          value.session,
          { ...authority, guards: [...authority.guards] },
          value.first
        )
      ).rejects.toBeDefined()
    expect(await sessions.serialize(value.session, auth(value), value.first)).toBe(
      canonicalOutputJSON(value.first)
    )
  })

  it('rejects a candidate after compaction wins the snapshot race without installing any fence or pin', async () => {
    const { index, sessions, value, clock } = await fixture()
    await index.commit({
      base: '0',
      evaluatedAt: '1001',
      edits: [{ key: '01', previous: null, next: { data: {}, expiresAt: null } }],
      event: {}
    })
    await index.compact('1100', compact)
    clock.now = '1100'
    await expect(sessions.commit(value)).rejects.toMatchObject({ code: 'reset-required' })
    expect((await index.head()).retained.pins).toBe(0)
    expect(await sessions.recover(original(value))).toBeNull()
  })

  it('rolls back the complete opening and pin on a storage error, then retries exactly', async () => {
    const { path, index, sessions, value } = await fixture()
    const sql = new DatabaseSync(path)
    try {
      sql.exec(
        "CREATE TRIGGER fail_open BEFORE INSERT ON output_lookup_sessions BEGIN SELECT RAISE(ABORT,'opening failure'); END"
      )
      await expect(sessions.commit(value)).rejects.toThrow('opening failure')
      expect((await index.head()).retained.pins).toBe(0)
      expect(await sessions.recover(original(value))).toBeNull()
      sql.exec('DROP TRIGGER fail_open')
      expect(await sessions.commit(value)).toEqual(value)
    } finally {
      sql.close()
    }
  })

  it('keeps retired-epoch promises while requiring a fresh signed selector for another epoch', async () => {
    const { sessions, value } = await fixture()
    await sessions.commit(value)
    await sessions.retireEpoch(value.epoch)
    expect(await sessions.recover(original(value))).toEqual(value)
    expect(await sessions.serialize(value.session, auth(value), value.first)).toBe(
      canonicalOutputJSON(value.first)
    )
    await expect(sessions.commit(another(value))).rejects.toMatchObject({ code: 'reset-required' })
    const next = await sessions.createEpoch()
    expect(next).not.toBe(value.epoch)
    await expect(sessions.commit({ ...another(value), epoch: next })).rejects.toMatchObject({
      code: 'reset-required'
    })
    await expect(
      sessions.recover({ ...original(value), epoch: 'ff'.repeat(32) })
    ).rejects.toMatchObject({ code: 'reset-required' })
  })

  it('bounds epoch collection and never recycles an original key under an accepted selector', async () => {
    const { sessions, value, clock, peer } = await fixture({ epochs: 2 })
    await sessions.commit(value)
    await sessions.commit(another(value))
    await expect(sessions.collectEpoch(value.epoch, 1)).rejects.toMatchObject({ code: 'conflict' })
    const next = await sessions.createEpoch()
    // Rotation retires old new-Open acceptance, but preserves its original responses.
    await expect(sessions.commit(another(value, '03'))).rejects.toMatchObject({
      code: 'reset-required'
    })
    expect(await sessions.recover(original(value))).toEqual(value)
    await expect(sessions.createEpoch()).rejects.toMatchObject({ code: 'limited' })
    await expect(sessions.collectEpoch(value.epoch, 1)).rejects.toMatchObject({
      code: 'unavailable'
    })
    clock.now = '1900'
    await expect(sessions.collectEpoch(value.epoch, 1)).rejects.toMatchObject({
      code: 'unavailable'
    })
    expect(await sessions.compact(1)).toBe(1)
    await expect(sessions.collectEpoch(value.epoch, 1)).rejects.toMatchObject({
      code: 'unavailable'
    })
    expect(await sessions.compact(1)).toBe(1)
    expect(await sessions.collectEpoch(value.epoch, 1)).toEqual({ removed: 1, complete: false })
    expect(await peer().sessions.collectEpoch(value.epoch, 1)).toEqual({
      removed: 1,
      complete: true
    })
    await expect(sessions.recover(original(value))).rejects.toMatchObject({
      code: 'reset-required'
    })
    const latest = await sessions.createEpoch()
    expect(latest).not.toBe(next)
    expect(latest).not.toBe(value.epoch)
    await expect(sessions.collectEpoch(latest, 1)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('never recreates missing recovery storage or silently accepts changed configuration', async () => {
    const { path, index, sessions, value, clock, codec } = await fixture()
    await sessions.commit(value)
    expect(() => SQLiteLookupSessions.create(index, codec, () => clock.now)).toThrow(
      'already exists'
    )
    expect(() => SQLiteLookupSessions.open(index, codec, () => clock.now, { fences: 1 })).toThrow(
      'configuration changed'
    )
    const sql = new DatabaseSync(path)
    try {
      sql.exec('DELETE FROM output_lookup_sessions; DELETE FROM output_lookup_openings')
      await expect(sessions.recover(original(value))).rejects.toMatchObject({
        code: 'reset-required'
      })
      await expect(sessions.commit(value)).rejects.toMatchObject({ code: 'reset-required' })
      expect(() => SQLiteLookupSessions.open(index, codec, () => clock.now)).toThrow(
        'inventory is incomplete'
      )
    } finally {
      sql.close()
    }
  })

  it.each(['output_lookup_sessions', 'output_lookup_pins', 'output_lookup_guards'])(
    'fails closed after loss of %s',
    async table => {
      const { path, sessions, value } = await fixture()
      await sessions.commit(value)
      const sql = new DatabaseSync(path)
      try {
        sql.exec(`DELETE FROM ${table}`)
        await expect(sessions.session(value.session, null)).rejects.toMatchObject({
          code: 'reset-required'
        })
        await expect(
          sessions.serialize(value.session, auth(value), value.first)
        ).rejects.toMatchObject({ code: 'reset-required' })
      } finally {
        sql.close()
      }
    }
  )

  it('retains quota and permanent-fence bounds without evicting a promised session', async () => {
    const { sessions, value, clock } = await fixture({
      fences: 1,
      sessions: 1,
      sessionsPerPrincipal: 1
    })
    await sessions.commit(value)
    await expect(sessions.commit(another(value))).rejects.toMatchObject({ code: 'limited' })
    expect(await sessions.recover(original(value))).toEqual(value)
    clock.now = '1900'
    expect(await sessions.compact(1)).toBe(1)
    // Expired first candidates cannot be used to bypass permanent-fence capacity.
    await expect(sessions.commit(another(value))).rejects.toMatchObject({ code: 'expired' })
    await expect(sessions.recover(original(value))).rejects.toMatchObject({ code: 'expired' })
  })

  it.each([0, 1025, 1.5, NaN])('rejects unbounded session compaction %s', async maximum => {
    const { sessions } = await fixture()
    await expect(sessions.compact(maximum)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects unprocessed opening time and later snapshots under the original retained boundary', async () => {
    const { index, sessions, value, clock } = await fixture()
    value.time = value.contract.selectedAt = '1001'
    value.first.expiresAt = '1301'
    value.first.replayUntil = '1901'
    clock.now = '1001'
    await expect(sessions.commit(value)).rejects.toMatchObject({ code: 'unavailable' })
    await index.advanceTime('1001', 1)
    await sessions.commit(value)
    const changed = { ...value.first, expiresAt: '1302' }
    await expect(sessions.serialize(value.session, auth(value), changed)).rejects.toMatchObject({
      code: 'context-changed'
    })
    expect(await index.snapshot('0', null, pages)).toMatchObject({ rows: [], complete: true })
  })
})

it('bounds durable disclosure guard allocation without replacing existing premises', async () => {
  const { sessions } = await fixture({ guards: 2 })
  expect(await sessions.initializeGuard('serving')).toBe('0')
  expect(await sessions.initializeGuard('second')).toBe('0')
  await expect(sessions.initializeGuard('third')).rejects.toMatchObject({
    code: 'limited',
    message: 'Lookup disclosure guard capacity is full'
  })
  expect(await sessions.advanceGuard('second', '0')).toBe('1')
  expect(await sessions.initializeGuard('second')).toBe('1')
  await expect(sessions.guard('missing')).rejects.toMatchObject({
    code: 'reset-required',
    message: 'Lookup disclosure guard is missing'
  })
})

it('fails closed on damaged disclosure state and checks its independent integrity digest', async () => {
  const { sessions, path } = await fixture()
  const sql = new DatabaseSync(path)
  try {
    const saved = sql.prepare('SELECT blocked, operation, digest FROM output_lookup_guards').get()!
    for (const [column, value, message] of [
      ['blocked', 2, 'Invalid lookup disclosure guard state'],
      ['operation', 'a'.repeat(63), 'Invalid lookup disclosure guard state'],
      ['operation', 'a'.repeat(65), 'Invalid lookup disclosure guard state'],
      ['operation', 'G'.repeat(64), 'Invalid lookup disclosure guard state'],
      ['digest', 'ff'.repeat(32), 'Lookup disclosure guard integrity failed'],
      ['blocked', 1, 'Lookup disclosure guard integrity failed']
    ] as const) {
      sql.prepare('UPDATE output_lookup_guards SET ' + column + '=?').run(value)
      await expect(sessions.guardState('serving')).rejects.toMatchObject({
        code: 'reset-required',
        message
      })
      sql
        .prepare('UPDATE output_lookup_guards SET blocked=?,operation=?,digest=?')
        .run(saved.blocked, saved.operation, saved.digest)
    }
    expect(await sessions.guardState('serving')).toEqual({
      revision: '0',
      blocked: false,
      operation: null
    })
  } finally {
    sql.close()
  }
})

it('rejects changed authority partitions, premise membership, revisions and failure semantics independently', async () => {
  const { sessions, value } = await fixture()
  await sessions.commit(value)
  await expect(
    sessions.serialize(
      value.session,
      { ...auth(value), principal: new PrivateKey(2).toPublicKey().toString() },
      value.first
    )
  ).rejects.toMatchObject({ code: 'reset-required' })
  for (const [authority, code, message] of [
    [{ ...auth(value), access: 'other' }, 'unauthorized', 'Lookup authorization partition changed'],
    [
      {
        ...auth(value),
        guards: [
          ...value.guards,
          { id: 'other', revision: '0', failure: 'reset-required' as const }
        ]
      },
      'unauthorized',
      'Lookup authorization premises changed'
    ],
    [
      { ...auth(value), guards: [{ ...value.guards[0], id: 'other' }] },
      'reset-required',
      'Lookup authorization premise changed'
    ],
    [
      { ...auth(value), guards: [{ ...value.guards[0], revision: '1' }] },
      'reset-required',
      'Lookup authorization premise changed'
    ],
    [
      { ...auth(value), guards: [{ ...value.guards[0], failure: 'unauthorized' as const }] },
      'reset-required',
      'Lookup authorization premise changed'
    ]
  ] as const)
    await expect(
      sessions.serialize(
        value.session,
        { ...authority, guards: [...authority.guards] },
        value.first
      )
    ).rejects.toMatchObject({
      code,
      message
    })
})

it('checks every retained scope field and selected response maximum at the final gate', async () => {
  const { sessions, value } = await fixture()
  const manifest = structuredClone(value.contract.manifest.body),
    profile = manifest.services[0].profiles[0]
  profile.maxResponseBytes = 65536
  profile.parameters.maxObservations = 2
  profile.parameters.maxWaitMs = 5
  value.contract = retainOutputCapability(
    signOutputPacket('capabilities', manifest, new PrivateKey(1)),
    liveFixture().selection
  ).record
  value.open.limits = { maxBytes: 65536, maxObservations: 2, waitMs: 0 }
  value.first.limits = { ...value.open.limits }
  await sessions.commit(value)
  for (const change of [
    { session: 'aa'.repeat(32) },
    { expiresAt: '1301' },
    { replayUntil: '1901' },
    { scope: { ...value.first.scope, access: 'changed' } }
  ])
    await expect(
      sessions.serialize(value.session, auth(value), { ...value.first, ...change })
    ).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Lookup response changed its retained scope'
    })
  for (const [key, maximum] of [
    ['maxBytes', 65536],
    ['maxObservations', 2],
    ['waitMs', 5]
  ] as const) {
    const exact = { ...value.first, limits: { ...value.first.limits, [key]: maximum } }
    expect(await sessions.serialize(value.session, auth(value), exact)).toBe(
      canonicalOutputJSON(exact)
    )
    await expect(
      sessions.serialize(value.session, auth(value), {
        ...exact,
        limits: { ...exact.limits, [key]: maximum + 1 }
      })
    ).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Lookup response exceeds its original selected limits'
    })
  }
  await expect(
    sessions.serialize(value.session, auth(value), { ...value.first, highWater: '1' })
  ).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Lookup response is ahead of the committed index'
  })
})

it('checks snapshot and live cursor boundaries independently against a nonzero opening watermark', async () => {
  const { index, sessions, value } = await fixture()
  await index.commit({
    base: '0',
    evaluatedAt: '1000',
    edits: [{ key: '01', previous: null, next: { data: {}, expiresAt: null } }],
    event: {}
  })
  value.watermark = '1'
  value.first.through = '1'
  value.first.highWater = '1'
  const cursor = new LookupCursorCodec(value.secret, value.session, value.epoch)
  value.first.cursor = cursor.seal({ phase: 'live', through: '1' })
  await sessions.commit(value)
  await index.commit({
    base: '1',
    evaluatedAt: '1000',
    edits: [{ key: '02', previous: null, next: { data: {}, expiresAt: null } }],
    event: {}
  })
  const base = { ...value.first, highWater: '2' }
  for (const [batch, message] of [
    [
      {
        ...base,
        snapshotComplete: false,
        cursor: cursor.seal({ phase: 'snapshot', watermark: '0', after: '01' })
      },
      'Lookup response changed its cursor boundary'
    ],
    [
      { ...base, cursor: cursor.seal({ phase: 'live', through: '2' }) },
      'Lookup response changed its cursor boundary'
    ],
    [
      { ...base, through: '2', cursor: cursor.seal({ phase: 'live', through: '2' }) },
      'Lookup response changed its snapshot boundary'
    ],
    [{ ...base, snapshotComplete: false }, 'Lookup response changed its snapshot boundary'],
    [
      { ...base, cursor: cursor.seal({ phase: 'snapshot', watermark: '1', after: '01' }) },
      'Lookup response changed its snapshot boundary'
    ],
    [
      {
        ...base,
        phase: 'live' as const,
        cursor: cursor.seal({ phase: 'snapshot', watermark: '1', after: '01' })
      },
      'Lookup live response regressed before its snapshot'
    ],
    [
      {
        ...base,
        phase: 'live' as const,
        through: '0',
        cursor: cursor.seal({ phase: 'live', through: '0' })
      },
      'Lookup live response regressed before its snapshot'
    ]
  ] as const)
    await expect(sessions.serialize(value.session, auth(value), batch)).rejects.toMatchObject({
      code: 'context-changed',
      message
    })
  for (const batch of [
    base,
    {
      ...base,
      snapshotComplete: false,
      cursor: cursor.seal({ phase: 'snapshot', watermark: '1', after: '01' })
    },
    {
      ...base,
      phase: 'live' as const,
      through: '2',
      cursor: cursor.seal({ phase: 'live', through: '2' })
    }
  ])
    expect(await sessions.serialize(value.session, auth(value), batch)).toBe(
      canonicalOutputJSON(batch)
    )
})

it('keeps inaccessible Close private but never hides a storage or unexpected policy failure', async () => {
  const { path, sessions, value } = await fixture()
  await sessions.commit(value)
  for (const authority of [
    { ...auth(value), access: 'changed' },
    { ...auth(value), guards: [{ ...value.guards[0], revision: '1' }] }
  ]) {
    expect(await sessions.closeSession(value.session, authority)).toEqual({
      version: 1,
      closed: true
    })
    expect(await sessions.recover(original(value))).toEqual(value)
  }
  const sql = new DatabaseSync(path)
  try {
    sql.exec(
      "CREATE TRIGGER fail_close BEFORE UPDATE ON output_lookup_openings BEGIN SELECT RAISE(ABORT,'failed close persistence'); END"
    )
    await expect(sessions.closeSession(value.session, auth(value))).rejects.toThrow(
      'failed close persistence'
    )
    expect(await sessions.recover(original(value))).toEqual(value)
  } finally {
    sql.exec('DROP TRIGGER fail_close')
    sql.close()
  }
  const failure = new OutputProtocolError('unavailable', 'policy unavailable', true)
  const policy = jest
    .spyOn(SQLiteLookupDisclosure.prototype, 'authorize')
    .mockImplementationOnce(() => {
      throw failure
    })
  await expect(sessions.closeSession(value.session, auth(value))).rejects.toBe(failure)
  policy.mockRestore()
  expect(await sessions.recover(original(value))).toEqual(value)
})

it('checks the index write and retention clocks even before any later session clock was sampled', async () => {
  const { index, sessions, clock } = await fixture()
  await index.commit({
    base: '0',
    evaluatedAt: '1001',
    edits: [{ key: '01', previous: null, next: null }],
    event: {}
  })
  await expect(sessions.guard('serving')).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Lookup session clock moved backwards'
  })
  clock.now = '1001'
  expect(await sessions.guard('serving')).toBe('0')
  await index.compact('1002', compact)
  await expect(sessions.guard('serving')).rejects.toMatchObject({
    code: 'context-changed',
    message: 'Lookup session clock moved backwards'
  })
  clock.now = '1002'
  expect(await sessions.guard('serving')).toBe('0')
})

it('does not commit a first candidate at its exact expiry and keeps compaction work bounded', async () => {
  const { sessions, value, clock } = await fixture()
  clock.now = value.first.expiresAt
  await expect(sessions.commit(value)).rejects.toMatchObject({
    code: 'expired',
    message: 'Lookup opening expired before its commit'
  })
  expect(await sessions.compact(1024)).toBe(0)
  for (const limit of [0, 1.5, 1025])
    await expect(sessions.compact(limit)).rejects.toMatchObject({
      code: 'invalid',
      message: 'Invalid lookup session compaction bound'
    })
})

it('requires the original pin watermark and deadline rather than a different extant promise', async () => {
  const { path, sessions, value } = await fixture()
  await sessions.commit(value)
  const sql = new DatabaseSync(path)
  try {
    const saved = sql.prepare('SELECT watermark,replay_until FROM output_lookup_pins').get()!
    for (const field of ['watermark', 'replay_until']) {
      sql.prepare('UPDATE output_lookup_pins SET ' + field + '=?').run('0000000000000001')
      await expect(sessions.session(value.session, null)).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup session lost its promised history'
      })
      sql
        .prepare('UPDATE output_lookup_pins SET watermark=?,replay_until=?')
        .run(saved.watermark, saved.replay_until)
    }
  } finally {
    sql.close()
  }
})

it('refuses payload compaction whose retained deadline or accounting differs from its permanent fence', async () => {
  for (const fault of ['deadline', 'size', 'missing fence']) {
    const { path, sessions, value, clock } = await fixture()
    await sessions.commit(value)
    const sql = new DatabaseSync(path)
    try {
      if (fault === 'deadline') {
        sql.prepare('UPDATE output_lookup_sessions SET replay_until=?').run('0000000000000708') // 1800, before its actual 1900 promise.
        clock.now = '1800'
      } else {
        clock.now = '1900'
        if (fault === 'size') {
          sql.exec(
            'UPDATE output_lookup_sessions SET payload_bytes=0; UPDATE output_lookup_session_meta SET payload_bytes=0'
          )
        } else {
          sql.exec(
            'PRAGMA foreign_keys=OFF; DELETE FROM output_lookup_openings; UPDATE output_lookup_session_meta SET fences=0'
          )
        }
      }
      await expect(sessions.compact(1)).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup session compaction lost its original fence'
      })
      expect(sql.prepare('SELECT count(*) AS n FROM output_lookup_sessions').get()!.n).toBe(1)
    } finally {
      sql.close()
    }
  }
})

it('seals session capacities with exact independent upper and lower bounds', () => {
  const maximum = {
    epochs: 64,
    guards: 1024,
    fences: 65536,
    sessions: 65536,
    sessionsPerPrincipal: 256,
    bytes: 268435456
  }
  expect(lookupSessionCapacity()).toEqual(maximum)
  expect(Object.isFrozen(lookupSessionCapacity())).toBe(true)
  for (const [key, limit] of Object.entries(maximum)) {
    expect(lookupSessionCapacity({ [key]: 1 })[key as keyof LookupSessionCapacity]).toBe(1)
    expect(lookupSessionCapacity({ [key]: limit })[key as keyof LookupSessionCapacity]).toBe(limit)
    for (const bad of [0, -1, 1.5, NaN, Infinity, limit + 1])
      expect(() => lookupSessionCapacity({ [key]: bad })).toThrow('Invalid lookup session capacity')
  }
  expect(() => lookupSessionCapacity({ extra: 1 } as Partial<LookupSessionCapacity>)).toThrow(
    'Invalid lookup session capacity'
  )
  expect(JSON.parse(sessionConfiguration(maximum))).toEqual({
    format: 'output-lookup-sessions/1',
    capacity: maximum
  })
})

it.each(['fences', 'sessions', 'sessionsPerPrincipal'] as const)(
  'enforces the %s quota independently without changing a retained opening',
  async key => {
    const { sessions, value } = await fixture({ [key]: 1 })
    expect(await sessions.commit(value)).toEqual(value)
    await expect(sessions.commit(another(value))).rejects.toMatchObject({
      code: 'limited',
      message: 'Lookup original opening capacity is full'
    })
    expect(await sessions.recover(original(value))).toEqual(value)
  }
)

it('bounds complete session payload bytes before committing any opening or pin', async () => {
  const { sessions, value, index } = await fixture({ bytes: 1 })
  await expect(sessions.commit(value)).rejects.toMatchObject({
    code: 'limited',
    message: 'Lookup original opening capacity is full'
  })
  expect(await sessions.recover(original(value))).toBeNull()
  expect((await index.head()).retained.pins).toBe(0)
})

it('validates session inventory counters and bounded immutable configuration on each operation', async () => {
  const { path, sessions, value } = await fixture()
  await sessions.commit(value)
  const sql = new DatabaseSync(path)
  try {
    const saved = sql.prepare('SELECT * FROM output_lookup_session_meta').get()!
    for (const [column, maximum] of Object.entries({
      epochs: 64,
      guards: 1024,
      fences: 65536,
      sessions: 65536,
      payload_bytes: 268435456
    })) {
      for (const bad of [-1, maximum + 1]) {
        sql.prepare(`UPDATE output_lookup_session_meta SET ${column}=?`).run(bad)
        await expect(sessions.recover(original(value))).rejects.toMatchObject({
          code: 'reset-required',
          message: 'Lookup session inventory is invalid'
        })
      }
      sql.prepare(`UPDATE output_lookup_session_meta SET ${column}=?`).run(saved[column])
    }
    sql.prepare('UPDATE output_lookup_session_meta SET configuration=?').run('x'.repeat(65537))
    await expect(sessions.recover(original(value))).rejects.toMatchObject({
      code: 'context-changed'
    })
    sql.prepare('UPDATE output_lookup_session_meta SET configuration=?').run(saved.configuration)
    sql.prepare('UPDATE output_lookup_session_meta SET clock=?').run('0'.repeat(17))
    await expect(sessions.recover(original(value))).rejects.toMatchObject({
      code: 'reset-required'
    })
    sql.prepare('UPDATE output_lookup_session_meta SET clock=?').run(saved.clock)
    for (const column of ['epochs', 'guards', 'fences', 'sessions', 'payload_bytes']) {
      sql.prepare(`UPDATE output_lookup_session_meta SET ${column}=${column}+1`).run()
      await expect(sessions.createEpoch()).rejects.toMatchObject({ code: 'reset-required' })
      sql.prepare(`UPDATE output_lookup_session_meta SET ${column}=?`).run(saved[column])
    }
    expect(await sessions.recover(original(value))).toEqual(value)
  } finally {
    sql.close()
  }
})

it('checks epoch secret encoding, active-state domain and checksum before recovery', async () => {
  const { path, sessions, value } = await fixture()
  await sessions.commit(value)
  const sql = new DatabaseSync(path)
  try {
    const saved = sql.prepare('SELECT * FROM output_lookup_epochs').get()!
    for (const [column, bad] of [
      ['secret', 'g'.repeat(64)],
      ['secret', '0'.repeat(65)],
      ['accepts_new', 2],
      ['digest', 'ff'.repeat(32)]
    ] as const) {
      sql.prepare(`UPDATE output_lookup_epochs SET ${column}=?`).run(bad)
      await expect(sessions.recover(original(value))).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup serving epoch is unavailable'
      })
      sql.prepare(`UPDATE output_lookup_epochs SET ${column}=?`).run(saved[column])
    }
    expect(await sessions.recover(original(value))).toEqual(value)
  } finally {
    sql.close()
  }
})

it('keeps original payload columns independently bounded and checked before decoding', async () => {
  const { path, sessions, value } = await fixture()
  await sessions.commit(value)
  const sql = new DatabaseSync(path)
  try {
    const saved = sql.prepare('SELECT * FROM output_lookup_sessions').get()!
    for (const [column, limit] of Object.entries({
      metadata: 65536,
      original_open: 1048576,
      contract: 524288,
      first_batch: 4194304,
      header: 131072
    })) {
      sql.prepare(`UPDATE output_lookup_sessions SET ${column}=?`).run('x'.repeat(limit + 1))
      await expect(sessions.recover(original(value))).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup opening payload is unavailable'
      })
      sql.prepare(`UPDATE output_lookup_sessions SET ${column}=?`).run(saved[column])
    }
    for (const [column, bad] of [
      ['payload_bytes', Number(saved.payload_bytes) + 1],
      ['digest', 'ff'.repeat(32)],
      ['replay_until', '000000000000076d']
    ] as const) {
      sql.prepare(`UPDATE output_lookup_sessions SET ${column}=?`).run(bad)
      await expect(sessions.recover(original(value))).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup opening payload integrity failed'
      })
      sql.prepare(`UPDATE output_lookup_sessions SET ${column}=?`).run(saved[column])
    }
    expect(await sessions.recover(original(value))).toEqual(value)
  } finally {
    sql.close()
  }
})

it('refuses malformed retained fence identifiers and authenticates the fence before interpreting it', async () => {
  const { path, sessions, value } = await fixture()
  await sessions.commit(value)
  const sql = new DatabaseSync(path)
  try {
    const saved = sql.prepare('SELECT * FROM output_lookup_openings').get()!
    // A local corruption injector may damage a key despite ordinary writer foreign keys.
    sql.exec('PRAGMA foreign_keys=OFF')
    for (const column of ['request_digest', 'manifest_digest', 'principal_key', 'session']) {
      sql.prepare(`UPDATE output_lookup_openings SET ${column}=?`).run('g'.repeat(64))
      await expect(sessions.recover(original(value))).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Invalid retained lookup identifier'
      })
      sql.prepare(`UPDATE output_lookup_openings SET ${column}=?`).run(saved[column])
    }
    sql.prepare('UPDATE output_lookup_openings SET digest=?').run('ff'.repeat(32))
    await expect(sessions.recover(original(value))).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup opening fence integrity failed'
    })
    sql.prepare('UPDATE output_lookup_openings SET digest=?').run(saved.digest)
    sql.prepare('UPDATE output_lookup_openings SET epoch=?').run('g'.repeat(64))
    await expect(sessions.session(value.session, value.principal)).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Invalid retained lookup identifier'
    })
    sql.prepare('UPDATE output_lookup_openings SET epoch=?').run(saved.epoch)
    expect(await sessions.recover(original(value))).toEqual(value)
  } finally {
    sql.close()
  }
})

it('preserves the version-one length-framed and keyed record identity vectors', async () => {
  const { index, codec, sessions, value } = await fixture()
  const records = new SQLiteLookupSessionRecords(
    index[sqliteLookupBridge](),
    codec,
    sessionConfiguration(sessions.capacity),
    sessions.capacity
  )
  // Expected values are independently calculated with Python hashlib/hmac and UTF-8 JCS.
  expect(records.digest('test', 'é', 'a:b')).toBe(
    '8473894a6659b2229f1306328e16758c217ea3b991b80b25b9c8e7da98100777'
  )
  expect(records.principalKey(null)).toBe(
    '98978fe36a5caf25a281c630525d636e7ec4aaf8a1441084489ce6210e4592e1'
  )
  expect(
    records.openingKey(
      { epoch: '11'.repeat(32), secret: '22'.repeat(32), acceptsNew: true },
      {
        ...original(value),
        principal: null,
        open: { ...value.open, service: 'records', requestId: 'ab'.repeat(16) }
      }
    )
  ).toBe('970b59aa83228f16e92ff363ab2c0265e6ca891e124673907f80fad216022053')
})

it('rejects a retained fence state outside the complete closed state domain', async () => {
  const { path, sessions, value } = await fixture()
  await sessions.commit(value)
  const sql = new DatabaseSync(path)
  try {
    sql.exec('PRAGMA ignore_check_constraints=ON')
    for (const state of ['unknown', 'longer-than-seven']) {
      sql.prepare('UPDATE output_lookup_openings SET state=?').run(state)
      await expect(sessions.recover(original(value))).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Invalid lookup opening fence'
      })
    }
  } finally {
    sql.close()
  }
})

it('does not accept a missing or mismatched record from the session-to-fence lookup', async () => {
  const { index, codec, sessions, value } = await fixture()
  await sessions.commit(value)
  const records = new SQLiteLookupSessionRecords(
    index[sqliteLookupBridge](),
    codec,
    sessionConfiguration(sessions.capacity),
    sessions.capacity
  )
  const fence = records.bySession(value.session)!.fence
  const read = jest.spyOn(records, 'fence')
  read.mockReturnValueOnce(null)
  expect(() => records.bySession(value.session)).toThrow('Lookup session identity is incomplete')
  read.mockReturnValueOnce({ ...fence, session: 'ff'.repeat(32) })
  expect(() => records.bySession(value.session)).toThrow('Lookup session identity is incomplete')
})

it('binds even a correctly authenticated private header to its permanent original fence', async () => {
  const { path, sessions, value } = await fixture()
  await sessions.commit(value)
  const sql = new DatabaseSync(path)
  try {
    const saved = sql.prepare('SELECT header,header_digest FROM output_lookup_sessions').get()!
    const epoch = sql.prepare('SELECT secret FROM output_lookup_epochs').get()!
    const initial = JSON.parse(String(saved.header))
    const changed = [
      { ...initial, epoch: 'ff'.repeat(32) },
      { ...initial, session: 'ff'.repeat(32) },
      { ...initial, principal: new PrivateKey(3).toPublicKey().toString() },
      { ...initial, first: { ...initial.first, expiresAt: '1301' } },
      { ...initial, first: { ...initial.first, replayUntil: '1901' } }
    ]
    for (const header of changed) {
      const raw = canonicalOutputJSON(header)
      const mac = createHmac('sha256', Buffer.from(String(epoch.secret), 'hex'))
        .update(canonicalOutputJSON({ namespace: 'records', kind: 'header', value: raw }))
        .digest('hex')
      sql.prepare('UPDATE output_lookup_sessions SET header=?,header_digest=?').run(raw, mac)
      await expect(
        sessions.serialize(value.session, auth(value), value.first)
      ).rejects.toMatchObject({
        code: 'reset-required',
        message: 'Lookup retained header integrity failed'
      })
    }
    sql
      .prepare('UPDATE output_lookup_sessions SET header=?,header_digest=?')
      .run(saved.header, saved.header_digest)
    expect(await sessions.serialize(value.session, auth(value), value.first)).toBe(
      canonicalOutputJSON(value.first)
    )
  } finally {
    sql.close()
  }
})

it('detects a valid payload transplanted under another original operation even after checksumming', async () => {
  const { path, index, codec, sessions, value } = await fixture()
  await sessions.commit(value)
  const records = new SQLiteLookupSessionRecords(
    index[sqliteLookupBridge](),
    codec,
    sessionConfiguration(sessions.capacity),
    sessions.capacity
  )
  const sql = new DatabaseSync(path)
  try {
    const saved = sql.prepare('SELECT * FROM output_lookup_sessions').get()!
    for (const mode of ['header', 'request']) {
      const open = JSON.parse(String(saved.original_open))
      const header = JSON.parse(String(saved.header))
      if (mode === 'request') open.requestId = 'ff'.repeat(32)
      else header.maximums.waitMs = 1
      const rawOpen = canonicalOutputJSON(open),
        rawHeader = canonicalOutputJSON(header)
      const columns = [
        String(saved.metadata),
        rawOpen,
        String(saved.contract),
        String(saved.first_batch),
        rawHeader
      ]
      const bytes = columns.reduce((sum, field) => sum + Buffer.byteLength(field, 'utf8'), 0)
      sql
        .prepare(
          'UPDATE output_lookup_sessions SET original_open=?,header=?,payload_bytes=?,digest=?'
        )
        .run(rawOpen, rawHeader, bytes, records.digest('opening', value.session, ...columns))
      await expect(sessions.recover(original(value))).rejects.toMatchObject({
        code: 'reset-required',
        message:
          mode === 'request'
            ? 'Lookup opening lost its original binding'
            : 'Lookup retained header changed its original opening'
      })
    }
  } finally {
    sql.close()
  }
})

it('never treats a missing session namespace as an empty initialized store', async () => {
  const { path, sessions, value } = await fixture()
  const sql = new DatabaseSync(path)
  try {
    sql.exec('PRAGMA foreign_keys=OFF; DELETE FROM output_lookup_session_meta')
    await expect(sessions.recover(original(value))).rejects.toMatchObject({
      code: 'reset-required',
      message: 'Lookup session namespace is missing'
    })
  } finally {
    sql.close()
  }
})

it('checks the original key, parameter digest and manifest digest independently of the authenticated header', async () => {
  const { index, codec, sessions, value } = await fixture()
  await sessions.commit(value)
  const records = new SQLiteLookupSessionRecords(
    index[sqliteLookupBridge](),
    codec,
    sessionConfiguration(sessions.capacity),
    sessions.capacity
  )
  const retained = records.bySession(value.session)!
  for (const field of ['key', 'requestDigest', 'manifestDigest'] as const) {
    expect(() =>
      records.opening(retained.epoch, { ...retained.fence, [field]: 'ff'.repeat(32) })
    ).toThrow(
      expect.objectContaining({
        code: 'reset-required',
        message: 'Lookup opening lost its original binding'
      })
    )
  }
  expect(records.opening(retained.epoch, retained.fence)).toEqual(value)
})

it('rejects an over-limit retained header before interpreting its private fields', async () => {
  const { path, sessions, value } = await fixture()
  await sessions.commit(value)
  const sql = new DatabaseSync(path)
  try {
    sql.prepare('UPDATE output_lookup_sessions SET header=?').run(' '.repeat(131073))
    await expect(sessions.serialize(value.session, auth(value), value.first)).rejects.toMatchObject(
      {
        code: 'reset-required',
        message: 'Lookup retained header is unavailable'
      }
    )
  } finally {
    sql.close()
  }
})

it('admits a complete retained record at the exact byte quota and refuses the next record', async () => {
  const { index, codec, sessions, value } = await fixture()
  const bridge = index[sqliteLookupBridge]()
  const configuration = sessionConfiguration(sessions.capacity)
  const records = new SQLiteLookupSessionRecords(bridge, codec, configuration, sessions.capacity)
  const epoch = records.epoch(value.epoch)
  const rollback = new Error('test-owned quota measurement rollback')
  let exact = 0
  expect(() =>
    bridge.transaction(() => {
      records.saveOpening(epoch, value)
      exact = records.metadata().bytes
      throw rollback
    })
  ).toThrow(rollback)
  expect(exact).toBeGreaterThan(0)
  const bounded = new SQLiteLookupSessionRecords(bridge, codec, configuration, {
    ...sessions.capacity,
    bytes: exact
  })
  bridge.transaction(() => bounded.saveOpening(epoch, value))
  expect(bounded.metadata().bytes).toBe(exact)
  expect(() => bridge.transaction(() => bounded.saveOpening(epoch, another(value)))).toThrow(
    expect.objectContaining({
      code: 'limited',
      message: 'Lookup original opening capacity is full'
    })
  )
  expect(bounded.metadata()).toMatchObject({ bytes: exact, sessions: 1, fences: 1 })
  expect(bounded.opening(epoch, bounded.bySession(value.session)!.fence)).toEqual(value)
})
