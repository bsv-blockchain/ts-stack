import { nativeTestExecutable } from './Brc38NativeTestPath'
import createKnex, { type Knex } from 'knex'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInSeries } from '../../utility/runInSeries'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import { Brc38PublishedProfileNode, requireBrc38NativeProfileTransaction } from './Brc38PublishedProfileNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'

interface RawSession {
  readonly child: ChildProcess
  readonly exit: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>
}
interface RawDriver {
  NativeProfileSqlite: {
    startForClaim(
      executable: string,
      directory: string,
      fixedJson: string,
      binding: string
    ): Promise<Readonly<{ session: RawSession; failure?: unknown }>>
    liveOwned(session: unknown): boolean
    holdsLease(session: unknown, slot: number): boolean
    queryOwned(session: unknown, slot: number, sql: string, bindings: unknown[], safe: boolean): Promise<unknown>
  }
  nativeKnex(knex: typeof createKnex, client: unknown, session: RawSession, slot: number): Knex
  drainStartedNativeSession(session: RawSession): Promise<unknown>
}
const raw: RawDriver = require('./NativeProfileSqlite.cjs')
const executable = nativeTestExecutable()
const capacity = { maximumProfiles: 1, maximumPhysicalBytes: 11534336 }

describe('authenticated original Root and Profile native reacquisition', () => {
  let source: Awaited<ReturnType<typeof completedSource>>
  let stagedSetup: Awaited<ReturnType<typeof previewPrivateFixture>> | undefined
  let restoreSetup: Brc38PrivateNativeRestoreNode | undefined
  let cleanup: Array<() => Promise<void>>
  async function completedSource() {
    const proof = restoreProofFixture()
    const staged = await previewPrivateFixture(undefined, data => restorePortableProof(data, proof), 2097152, 8388608)
    stagedSetup = staged
    const restore = await Brc38PrivateNativeRestoreNode.open(staged.value.reservation.store, {
      receiptPolicy: previewReceiptPolicy,
      maximumStepRows: 16,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096,
      services: proof.services
    })
    restoreSetup = restore
    await runInSeries(
      Array.from({ length: 14 }, (_v, index) => index),
      async fromRow => {
        expect(await restore.step(fromRow)).toMatchObject({ nextRow: fromRow + 1 })
      }
    )
    return {
      proof,
      staged,
      restore,
      store: staged.value.reservation.store,
      admission: restore.admission
    }
  }
  beforeAll(async () => {
    source = await completedSource()
  })
  afterAll(async () => {
    const failures: unknown[] = []
    await runInSeries(
      [async () => await restoreSetup?.close(), async () => await stagedSetup?.close()],
      async close => {
        try {
          await close()
        } catch (cause) {
          failures.push(cause)
        }
      }
    )
    if (failures.length !== 0)
      throw new AggregateError(failures, 'Authenticated native setup retains actual cleanup owners')
  })
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close()))
    const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, 'Authenticated native fixture retains cleanup')
  })
  async function fixture() {
    await source.restore.close()
    await source.store.close()
    const reservation = await source.staged.root.resume(
      source.staged.value.reservation.id,
      source.staged.selected.limits,
      source.staged.selected.binding
    )
    source.staged.held.push(reservation)
    source.store = reservation.store
    const directory = await mkdtemp(join(tmpdir(), 'brc38-authenticated-native-'))
    const root = await Brc38ProfileInventoryNode.create(directory, capacity)
    const extra: Brc38PublishedProfileNode[] = []
    cleanup.push(async () => {
      await runInSeries(extra, async profile => await profile.close())
      await root.close()
      await rm(directory, { recursive: true, force: true })
    })
    const profile = await root.publish(source.store, source.admission)
    const claim = await profile.prepareNativeClaim(root)
    return { root, profile, claim, extra }
  }
  async function stock(directory: string, file: string): Promise<Knex> {
    const k = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, file) },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    cleanup.push(async () => await k.destroy())
    return k
  }
  test('caller backend flags and copied transaction shapes confer no journal authority', () => {
    const pretend = Object.assign(() => undefined, {
      isTransaction: true,
      client: { config: { client: 'better-sqlite3', nativeSlot: 0 } }
    })
    expect(() => requireBrc38NativeProfileTransaction(pretend as unknown as Knex.Transaction)).toThrow(
      'authenticated published-profile'
    )
  })
  test('copied opaque claims are refused before the original stock owner is released', async () => {
    const { profile, claim } = await fixture()
    await expect(Brc38PublishedProfileNode.acquireNativeClaim({ ...claim }, executable)).rejects.toThrow(
      'actual pending'
    )
    expect(profile.ownershipReleased).toBe(false)
    expect(await profile.status()).toMatchObject({ state: 'READY' })
  })
  test('direct reacquisition cannot bypass the actual root operation', async () => {
    const { root, profile, claim } = await fixture()
    await expect(Brc38PublishedProfileNode.reacquireNativeClaim(root, profile, claim, executable)).rejects.toThrow(
      'actual current published inventory operation'
    )
    expect(profile.ownershipReleased).toBe(false)
    expect(await profile.status()).toMatchObject({ state: 'READY' })
  })
  test('a separately released claim cannot authorize acquisition across an unowned gap', async () => {
    const { profile, claim } = await fixture()
    await Brc38PublishedProfileNode.releaseNativeClaim(claim)
    await expect(Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)).rejects.toThrow('actual pending')
    expect(profile.ownershipReleased).toBe(true)
  })
  test('actual reacquisition validates the full receipt and keeps the same managed profile and quota', async () => {
    const { root, profile, claim, extra } = await fixture()
    expect(await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)).toBe(profile)
    expect(profile.ownershipReleased).toBe(false)
    expect(await profile.status()).toMatchObject({ state: 'READY' })
    expect(await root.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
    for (const name of ['db', 'nativeOwner', 'nativeClaim', 'session', 'connection', 'fixed'])
      expect(Object.hasOwn(profile, name)).toBe(false)
    await expect(Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)).rejects.toThrow()
    await profile.close()
    expect(profile.ownershipReleased).toBe(true)
    const recovered = await Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)
    extra.push(recovered)
    expect(await recovered.status()).toMatchObject({ state: 'READY' })
  })
  test('duplicate acquisition and manager activation stay reserved until the activation implementation is qualified', async () => {
    const { profile, claim } = await fixture()
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    await expect(Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)).rejects.toThrow('actual pending')
    await expect(profile.activate(source.proof.services)).rejects.toThrow('reserved for native handoff')
  })
  test('the same root operation stays held through actual native start and full validation', async () => {
    const { root, profile, claim } = await fixture()
    const original = raw.NativeProfileSqlite.startForClaim
    let resume!: () => void, observed!: () => void
    const hold = new Promise<void>(resolve => {
      resume = resolve
    })
    const reached = new Promise<void>(resolve => {
      observed = resolve
    })
    const intercept = jest.spyOn(raw.NativeProfileSqlite, 'startForClaim').mockImplementation(async (...args) => {
      const result = await original.apply(raw.NativeProfileSqlite, args)
      observed()
      await hold
      return result
    })
    const acquiring = Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    try {
      await reached
      await expect(root.close()).rejects.toThrow('actual profile inventory work')
    } finally {
      resume()
      intercept.mockRestore()
    }
    expect(await acquiring).toBe(profile)
    expect(profile.ownershipReleased).toBe(false)
  })
  test('public close and status stay fenced after old physical release until actual native reacquisition settles', async () => {
    const { root, profile, claim } = await fixture()
    const original = Brc38PublishedProfileNode.drainNativeClaim
    const intercept = jest.spyOn(Brc38PublishedProfileNode, 'drainNativeClaim').mockImplementation(async (...args) => {
      const receipt = await original.apply(Brc38PublishedProfileNode, args)
      expect(profile.ownershipReleased).toBe(true)
      await expect(profile.close()).rejects.toThrow('actual native handoff')
      await expect(profile.status()).rejects.toThrow('actual native handoff')
      await expect(root.close()).rejects.toThrow('actual profile inventory work')
      return receipt
    })
    try {
      expect(await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)).toBe(profile)
      expect(await profile.status()).toMatchObject({ state: 'READY' })
    } finally {
      intercept.mockRestore()
    }
  })
  test('an absent pinned executable fails without execution and preserves durable quota after stock drain', async () => {
    const { root, profile, claim, extra } = await fixture()
    await expect(
      Brc38PublishedProfileNode.acquireNativeClaim(claim, '/work/absent-native-executable')
    ).rejects.toThrow()
    expect(profile.ownershipReleased).toBe(true)
    expect(await root.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
    const recovered = await Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)
    extra.push(recovered)
    expect(await recovered.status()).toMatchObject({ state: 'READY' })
  })
  test('an ordinary changed catalog receipt is rejected before native owner acquisition', async () => {
    const { profile, claim } = await fixture()
    const k = await stock(profile.directory, 'profile.sqlite')
    await k('profile').where({ slot: 1 }).update({ state: 'ACTIVATING' })
    await k.destroy()
    await expect(Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)).rejects.toThrow(
      'Original native transfer receipt changed'
    )
    expect(profile.ownershipReleased).toBe(false)
    expect(await profile.status()).toMatchObject({ state: 'ACTIVATING' })
  })
  test('shadowed public observation methods cannot substitute for private producer checks or queries', async () => {
    const { profile, claim } = await fixture()
    const live = jest.spyOn(raw.NativeProfileSqlite, 'liveOwned').mockReturnValue(false)
    const lease = jest.spyOn(raw.NativeProfileSqlite, 'holdsLease').mockReturnValue(false)
    const query = jest
      .spyOn(raw.NativeProfileSqlite, 'queryOwned')
      .mockRejectedValue(new Error('caller observation shadow'))
    try {
      expect(await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)).toBe(profile)
      expect(await profile.status()).toMatchObject({ state: 'READY' })
    } finally {
      live.mockRestore()
      lease.mockRestore()
      query.mockRestore()
    }
  })
  test('healthy process loss preserves the cleanup failure while releasing only after actual physical close', async () => {
    const { root, profile, claim, extra } = await fixture()
    const original = raw.NativeProfileSqlite.startForClaim
    let observed: RawSession | undefined
    const intercept = jest.spyOn(raw.NativeProfileSqlite, 'startForClaim').mockImplementation(async (...args) => {
      const result = await original.apply(raw.NativeProfileSqlite, args)
      observed = result.session
      return result
    })
    try {
      await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    } finally {
      intercept.mockRestore()
    }
    if (observed === undefined) throw new Error('Actual started native session was not observed')
    expect(observed.child.kill('SIGTERM')).toBe(true)
    await observed.exit
    await expect(profile.status()).rejects.toThrow('native owner has stopped')
    await expect(profile.close()).rejects.toThrow('physical cleanup did not finish')
    expect(profile.ownershipReleased).toBe(true)
    expect(await root.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
    const recovered = await Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)
    extra.push(recovered)
    expect(await recovered.status()).toMatchObject({ state: 'READY' })
  })
  test('an actual raw native transaction without the private enrolled factory remains unauthorized', async () => {
    const { claim } = await fixture()
    const receipt = await Brc38PublishedProfileNode.releaseNativeClaim(claim)
    const attempt = await raw.NativeProfileSqlite.startForClaim(
      executable,
      receipt.directory,
      receipt.fixedJson,
      receipt.bindingSha256
    )
    if (Object.hasOwn(attempt, 'failure')) {
      await raw.drainStartedNativeSession(attempt.session)
      throw attempt.failure
    }
    const client: unknown = require('knex/lib/dialects/sqlite3/index.js')
    const k = raw.nativeKnex(createKnex, client, attempt.session, 0)
    try {
      await k.transaction(async trx => {
        expect(() => requireBrc38NativeProfileTransaction(trx)).toThrow('authenticated published-profile')
        expect(await trx('users').count('* as n')).toEqual([{ n: 1 }])
      })
    } finally {
      await k.destroy()
      await raw.drainStartedNativeSession(attempt.session)
    }
  })
})
