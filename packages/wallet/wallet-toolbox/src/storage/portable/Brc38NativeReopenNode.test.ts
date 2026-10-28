import { nativeTestExecutable } from './Brc38NativeTestPath'
import createKnex, { type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../StorageKnex'
import type { StorageProvider } from '../StorageProvider'
import { runInSeries } from '../../utility/runInSeries'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { readRow } from './Brc38PublishedProfileReceiptNode'
import { readBrc38NativeBackend } from './Brc38NativeBackendNode'
import { Brc38ProfileInventoryNode, type Brc38NativeProfileReopenGrant } from './Brc38ProfileInventoryNode'

const executable = nativeTestExecutable()
const capacity = { maximumProfiles: 1, maximumPhysicalBytes: 11534336 }
function nativeStore(store: StorageProvider): StorageKnex {
  if (!(store instanceof StorageKnex)) throw new Error('Expected the actual native StorageKnex provider')
  return store
}

describe('actual inventory native reopen and recoverable WAL transition', () => {
  let source: Awaited<ReturnType<typeof completedSource>>
  let cleanup: Array<() => Promise<void>>
  async function completedSource() {
    const proof = restoreProofFixture()
    const staged = await previewPrivateFixture(undefined, data => restorePortableProof(data, proof), 2097152, 8388608)
    const restore = await Brc38PrivateNativeRestoreNode.open(staged.value.reservation.store, {
      receiptPolicy: previewReceiptPolicy,
      maximumStepRows: 16,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096,
      services: proof.services
    })
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
    await source.restore.close()
    await source.staged.close()
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
    let activeRoot = root
    cleanup.push(async () => {
      await runInSeries(extra, async profile => await profile.close())
      await activeRoot.close()
      await rm(directory, { recursive: true, force: true })
    })
    const profile = await root.publish(source.store, source.admission)
    const claim = await profile.prepareNativeClaim(root)
    return {
      root,
      profile,
      claim,
      extra,
      replaceRoot: (value: Brc38ProfileInventoryNode) => {
        activeRoot = value
      }
    }
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
  test('copied grants and untransitioned receipts confer no native reopen authority', async () => {
    const { root, profile } = await fixture()
    await expect(
      Brc38PublishedProfileNode.openNativeReopen(root, Object.freeze({}) as Brc38NativeProfileReopenGrant, executable)
    ).rejects.toThrow('actual current inventory')
    await expect(profile.promoteNativeWal()).rejects.toThrow('actual authenticated native profile')
    await profile.close()
    await expect(
      root.openNative(source.admission.scope.importId, source.store.binding!.digest, executable)
    ).rejects.toThrow('durable forward backend record')
    expect(await root.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
    expect(
      await (await root.open(source.admission.scope.importId, source.store.binding!.digest)).status()
    ).toMatchObject({ state: 'READY' })
  })
  test('a new actual inventory and native owner reopen completed DELETE activation', async () => {
    const { root, profile, claim, replaceRoot } = await fixture()
    const catalog = await stock(profile.directory, 'profile.sqlite'),
      original = await readRow(catalog)
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    await profile.activateNative(source.proof.services)
    await root.close()
    const reopenedRoot = await Brc38ProfileInventoryNode.reopen(root.directory, capacity)
    replaceRoot(reopenedRoot)
    const recovered = await reopenedRoot.openNative(
      source.admission.scope.importId,
      source.store.binding!.digest,
      executable
    )
    expect(recovered).not.toBe(profile)
    expect(recovered.ownershipReleased).toBe(false)
    const manager = await recovered.activateNative(source.proof.services)
    expect(manager.isActiveEnabled).toBe(true)
    expect(manager.getActiveStore()).toBe(source.store.binding!.binding.targetStorageIdentityKey)
    expect(await readRow(catalog)).toEqual({ ...original, state: 'ACTIVE' })
    expect(await reopenedRoot.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
    await expect(
      reopenedRoot.openNative(source.admission.scope.importId, source.store.binding!.digest, executable)
    ).rejects.toThrow('physically close')
  })
  test('durable WAL promotion and full native reopen preserve original copy lineage', async () => {
    const { root, profile, claim, replaceRoot } = await fixture()
    const catalog = await stock(profile.directory, 'profile.sqlite'),
      original = await readRow(catalog)
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    const manager = await profile.activateNative(source.proof.services)
    await profile.promoteNativeWal()
    await profile.promoteNativeWal()
    expect(
      await manager.runAsStorageProvider(async store => await nativeStore(store).knex.raw('PRAGMA journal_mode'))
    ).toEqual([{ journal_mode: 'wal' }])
    await manager.runAsStorageProvider(async store => {
      expect(
        await nativeStore(store)
          .knex('users')
          .where({ identityKey: source.store.binding!.binding.identityKey })
          .update({ updated_at: new Date(1700000000999) })
      ).toBe(1)
    })
    expect(await profile.status()).toMatchObject({ state: 'ACTIVE' })
    const build = require('./Brc38NativeExecutable.cjs').componentBuild
    expect(await readBrc38NativeBackend(catalog, await readRow(catalog), build)).toMatchObject({
      phase: 'WAL'
    })
    expect(await readRow(catalog)).toEqual({ ...original, state: 'ACTIVE' })
    await root.close()
    await expect(Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)).rejects.toThrow(
      'forward native backend policy'
    )
    const reopenedRoot = await Brc38ProfileInventoryNode.reopen(root.directory, capacity)
    replaceRoot(reopenedRoot)
    const recovered = await reopenedRoot.openNative(
      source.admission.scope.importId,
      source.store.binding!.digest,
      executable
    )
    const recoveredManager = await recovered.activateNative(source.proof.services)
    expect(recoveredManager.isActiveEnabled).toBe(true)
    expect(
      await recoveredManager.runAsStorageProvider(
        async store => await nativeStore(store).knex.raw('PRAGMA journal_mode')
      )
    ).toEqual([{ journal_mode: 'wal' }])
    expect(
      await recoveredManager.runAsStorageProvider(
        async store =>
          await nativeStore(store)
            .knex('users')
            .where({ identityKey: source.store.binding!.binding.identityKey })
            .select('updated_at')
      )
    ).toEqual([{ updated_at: 1700000000999 }])
    expect(await readRow(catalog)).toEqual({ ...original, state: 'ACTIVE' })
    await recovered.promoteNativeWal()
    expect(await recovered.status()).toMatchObject({ state: 'ACTIVE' })
  })
  test('ordinary held SQLite reader leaves a durable pending WAL record and allows retry', async () => {
    const { profile, claim } = await fixture()
    const catalog = await stock(profile.directory, 'profile.sqlite'),
      original = await readRow(catalog)
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    await profile.activateNative(source.proof.services)
    const reader = await stock(profile.directory, 'wallet.sqlite')
    const connection: unknown = await reader.client.acquireConnection()
    try {
      await reader.raw('BEGIN').connection(connection)
      await reader('users').select('userId').connection(connection)
      await expect(profile.promoteNativeWal()).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
      const build = require('./Brc38NativeExecutable.cjs').componentBuild
      expect(await readBrc38NativeBackend(catalog, await readRow(catalog), build)).toMatchObject({
        phase: 'WAL_ACTIVATING'
      })
      expect(await readRow(catalog)).toEqual({ ...original, state: 'ACTIVE' })
    } finally {
      await reader.raw('ROLLBACK').connection(connection)
      await reader.client.releaseConnection(connection)
    }
    await profile.promoteNativeWal()
    expect(await profile.status()).toMatchObject({ state: 'ACTIVE' })
    expect(await readRow(catalog)).toEqual({ ...original, state: 'ACTIVE' })
  })
})
