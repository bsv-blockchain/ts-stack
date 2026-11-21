import { nativeTestExecutable } from './Brc38NativeTestPath'
import createKnex, { type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInSeries } from '../../utility/runInSeries'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import {
  Brc38PublishedProfileNode,
  requireBrc38NativeProfileTransaction,
  requireBrc38NativeProfileReadTransaction,
  type Brc38ComposedTargetInspection
} from './Brc38PublishedProfileNode'
import { requireBrc38PackedRead, requireBrc38PackedWriter } from './Brc38NativePackedSchemaNode'
import { createBrc38ImportProvenanceStore } from './Brc38ImportProvenanceNode'
import { readRow } from './Brc38PublishedProfileReceiptNode'
import { readBrc38NativeBackend } from './Brc38NativeBackendNode'
import { WalletStorageManager } from '../WalletStorageManager'
import { StorageKnex } from '../StorageKnex'
import {
  writeBrc38NativeRetirement,
  readBrc38NativeRetirement,
  type Brc38NativeRetirementRecord
} from './Brc38NativeRetirementNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import type { Brc38NativeBlobWrite } from './Brc38NativeBlobProtocol'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { Brc38RetiredNativeReadNode } from './Brc38RetiredNativeReadNode'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { isOwnedNativeSqlite } from '../schema/ownedNativeSqliteRuntimeNode'
import { beginBrc38NativeLocalCapture, bootstrapBrc38NativeLocalCapturePage } from './Brc38NativeLocalCaptureNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { withManagedBrc38NativeCurrentDataFence } from './Brc38ManagedNativeCurrentDataFenceNode'
import { bootstrapCurrentBrc38NativeObserver } from './Brc38CurrentNativeObserverNode'
import { recoverUncommittedBrc38NativeSource } from './Brc38UncommittedNativeRecoveryNode'
import { readBrc38ComposedDatabaseImage } from './Brc38ComposedDatabaseImageNode'

const executable = nativeTestExecutable()
const capacity = { maximumProfiles: 1, maximumPhysicalBytes: 11534336 }
interface RetiredReadTransport {
  NativeProfileSqlite: {
    startRetiredForReadClaim(
      executable: string,
      directory: string,
      fixedJson: string,
      binding: string
    ): Promise<Readonly<{ session: object; failure?: unknown }>>
  }
  nativeKnex(knex: typeof createKnex, client: unknown, session: object, slot: number): Knex
  isRetiredReadSession(session: object): boolean
  drainStartedNativeSession(session: object): Promise<
    Readonly<{
      failed: boolean
      failure?: unknown
      terminal: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
    }>
  >
}

describe('authenticated native DELETE activation and forward backend record', () => {
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
    const retainedCleanup = new Set<Brc38StagingCleanupError>()
    cleanup.push(async () => {
      // Snapshot the admitted cleanup cohort before awaiting its mutable owners.
      for (const retained of Array.from(retainedCleanup)) {
        await retained.retryCleanup()
        retainedCleanup.delete(retained)
      }
      await runInSeries(extra, async profile => await profile.close())
      await root.close()
      await rm(directory, { recursive: true, force: true })
    })
    const profile = await root.publish(source.store, source.admission)
    const claim = await profile.prepareNativeClaim(root)
    return { root, profile, claim, extra, retainedCleanup }
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
  test('stock and copied profile shapes cannot activate a native owner', async () => {
    const { profile } = await fixture()
    await expect(profile.activateNative(source.proof.services)).rejects.toThrow('actual authenticated native profile')
    await expect(
      Brc38PublishedProfileNode.prototype.activateNative.call({ ...profile }, source.proof.services)
    ).rejects.toThrow()
    expect(await profile.status()).toMatchObject({ state: 'READY' })
  })
  test('actual native DELETE activation retains original receipts, manager identity, quota and stock refusal', async () => {
    const { root, profile, claim } = await fixture()
    const catalog = await stock(profile.directory, 'profile.sqlite')
    const before = await readRow(catalog)
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    const manager = await profile.activateNative(source.proof.services)
    expect(manager.isActiveEnabled).toBe(true)
    expect(manager.getActiveUser().identityKey).toBe(source.store.binding!.binding.identityKey)
    expect(manager.getActiveStore()).toBe(source.store.binding!.binding.targetStorageIdentityKey)
    expect(await profile.activateNative(source.proof.services)).toBe(manager)
    expect(await profile.status()).toMatchObject({ state: 'ACTIVE' })
    const after = await readRow(catalog)
    expect(after).toEqual({ ...before, state: 'ACTIVE' })
    const build = require('./Brc38NativeExecutable.cjs').componentBuild
    expect(await readBrc38NativeBackend(catalog, after, build)).toMatchObject({
      phase: 'DELETE_ACTIVE',
      fixedSha256: before.fixedSha256,
      copySha256: before.copySha256,
      copyBytes: before.copyBytes
    })
    const wallet = await stock(profile.directory, 'wallet.sqlite')
    expect(await wallet.raw('PRAGMA journal_mode')).toEqual([{ journal_mode: 'delete' }])
    expect(await root.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
    await profile.close()
    expect(profile.ownershipReleased).toBe(true)
    await expect(Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)).rejects.toThrow(
      'forward native backend policy'
    )
    expect(await wallet.raw('PRAGMA journal_mode')).toEqual([{ journal_mode: 'delete' }])
  })
  test('durable ACTIVATING and the actual Root operation precede manager work and survive an ordinary failure', async () => {
    const { root, profile, claim } = await fixture()
    const catalog = await stock(profile.directory, 'profile.sqlite')
    const before = await readRow(catalog)
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    const original = WalletStorageManager.prototype.makeAvailable
    let reached!: () => void, resume!: () => void
    const seen = new Promise<void>(resolve => {
      reached = resolve
    })
    const held = new Promise<void>(resolve => {
      resume = resolve
    })
    const intercept = jest
      .spyOn(WalletStorageManager.prototype, 'makeAvailable')
      .mockImplementationOnce(async function () {
        reached()
        await held
        throw new Error('ordinary manager availability failure')
      })
    const activating = profile.activateNative(source.proof.services)
    try {
      await seen
      expect(await readRow(catalog)).toEqual({ ...before, state: 'ACTIVATING' })
      const build = require('./Brc38NativeExecutable.cjs').componentBuild
      expect(await readBrc38NativeBackend(catalog, await readRow(catalog), build)).toMatchObject({
        phase: 'DELETE_ACTIVATING',
        copySha256: before.copySha256
      })
      await expect(root.close()).rejects.toThrow('actual profile inventory work')
      await expect(profile.close()).rejects.toThrow('published profile I/O')
      await expect(profile.activateNative(source.proof.services)).rejects.toThrow()
    } finally {
      resume()
      intercept.mockRestore()
    }
    await expect(activating).rejects.toThrow('ordinary manager availability failure')
    expect(profile.ownershipReleased).toBe(false)
    const manager = await profile.activateNative(source.proof.services)
    expect(manager.isActiveEnabled).toBe(true)
    expect(await readRow(catalog)).toEqual({ ...before, state: 'ACTIVE' })
    expect(WalletStorageManager.prototype.makeAvailable).toBe(original)
  })
  test('a real no-decision freeze recovers the same full typed wallet and original manager', async () => {
    const { root, profile, claim, extra, retainedCleanup } = await fixture()
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    const manager = await profile.activateNative(source.proof.services)
    await profile.promoteNativeWal()
    const provider = manager.getActive(),
      primary = manager.getActiveStore()
    if (!(provider instanceof StorageKnex)) throw new Error('Actual native source provider required')
    // Legacy primary selection updates the durable timestamp while its manager
    // cache refreshes activeStorage. Recovery preserves the actual wallet row.
    const user = await provider.findUserById(manager.getActiveUser().userId)
    if (user === undefined) throw new Error('Actual original native user missing')
    expect(manager.getActiveUser()).toMatchObject({
      userId: user.userId,
      identityKey: user.identityKey,
      activeStorage: user.activeStorage
    })
    const workingAllocation = new Brc38WorkingAllocation(4194304),
      policy = {
        workingAllocation,
        maximumReadBytes: 1024,
        expiresAt: Date.now() + 120000
      },
      driver = require('./NativeProfileSqlite.cjs') as { createOwnedNativeReadDatabase(root: Knex): Knex }
    const image = async (actual: StorageKnex) => {
      const reader = driver.createOwnedNativeReadDatabase(actual.knex)
      try {
        return await reader.transaction(
          async read =>
            await readBrc38ComposedDatabaseImage(
              read,
              { ...policy, maximumPhysicalBytes: source.store.limits.maximumPhysicalBytes },
              () => requireBrc38NativeProfileReadTransaction(read)
            )
        )
      } finally {
        await reader.destroy()
      }
    }
    const before = await image(provider)
    await expect(
      manager.withOwnedProviderTransition(provider, policy, async transition => {
        manager.blockRetiringProviderInTransition(transition)
        await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(
          provider,
          async writer =>
            await Brc38PublishedProfileNode.freezeNativeSourceRetirementWriter(provider, manager, writer, transition),
          transition
        )
        throw new Error('Fixture lost acknowledgement before catalog retirement')
      })
    ).rejects.toThrow('lost acknowledgement before catalog retirement')
    expect(manager.isActiveEnabled).toBe(false)
    await expect(manager.runAsReader(async () => undefined)).rejects.toThrow()
    try {
      const recovered = await recoverUncommittedBrc38NativeSource({
        originalProfile: profile,
        originalProvider: provider,
        manager,
        inventory: root,
        executable,
        readPolicy: policy,
        receiptPolicy: previewReceiptPolicy,
        services: source.proof.services
      })
      extra.push(recovered.profile)
      expect(recovered.manager).toBe(manager)
      expect(recovered.provider).not.toBe(provider)
      expect(manager.getActive()).toBe(recovered.provider)
      expect(manager.getActiveUser()).toEqual(user)
      expect(manager.getActiveStore()).toBe(primary)
      expect(manager.isActiveEnabled).toBe(true)
      expect(await image(recovered.provider)).toEqual(before)
      expect(profile.ownershipReleased).toBe(true)
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) retainedCleanup.add(cause)
      throw cause
    }
    expect(workingAllocation.used).toBe(0)
  })
  test('fresh retirement ABI refuses cloned managers and closed writers; the live kernel fences a durably retired source', async () => {
    const { root, profile, claim, retainedCleanup } = await fixture(),
      catalog = await stock(profile.directory, 'profile.sqlite')
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    const manager = await profile.activateNative(source.proof.services)
    await profile.promoteNativeWal()
    const provider = manager.getActive(),
      originalUser = manager.getActiveUser(),
      originalStore = manager.getActiveStore()
    if (!(provider instanceof StorageKnex)) throw new Error('Actual native wallet provider required')
    const observerWorking = new Brc38WorkingAllocation(262144),
      observerOptions = {
        maximumRows: 1024,
        ceiling: snapshotJournalRevision('10000'),
        maximumStepRows: 16,
        maximumOperations: 1024,
        expiresAt: Date.now() + 60000,
        workingAllocation: observerWorking
      }
    await expect(
      bootstrapCurrentBrc38NativeObserver(
        Object.freeze({ ...profile }) as Brc38PublishedProfileNode,
        provider,
        manager,
        root,
        observerOptions
      ).next()
    ).rejects.toThrow('Actual original native source profile')
    expect(observerWorking.used).toBe(0)
    await manager.withOwnedProviderTransition(provider, { expiresAt: Date.now() + 60000 }, async transition => {
      await expect(
        Brc38PublishedProfileNode.closeUncommittedNativeOriginal(profile, provider, manager, transition, root)
      ).rejects.toThrow('actual idle blocked original manager/profile')
      await expect(
        Brc38PublishedProfileNode.closeRetiredNativeManagedOriginal(profile, provider, manager, transition, root)
      ).rejects.toThrow('actual blocked original manager')
      await expect(
        Brc38PublishedProfileNode.closeRetiredNativeManagedOriginal(
          Object.freeze({ ...profile }) as Brc38PublishedProfileNode,
          provider,
          manager,
          transition,
          root
        )
      ).rejects.toThrow('actual blocked original manager')
    })
    await expect(
      bootstrapCurrentBrc38NativeObserver(
        profile,
        provider,
        Object.freeze({ ...manager }) as WalletStorageManager,
        root,
        observerOptions
      ).next()
    ).rejects.toThrow('original activated manager')
    expect(observerWorking.used).toBe(0)
    await expect(
      bootstrapCurrentBrc38NativeObserver(
        profile,
        provider,
        manager,
        Object.freeze({ ...root }) as Brc38ProfileInventoryNode,
        observerOptions
      ).next()
    ).rejects.toThrow('different actual native inventory')
    expect(observerWorking.used).toBe(0)
    await expect(profile.activateCompletedComposedNative(source.proof.services)).rejects.toThrow(
      'actual current native reopen'
    )
    const restartPolicy = { workingAllocation: observerWorking, maximumReadBytes: 1024, expiresAt: Date.now() + 60000 }
    await expect(
      Brc38ProfileInventoryNode.prototype.openCompletedComposedNativeFromInventory.call(
        Object.freeze({ ...root }) as Brc38ProfileInventoryNode,
        '00000000-0000-4000-8000-000000000001',
        source.store.binding!.digest,
        executable,
        root,
        previewReceiptPolicy,
        restartPolicy
      )
    ).rejects.toThrow('actual source and target profile inventories')
    await expect(
      Brc38ProfileInventoryNode.withRetiredNativeInventoryRead(
        Object.freeze({ ...root }) as Brc38ProfileInventoryNode,
        { rootId: root.rootId, profileId: '00000000-0000-4000-8000-000000000001', policySha256: 'a'.repeat(64) },
        executable,
        restartPolicy,
        async () => {
          throw new Error('Cloned inventory must never reach source I/O')
        }
      )
    ).rejects.toThrow('Actual retired source inventory')
    await expect(
      root.openCompletedComposedNative(
        '00000000-0000-4000-8000-000000000001',
        source.store.binding!.digest,
        executable,
        Object.freeze({}) as Brc38NativeLocalBaselineSource
      )
    ).rejects.toThrow()
    await expect(
      Brc38ProfileInventoryNode.prototype.recoverPendingComposedNative.call(
        Object.freeze({ ...root }) as Brc38ProfileInventoryNode,
        '00000000-0000-4000-8000-000000000001',
        source.store.binding!.digest,
        executable,
        Object.freeze({}) as Parameters<Brc38ProfileInventoryNode['recoverPendingComposedNative']>[3],
        source.store,
        Object.freeze({}) as Brc38NativeLocalBaselineSource,
        source.proof.services
      )
    ).rejects.toThrow('Actual pending target inventory')
    await expect(
      root.recoverPendingComposedNative(
        '00000000-0000-4000-8000-000000000001',
        source.store.binding!.digest,
        executable,
        Object.freeze({}) as Parameters<Brc38ProfileInventoryNode['recoverPendingComposedNative']>[3],
        source.store,
        Object.freeze({}) as Brc38NativeLocalBaselineSource,
        source.proof.services
      )
    ).rejects.toThrow()
    const copiedRoot = Object.freeze({ ...root }) as Brc38ProfileInventoryNode,
      scratchPolicy = {
        ...restartPolicy,
        privateParent: root.directory,
        maximumPhysicalBytes: source.store.limits.maximumPhysicalBytes,
        temporaryQuota: new (await import('./Brc38NativeRecoveryScratchNode')).Brc38NativeRecoveryTemporaryQuota(
          16777216
        )
      }
    let expiredCopyEntered = false
    await expect(
      Brc38ProfileInventoryNode.prototype.withExpiredPendingRecoveryCopy.call(
        copiedRoot,
        '00000000-0000-4000-8000-000000000001',
        source.store.binding!.digest,
        executable,
        Object.freeze({}) as Brc38NativeLocalBaselineSource,
        scratchPolicy,
        async () => {
          expiredCopyEntered = true
        }
      )
    ).rejects.toThrow('Actual expired recovery inventory')
    await expect(
      root.withExpiredPendingRecoveryCopy(
        '00000000-0000-4000-8000-000000000001',
        source.store.binding!.digest,
        executable,
        Object.freeze({}) as Brc38NativeLocalBaselineSource,
        scratchPolicy,
        async () => {
          expiredCopyEntered = true
        }
      )
    ).rejects.toThrow()
    expect(expiredCopyEntered).toBe(false)
    expect(scratchPolicy.temporaryQuota.used).toBe(0)
    const fakeReopen = Object.freeze({}) as Parameters<
      typeof Brc38ProfileInventoryNode.reissueReleasedPendingCopyGrant
    >[1]
    await expect(Brc38ProfileInventoryNode.reissueReleasedPendingCopyGrant(root, fakeReopen, profile)).rejects.toThrow(
      'exact retained inventory operation'
    )
    expect(() => Brc38PublishedProfileNode.assertReleasedPendingRecoveryCopy(root, fakeReopen, profile)).toThrow(
      'physically closed copy owner'
    )
    const absentInspection = Object.freeze({}) as Brc38ComposedTargetInspection
    await expect(
      root.withdrawInactiveComposed(
        source.admission.scope.importId,
        source.store.binding!.digest,
        profile,
        provider,
        manager,
        root,
        { expiresAt: Date.now() + 60000 }
      )
    ).rejects.toThrow('actual idle inactive composed target')
    await expect(
      profile.discardInactiveComposedOwned({
        directory: profile.directory,
        bindingSha256: source.store.binding!.digest,
        inventory: {
          rootId: root.rootId,
          profileId: '00000000-0000-4000-8000-000000000001',
          policySha256: 'a'.repeat(64)
        }
      })
    ).rejects.toThrow('actual inactive composed withdrawal grant')
    expect(manager.getActive()).toBe(provider)
    expect(manager.isActiveEnabled).toBe(true)
    expect(() => Brc38PublishedProfileNode.assertComposedTargetInspection(profile, absentInspection)).toThrow(
      'actual retained read scope'
    )
    expect(() => Brc38PublishedProfileNode.readComposedInspectionTarget(profile, absentInspection)).toThrow(
      'actual retained read scope'
    )
    expect(() =>
      Brc38PublishedProfileNode.assertComposedTargetInspection(
        Object.freeze({ ...profile }) as Brc38PublishedProfileNode,
        absentInspection
      )
    ).toThrow('Actual composed target profile')
    expect(() =>
      Brc38PublishedProfileNode.retireNativeSourceFromComposedInspection(
        profile,
        absentInspection,
        Object.freeze({}) as Brc38NativeLocalBaselineSource,
        manager,
        Object.freeze({}) as Parameters<typeof Brc38PublishedProfileNode.retireNativeSourceFromComposedInspection>[4],
        Object.freeze({}) as Knex.Transaction
      )
    ).toThrow('actual retained read scope')
    await expect(
      Brc38PublishedProfileNode.assertPreparedNativeSnapshotProvider(
        profile,
        provider,
        Object.freeze({}) as Parameters<typeof Brc38PublishedProfileNode.assertPreparedNativeSnapshotProvider>[2]
      )
    ).rejects.toThrow('actual forward WAL scope')
    expect(() =>
      Brc38ProfileInventoryNode.admitAndReplaceRetiredComposedTarget(
        Object.freeze({ ...root }) as Brc38ProfileInventoryNode,
        profile,
        Object.freeze({}) as Parameters<typeof Brc38ProfileInventoryNode.admitAndReplaceRetiredComposedTarget>[2],
        source.store,
        Object.freeze({}) as Brc38NativeLocalBaselineSource,
        profile,
        provider,
        manager,
        Object.freeze({}) as Parameters<typeof Brc38ProfileInventoryNode.admitAndReplaceRetiredComposedTarget>[8],
        executable,
        source.proof.services
      )
    ).toThrow('Actual composed native target inventory')
    const driver = require('./NativeProfileSqlite.cjs') as {
      writeOwnedNativeBlob(trx: Knex.Transaction, input: Brc38NativeBlobWrite): Promise<unknown>
      withOwnedNativeImmediateWriter<T>(root: Knex, work: (writer: Knex.Transaction) => Promise<T>): Promise<T>
      createOwnedNativeReadDatabase(root: Knex): Knex
    }
    // Ongoing provider membership is checked after activation's inventory
    // operation has ended. Transfer-operation membership stays separate.
    await Brc38PublishedProfileNode.assertNativeSnapshotProvider(profile, provider)
    const competitor = await stock(profile.directory, 'wallet.sqlite')
    await competitor.raw('PRAGMA busy_timeout=0')
    const originalDataVersion = await competitor.raw('PRAGMA data_version')
    await manager.runAsWriter(async active => {
      expect(active).toBe(provider)
      await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(provider, async writer => {
        requireBrc38NativeProfileTransaction(writer)
        expect(await writer('users').select('userId').limit(2)).toHaveLength(1)
        await expect(competitor.raw('BEGIN IMMEDIATE')).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
      })
    })
    expect(await competitor.raw('PRAGMA data_version')).toEqual(originalDataVersion)
    await expect(
      driver.withOwnedNativeImmediateWriter(
        Object.assign(() => undefined, { ...provider.knex }) as unknown as Knex,
        async () => undefined
      )
    ).rejects.toThrow('actual live Root0')
    const readonly = driver.createOwnedNativeReadDatabase(provider.knex)
    try {
      await expect(driver.withOwnedNativeImmediateWriter(readonly, async () => undefined)).rejects.toThrow(
        'actual live Root0'
      )
    } finally {
      await readonly.destroy()
    }
    await expect(
      Brc38ProfileInventoryNode.withRetiredNativeProfileRead(
        root,
        profile,
        executable,
        { expiresAt: Date.now() + 60000, maximumReadBytes: 17, workingAllocation: new Brc38WorkingAllocation(4194304) },
        async () => undefined
      )
    ).rejects.toThrow('still owns its physical provider')
    const captureWorking = new Brc38WorkingAllocation(4194304),
      capturePolicy = {
        maximumRows: 1024,
        ceiling: snapshotJournalRevision('100000'),
        maximumPageRows: 16,
        expiresAt: Date.now() + 120000,
        workingAllocation: captureWorking
      },
      selection = {
        identityKey: source.store.binding!.binding.identityKey,
        chain: source.store.binding!.binding.chain,
        targetStorageIdentityKey: source.store.binding!.binding.targetStorageIdentityKey,
        mode: 'merge' as const
      }
    let captured = await manager.runAsWriter(async active => {
      expect(active).toBe(provider)
      return await beginBrc38NativeLocalCapture(provider, selection, previewReceiptPolicy, capturePolicy)
    })
    for (let page = 0; !captured.complete && page < 128; page++)
      captured = await manager.runAsWriter(async active => {
        expect(active).toBe(provider)
        return await bootstrapBrc38NativeLocalCapturePage(provider, selection, previewReceiptPolicy, capturePolicy)
      })
    expect(captured).toMatchObject({ enabled: true, complete: true, revision: '0' })
    expect(captureWorking.used).toBe(0)
    // Exercise the retained bridge with the genuine activated provider/source
    // and actual manager queue. The callback does not publish or activate.
    await Brc38NativeLocalBaselineSource.with(
      provider,
      selection,
      previewReceiptPolicy,
      {
        workingAllocation: captureWorking,
        maximumMetadataBytes: 65536,
        maximumReadBytes: 17,
        expiresAt: Date.now() + 60000
      },
      async retained => {
        const forbidden = jest.fn(async () => 'forbidden')
        await expect(
          withManagedBrc38NativeCurrentDataFence(
            Object.freeze({ ...manager }) as WalletStorageManager,
            retained,
            forbidden
          )
        ).rejects.toThrow()
        await expect(
          withManagedBrc38NativeCurrentDataFence(
            manager,
            Object.freeze({ ...retained }) as Brc38NativeLocalBaselineSource,
            forbidden
          )
        ).rejects.toThrow()
        expect(forbidden).not.toHaveBeenCalled()
        const final = await withManagedBrc38NativeCurrentDataFence(manager, retained, async () => {
          expect(manager.getActive()).toBe(provider)
          await expect(competitor.raw('BEGIN IMMEDIATE')).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
          return 'prepared-catalog-callback'
        })
        expect(final).toMatchObject({ current: true, value: 'prepared-catalog-callback' })
      }
    )
    expect(captureWorking.used).toBe(0)
    const initialPrimary = (await manager.runAsWriter(async active => {
      expect(active).toBe(provider)
      return await provider.knex.transaction(
        async writer =>
          await writer('snapshot_sync_primary_epochs')
            .where({ userId: originalUser.userId })
            .select(writer.raw('CAST(epoch AS TEXT) AS epoch'))
            .limit(2)
      )
    })) as Array<{ epoch: string }>
    expect(initialPrimary).toHaveLength(1)
    const before = await readRow(catalog)
    const record: Brc38NativeRetirementRecord = {
      protocol: 'brc38-native-retirement/v1',
      decisionId: '00000000-0000-4000-8000-000000000011',
      source: {
        fixedSha256: before.fixedSha256,
        copySha256: before.copySha256!,
        copyBytes: before.copyBytes!,
        epoch: captured.epoch,
        revision: snapshotJournalRevision('1'),
        primaryEpoch: snapshotJournalRevision(initialPrimary[0].epoch)
      },
      target: {
        rootId: '00000000-0000-4000-8000-000000000013',
        profileId: '00000000-0000-4000-8000-000000000014',
        fixedSha256: 'b'.repeat(64),
        copySha256: 'c'.repeat(64),
        copyBytes: 4096
      }
    }
    // These target/source coordinates are catalog fixture DATA. This exercises
    // kernel retirement sequencing, never a claimed full program cutover.
    // A real prior wallet mutation must settle BEFORE the separate final
    // retirement transaction. Even a same-value update changes the clock.
    await manager.runAsWriter(async active => {
      expect(active).toBe(provider)
      await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(provider, async writer => {
        await writer('users').where({ userId: originalUser.userId }).update({ activeStorage: originalStore })
        await expect(
          Brc38PublishedProfileNode.freezeNativeSourceRetirementWriter(provider, manager, writer)
        ).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
        expect(await readBrc38NativeRetirement(catalog)).toBeUndefined()
      })
    })
    let escaped: Knex.Transaction | undefined
    await manager.withOwnedProviderTransition(provider, { expiresAt: Date.now() + 60000 }, async transition => {
      await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(
        provider,
        async writer => {
          escaped = writer
          await expect(
            Brc38PublishedProfileNode.requireNativeRetirementWriter(
              provider,
              Object.freeze({ ...manager }) as WalletStorageManager,
              writer,
              transition
            )
          ).rejects.toThrow()
          await Brc38PublishedProfileNode.requireNativeRetirementWriter(provider, manager, writer, transition)
          manager.blockRetiringProviderInTransition(transition)
          expect(manager.isActiveEnabled).toBe(false)
          await Brc38PublishedProfileNode.freezeNativeSourceRetirementWriter(provider, manager, writer, transition)
          // The physical fence is already effective while the catalog remains
          // ACTIVE. No held writer, savepoint or blob request may mutate it.
          expect(await readBrc38NativeRetirement(catalog)).toBeUndefined()
          expect((await readRow(catalog)).state).toBe('ACTIVE')
          await expect(
            writer('users').where({ userId: originalUser.userId }).update({ activeStorage: originalStore })
          ).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
          await expect(writer.raw('SAVEPOINT cannot_restart_frozen_source')).rejects.toMatchObject({
            code: 'SQLITE_AUTH'
          })
          await expect(
            driver.writeOwnedNativeBlob(writer, {
              table: 'outputs',
              field: 'lockingScript',
              rowId: 1,
              offset: 0,
              totalBytes: 1,
              bytes: new Uint8Array([81])
            })
          ).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
          // Only fixture catalog DATA is committed here. This does not exercise
          // full target semantics or install a composed replacement provider.
          await catalog.transaction(async trx => await writeBrc38NativeRetirement(trx, record))
          expect(await readBrc38NativeRetirement(catalog)).toEqual(record)
          expect(await writer('users').where({ userId: originalUser.userId }).select('identityKey')).toHaveLength(1)
        },
        transition
      )
    })
    await expect(Brc38PublishedProfileNode.requireNativeRetirementWriter(provider, manager, escaped!)).rejects.toThrow()
    await expect(provider.knex.transaction(async _writer => undefined)).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
    await expect(driver.withOwnedNativeImmediateWriter(provider.knex, async () => undefined)).rejects.toMatchObject({
      code: 'SQLITE_AUTH'
    })
    await expect(manager.makeAvailable()).rejects.toThrow()
    await profile.close()
    expect(profile.ownershipReleased).toBe(true)
    await expect(Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)).rejects.toThrow()
    // UNRUN new ABI. This is an actual physically reopened read-only recovery
    // process, still only fixture retirement DATA and never target selection.
    const retiredDriver = require('./NativeProfileSqlite.cjs') as RetiredReadTransport,
      attempt = await retiredDriver.NativeProfileSqlite.startRetiredForReadClaim(
        executable,
        profile.directory,
        before.fixedJson,
        source.store.binding!.digest
      ),
      client: unknown = require('knex/lib/dialects/sqlite3/index.js')
    let reader: Knex | undefined,
      retiredCatalog: Knex | undefined,
      writer: Knex | undefined,
      failed = false,
      failure: unknown
    const drain = async (): Promise<void> => {
      // Never remove original files while a real facade/process remains.
      const facades = await Promise.allSettled([reader?.destroy(), retiredCatalog?.destroy(), writer?.destroy()]),
        errors = facades.flatMap(value => (value.status === 'rejected' ? [value.reason] : []))
      if (errors.length !== 0) throw new AggregateError(errors, 'Retired read facade cleanup remains required')
      const terminal = await retiredDriver.drainStartedNativeSession(attempt.session)
      if (terminal.failed) throw terminal.failure ?? new Error('Retired read kernel physical drain failed')
    }
    try {
      if (attempt.failure !== undefined) throw attempt.failure
      expect(retiredDriver.isRetiredReadSession(attempt.session)).toBe(true)
      reader = retiredDriver.nativeKnex(createKnex, client, attempt.session, 3)
      retiredCatalog = retiredDriver.nativeKnex(createKnex, client, attempt.session, 2)
      expect(await readBrc38NativeRetirement(retiredCatalog)).toEqual(record)
      await reader.transaction(async read => {
        expect(await read('users').where({ userId: source.admission.scope.userId }).select('identityKey')).toEqual([
          { identityKey: source.staged.selected.binding.identityKey }
        ])
        await expect(read('users').update({ activeStorage: '' })).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
        await expect(read.raw('CREATE TABLE forbidden_retired_write(value)')).rejects.toMatchObject({
          code: 'SQLITE_AUTH'
        })
        await expect(read.raw('PRAGMA wal_checkpoint')).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
        await expect(read.raw('PRAGMA journal_mode=DELETE')).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
      })
      await expect(retiredCatalog('profile_retired').update({ recordSha256: 'e'.repeat(64) })).rejects.toMatchObject({
        code: 'SQLITE_AUTH'
      })
      writer = retiredDriver.nativeKnex(createKnex, client, attempt.session, 0)
      await expect(writer.transaction(async _write => undefined)).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
      expect(await readBrc38NativeRetirement(retiredCatalog)).toEqual(record)
    } catch (cause) {
      failed = true
      failure = cause
    }
    try {
      await drain()
    } catch (cause) {
      const retained = new Brc38StagingCleanupError(
        [...(failed ? [failure] : []), cause],
        'Retired recovery fixture retains actual physical cleanup',
        drain
      )
      retainedCleanup.add(retained)
      throw retained
    }
    expect(retiredDriver.isRetiredReadSession(attempt.session)).toBe(false)
    // The original inventory operation issues the only reader grant. These
    // real factory cases exercise lifecycle and full physical drainage only;
    // the fixture retirement coordinates above remain DATA, not cutover proof.
    const workingAllocation = new Brc38WorkingAllocation(4194304),
      policy = {
        expiresAt: Date.now() + 60000,
        maximumReadBytes: 17,
        workingAllocation
      },
      binding = source.store.binding!.digest
    let escapedReader: Brc38RetiredNativeReadNode | undefined,
      escapedRead: Knex.Transaction | undefined,
      escapedSource: Brc38NativeLocalBaselineSource | undefined
    await expect(
      Brc38ProfileInventoryNode.withRetiredNativeRead(
        Object.freeze({ ...root }) as Brc38ProfileInventoryNode,
        source.admission.scope.importId,
        binding,
        executable,
        policy,
        async () => undefined
      )
    ).rejects.toThrow('actual profile inventory')
    expect(workingAllocation.used).toBe(0)
    await Brc38ProfileInventoryNode.withRetiredNativeRead(
      root,
      source.admission.scope.importId,
      binding,
      executable,
      policy,
      async actual => {
        escapedReader = actual
        expect(await Brc38RetiredNativeReadNode.readRetirement(actual)).toEqual(record)
        expect(() =>
          Brc38RetiredNativeReadNode.readRetirement(Object.freeze({ ...actual }) as Brc38RetiredNativeReadNode)
        ).toThrow()
        await Brc38RetiredNativeReadNode.withWalletRead(actual, async read => {
          escapedRead = read
          expect(Brc38RetiredNativeReadNode.isReadTransaction(read)).toBe(true)
          expect(isOwnedNativeSqlite(read)).toBe(true)
          requireBrc38NativeProfileReadTransaction(read)
          requireBrc38PackedRead(read)
          expect(() => requireBrc38NativeProfileTransaction(read)).toThrow()
          expect(() => requireBrc38PackedWriter(read)).toThrow('Retired source inspection cannot write')
          await expect(createBrc38ImportProvenanceStore('legacy', 'retired-read').install(read)).rejects.toThrow(
            'cannot install content'
          )
          expect(
            Brc38RetiredNativeReadNode.isReadTransaction(
              Object.assign(() => undefined, { ...read }) as unknown as Knex.Transaction
            )
          ).toBe(false)
          expect(await read('users').where({ userId: originalUser.userId }).select('identityKey')).toEqual([
            { identityKey: originalUser.identityKey }
          ])
          const original = await Brc38RetiredNativeReadNode.readSourceLineageInWalletScope(actual, read)
          expect(original).toMatchObject({
            inventory: JSON.parse(before.fixedJson).inventory,
            fixedSha256: before.fixedSha256,
            copySha256: before.copySha256,
            copyBytes: before.copyBytes,
            retirement: record
          })
          expect(() =>
            Brc38RetiredNativeReadNode.readSourceLineageInWalletScope(
              Object.freeze({ ...actual }) as Brc38RetiredNativeReadNode,
              read
            )
          ).toThrow()
        })
        expect(() => Brc38RetiredNativeReadNode.readSourceLineageInWalletScope(actual, escapedRead!)).toThrow()
        await Brc38NativeLocalBaselineSource.withRetired(
          actual,
          previewReceiptPolicy,
          { ...policy, maximumMetadataBytes: 131072 },
          async historical => {
            escapedSource = historical
            expect(historical.generation).toMatchObject({
              epoch: captured.epoch,
              revision: '1',
              complete: true,
              enabled: true
            })
            expect(historical.fence).toMatchObject({
              ...selection,
              userId: originalUser.userId,
              activeStorage: selection.targetStorageIdentityKey,
              primaryEpoch: initialPrimary[0].epoch
            })
            expect(() => Brc38NativeLocalBaselineSource.inspectCurrent(historical)).toThrow()
            expect(() => Brc38NativeLocalBaselineSource.assertManagedSource(historical, manager)).toThrow()
            const original = await Brc38NativeLocalBaselineSource.retiredCompositionOrigin(historical)
            expect(original).toEqual({
              source: {
                inventory: JSON.parse(before.fixedJson).inventory,
                fixedSha256: before.fixedSha256,
                copySha256: before.copySha256,
                copyBytes: before.copyBytes,
                epoch: captured.epoch,
                revision: '1',
                primaryEpoch: String(initialPrimary[0].epoch),
                userId: originalUser.userId,
                activeStorage: selection.targetStorageIdentityKey
              },
              retirement: record
            })
            const users = await historical.page('users', null, 1)
            expect(users).toEqual([originalUser.userId])
            await historical.withRow('users', users[0], async row => {
              expect(row.metadata.identityKey).toBe(source.store.binding!.binding.identityKey)
            })
            const journals = await Brc38NativeLocalBaselineSource.ownedPriorImportPage(
              historical,
              'brc38_import_journal',
              null,
              1
            )
            expect(journals.present).toBe(true)
            expect(journals.rows).toHaveLength(1)
            await Brc38NativeLocalBaselineSource.withOwnedPriorImportRow(
              historical,
              'brc38_import_journal',
              journals.rows[0],
              async original => expect(original.metadata.importId).toBe(source.admission.scope.importId)
            )
          }
        )
      }
    )
    expect(workingAllocation.used).toBe(0)
    await expect(escapedSource!.page('users', null, 1)).rejects.toThrow()
    expect(() => Brc38NativeLocalBaselineSource.retiredCompositionOrigin(escapedSource!)).toThrow()
    expect(Brc38RetiredNativeReadNode.isReadTransaction(escapedRead!)).toBe(false)
    await expect(Brc38RetiredNativeReadNode.readRetirement(escapedReader!)).rejects.toThrow()
    // Cancellation revokes the live callback and still drains its true kernel
    // and read transaction. A subsequent independently bounded read can open.
    const controller = new AbortController()
    await expect(
      Brc38ProfileInventoryNode.withRetiredNativeRead(
        root,
        source.admission.scope.importId,
        binding,
        executable,
        { ...policy, signal: controller.signal },
        async () => controller.abort()
      )
    ).rejects.toThrow()
    expect(workingAllocation.used).toBe(0)
    await Brc38ProfileInventoryNode.withRetiredNativeRead(
      root,
      source.admission.scope.importId,
      binding,
      executable,
      policy,
      async actual => expect(await Brc38RetiredNativeReadNode.readRetirement(actual)).toEqual(record)
    )
    expect(workingAllocation.used).toBe(0)
    await Brc38ProfileInventoryNode.withRetiredNativeProfileRead(root, profile, executable, policy, async actual =>
      expect(await Brc38RetiredNativeReadNode.readRetirement(actual)).toEqual(record)
    )
    expect(workingAllocation.used).toBe(0)
    if (failed) throw failure
  }, 60000)
  test('a real ACTIVE source cannot enter the separate retired read mode after physical close', async () => {
    const { profile, claim, retainedCleanup } = await fixture(),
      catalog = await stock(profile.directory, 'profile.sqlite')
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    await profile.activateNative(source.proof.services)
    await profile.promoteNativeWal()
    const before = await readRow(catalog)
    await profile.close()
    const retiredDriver = require('./NativeProfileSqlite.cjs') as RetiredReadTransport,
      attempt = await retiredDriver.NativeProfileSqlite.startRetiredForReadClaim(
        executable,
        profile.directory,
        before.fixedJson,
        source.store.binding!.digest
      )
    const drain = async (): Promise<void> => {
      const actual = await retiredDriver.drainStartedNativeSession(attempt.session)
      // Refused bootstrap is expected. The actual close event/descriptor drain
      // must still settle rather than abandoning its physical claim.
      if (actual.terminal.code === null && actual.terminal.signal === null)
        throw new Error('Refused retired read attempt has no terminal event')
    }
    try {
      await drain()
    } catch (cause) {
      const retained = new Brc38StagingCleanupError(
        [cause],
        'Refused retired read attempt retains physical cleanup',
        drain
      )
      retainedCleanup.add(retained)
      throw retained
    }
    expect(attempt.failure).toBeDefined()
    expect(retiredDriver.isRetiredReadSession(attempt.session)).toBe(false)
    expect(await readRow(catalog)).toEqual(before)
    expect(await readBrc38NativeRetirement(catalog)).toBeUndefined()
  })
})
