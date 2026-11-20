import {
  MerklePath,
  PrivateKey,
  ProtoWallet,
  PushDrop,
  SymmetricKey,
  Transaction,
  UnlockingScript,
  Utils,
  WalletInterface
} from '@bsv/sdk'
import {
  CWIStyleWalletManager,
  OverlayUMPTokenInteractor,
  UMPToken,
  UMPTokenInteractor
} from '../CWIStyleWalletManager'
import { WalletAuthenticationManager } from '../WalletAuthenticationManager'
import {
  PendingUMPUpdate,
  WalletStatePersistence,
  WalletStateTransitionError,
  validatePendingUMPUpdate
} from '../WalletStatePersistence'

const root = Array(32).fill(7)
const firstOutpoint = '01'.repeat(32) + '.0'
const nextOutpoint = '02'.repeat(32) + '.0'
const fields = [
  'passwordSalt',
  'passwordPresentationPrimary',
  'passwordRecoveryPrimary',
  'presentationRecoveryPrimary',
  'passwordPrimaryPrivileged',
  'presentationRecoveryPrivileged',
  'presentationHash',
  'recoveryHash',
  'presentationKeyEncrypted',
  'passwordKeyEncrypted',
  'recoveryKeyEncrypted'
] as const
interface FixtureManager {
  currentUMPToken: UMPToken
  setupRoot(key: number[]): Promise<void>
  getFactor(name: string): Promise<number[]>
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(options?: {
  rootValue?: number
  attachPersistence?: boolean
  wab?: ConstructorParameters<typeof WalletAuthenticationManager>[5]
}) {
  let visible: UMPToken | undefined
  let rejectBuild = false
  let builderGate: Promise<void> | undefined
  const builder = jest.fn(async (key: number[]) => {
    if (builderGate) await builderGate
    if (rejectBuild) throw new Error('provider unavailable')
    return {
      getPublicKey: async () => ({ publicKey: new PrivateKey(key).toPublicKey().toString() })
    } as WalletInterface
  })
  const publish = jest.fn<UMPTokenInteractor['buildAndSend']>(async (_wallet, _admin, token, _old, checkpoint) => {
    await checkpoint?.onStarting?.()
    await checkpoint?.onCompleted([1], nextOutpoint)
    visible = { ...token, currentOutpoint: nextOutpoint }
    return nextOutpoint
  })
  const republish = jest.fn<NonNullable<UMPTokenInteractor['publishCheckpoint']>>(async (_wallet, _admin, token) => {
    visible = { ...token, currentOutpoint: nextOutpoint }
    return nextOutpoint
  })
  const interactor: UMPTokenInteractor = {
    checkpointVersion: 1,
    publishCheckpoint: republish,
    findByPresentationKeyHash: async () => visible,
    findByRecoveryKeyHash: async () => visible,
    buildAndSend: publish
  }
  const args = ['admin.invalid', builder, interactor, async () => true, async () => ''] as const
  const manager =
    options?.wab == null ? new CWIStyleWalletManager(...args) : new WalletAuthenticationManager(...args, options.wab)
  const state = manager as unknown as FixtureManager
  state.currentUMPToken = Object.fromEntries(fields.map(field => [field, Array(32).fill(1)])) as unknown as UMPToken
  state.currentUMPToken.currentOutpoint = firstOutpoint
  await state.setupRoot(options?.rootValue == null ? root : Array(32).fill(options.rootValue))
  await manager.switchProfile(Array(16).fill(0))
  state.getFactor = async () => Array(32).fill(1)
  let saved: number[] | undefined
  let pending: PendingUMPUpdate | null = null
  let failSave = false
  const events: string[] = []
  const persistence: WalletStatePersistence = {
    saveSnapshot: jest.fn(async snapshot => {
      events.push('snapshot')
      if (failSave) throw new Error('disk full')
      saved = snapshot
    }),
    savePendingUpdate: jest.fn(async value => {
      events.push(value?.stage ?? 'clear')
      pending = value == null ? null : (JSON.parse(JSON.stringify(value)) as PendingUMPUpdate)
    })
  }
  if (options?.attachPersistence !== false) manager.setStatePersistence(persistence)
  return {
    manager,
    state,
    builder,
    publish,
    republish,
    interactor,
    persistence,
    events,
    get saved() {
      return saved
    },
    get pending() {
      return pending
    },
    failSave: (value: boolean) => {
      failSave = value
    },
    failBuild: (value: boolean) => {
      rejectBuild = value
    },
    holdBuild: (value?: Promise<void>) => {
      builderGate = value
    },
    visible: (value: UMPToken | undefined) => {
      visible = value
    }
  }
}

describe('awaited wallet state continuity', () => {
  beforeAll(() => jest.useFakeTimers())
  afterAll(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })
  test('creation checkpoints before publication; saves and clears only after completion', async () => {
    const f = await fixture()
    const id = await f.manager.addProfile('Work')
    expect(f.events).toEqual(['prepared', 'submitting', 'signed', 'published', 'snapshot', 'clear'])
    expect(f.publish).toHaveBeenCalledTimes(1)
    expect(f.pending).toBeNull()
    expect(f.saved).toBeDefined()
    await f.manager.switchProfile(id)
    const key = (await f.manager.getPublicKey({ identityKey: true }, 'app.invalid')).publicKey
    const reopened = await fixture()
    await reopened.manager.loadSnapshot(f.saved!)
    expect(reopened.manager.listProfiles().find(profile => profile.active)?.id).toEqual(id)
    expect((await reopened.manager.getPublicKey({ identityKey: true }, 'app.invalid')).publicKey).toBe(key)
  })
  test('a builder failure keeps actual identity and active selection on the previous profile', async () => {
    const f = await fixture()
    const id = await f.manager.addProfile('Work')
    const before = (await f.manager.getPublicKey({ identityKey: true }, 'app.invalid')).publicKey
    f.failBuild(true)
    await expect(f.manager.switchProfile(id)).rejects.toThrow('provider unavailable')
    expect(f.manager.listProfiles().find(profile => profile.active)?.id).toEqual(Array(16).fill(0))
    expect((await f.manager.getPublicKey({ identityKey: true }, 'app.invalid')).publicKey).toBe(before)
  })
  test('save failure after publication retains recovery and blocks a second financial update', async () => {
    const f = await fixture()
    f.failSave(true)
    await expect(f.manager.addProfile('Work')).rejects.toBeInstanceOf(WalletStateTransitionError)
    expect(f.pending?.stage).toBe('published')
    expect(f.manager.listProfiles().map(profile => profile.name)).toEqual(['default', 'Work'])
    await expect(f.manager.addProfile('Another')).rejects.toBeInstanceOf(WalletStateTransitionError)
    expect(f.publish).toHaveBeenCalledTimes(1)
    f.failSave(false)
    await f.manager.recoverPendingUMPUpdate()
    expect(f.pending).toBeNull()
    expect(f.republish).not.toHaveBeenCalled()
  })
  test('lost response is recovered from its original signed checkpoint without another action', async () => {
    const f = await fixture()
    f.publish.mockImplementationOnce(async (_wallet, _admin, _token, _old, checkpoint) => {
      await checkpoint!.onStarting?.()
      await checkpoint!.onCompleted([1], nextOutpoint)
      throw new Error('overlay response lost')
    })
    await expect(f.manager.addProfile('Work')).rejects.toBeInstanceOf(WalletStateTransitionError)
    expect(f.pending?.stage).toBe('signed')
    const reopened = await fixture()
    await reopened.manager.loadSnapshot(f.pending!.previousSnapshot)
    reopened.manager.loadPendingUMPUpdate(f.pending!)
    await reopened.manager.recoverPendingUMPUpdate()
    expect(reopened.publish).not.toHaveBeenCalled()
    expect(reopened.republish).toHaveBeenCalledTimes(1)
    expect(reopened.manager.listProfiles().map(profile => profile.name)).toEqual(['default', 'Work'])
  })
  test('recovery repairs a refused receipt write before releasing the original transaction', async () => {
    const f = await fixture()
    const savePending = f.persistence.savePendingUpdate as jest.Mock
    f.publish.mockImplementationOnce(async (_wallet, _admin, _token, _old, checkpoint) => {
      await checkpoint!.onStarting?.()
      savePending.mockRejectedValueOnce(new Error('receipt write refused'))
      await checkpoint!.onCompleted([1], nextOutpoint)
    })

    await expect(f.manager.addProfile('Work')).rejects.toMatchObject({ stage: 'signed' })
    expect(f.pending?.stage).toBe('submitting')
    savePending.mockRejectedValueOnce(new Error('receipt still unwritable'))
    await expect(f.manager.recoverPendingUMPUpdate()).rejects.toMatchObject({ stage: 'signed' })
    expect(f.republish).not.toHaveBeenCalled()

    f.republish.mockImplementationOnce(async () => {
      expect(f.pending).toMatchObject({ stage: 'signed', transaction: [1], outpoint: nextOutpoint })
      return nextOutpoint
    })
    await f.manager.recoverPendingUMPUpdate()
    expect(f.republish).toHaveBeenCalledTimes(1)
    expect(f.publish).toHaveBeenCalledTimes(1)
  })
  test('an admitted operation without transaction evidence stays pending instead of being recreated', async () => {
    const f = await fixture()
    f.publish.mockImplementationOnce(async (_wallet, _admin, _token, _old, checkpoint) => {
      await checkpoint!.onStarting?.()
      throw new Error('action outcome unavailable')
    })
    await expect(f.manager.addProfile('Work')).rejects.toBeInstanceOf(WalletStateTransitionError)
    expect(f.pending?.stage).toBe('submitting')
    await expect(f.manager.recoverPendingUMPUpdate()).rejects.toBeInstanceOf(WalletStateTransitionError)
    expect(f.publish).toHaveBeenCalledTimes(1)
    expect(f.republish).not.toHaveBeenCalled()
  })
  test('failure to save the initial intent cannot start a financial update', async () => {
    const f = await fixture()
    ;(f.persistence.savePendingUpdate as jest.Mock).mockRejectedValueOnce(new Error('disk full'))
    await expect(f.manager.addProfile('Work')).rejects.toThrow('disk full')
    expect(f.publish).not.toHaveBeenCalled()
    await f.manager.addProfile('Work')
    expect(f.publish).toHaveBeenCalledTimes(1)
  })
  test('serialized switches await the first durable save', async () => {
    const f = await fixture()
    const id = await f.manager.addProfile('Work')
    const gate = deferred<void>()
    ;(f.persistence.saveSnapshot as jest.Mock).mockImplementationOnce(async () => {
      await gate.promise
    })
    const first = f.manager.switchProfile(id)
    const second = f.manager.switchProfile(Array(16).fill(0))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.manager.listProfiles().find(profile => profile.active)?.id).toEqual(id)
    await expect(f.manager.getPublicKey({ identityKey: true }, 'app.invalid')).rejects.toThrow('state is changing')
    gate.resolve()
    await Promise.all([first, second])
    expect(f.manager.listProfiles().find(profile => profile.active)?.id).toEqual(Array(16).fill(0))
  })
  test('serializes account restore with a profile switch before replacing the root or token', async () => {
    const f = await fixture()
    const other = await fixture({ rootValue: 8 })
    const id = await f.manager.addProfile('Work')
    const expected = (await other.manager.getPublicKey({ identityKey: true }, 'app.invalid')).publicKey
    const entered = deferred<void>()
    const release = deferred<void>()
    f.builder.mockImplementationOnce(async key => {
      entered.resolve()
      await release.promise
      return {
        getPublicKey: async () => ({ publicKey: new PrivateKey(key).toPublicKey().toString() })
      } as WalletInterface
    })

    const switching = f.manager.switchProfile(id)
    await entered.promise
    const restoring = f.manager.loadSnapshot(other.manager.saveSnapshot())
    release.resolve()
    await Promise.all([switching, restoring])

    const writes = (f.persistence.saveSnapshot as jest.Mock).mock.calls
    const previous = await fixture()
    await previous.manager.loadSnapshot(writes.at(-2)![0] as number[])
    expect(previous.manager.listProfiles().find(profile => profile.active)?.id).toEqual(id)
    expect((await f.manager.getPublicKey({ identityKey: true }, 'app.invalid')).publicKey).toBe(expected)
    expect(f.manager.listProfiles().map(profile => profile.name)).toEqual(['default'])
  })
  test.each([false, true])(
    'finalizes one phone change after local recovery (existing WAB stage: %s)',
    async resumable => {
      const request = jest.fn(async (path: string) => {
        if (path.endsWith('/start')) return { success: true }
        if (path.endsWith('/complete'))
          return resumable
            ? { success: true, pendingPresentationKey: 'ab'.repeat(32), pendingPhoneChangeId: 42 }
            : { success: true, changeToken: 'a'.repeat(64) }
        return { success: true, changeId: 42 }
      })
      const wab = { transport: { request } } as unknown as ConstructorParameters<typeof WalletAuthenticationManager>[5]
      const f = await fixture({ wab })
      const manager = f.manager as WalletAuthenticationManager
      f.failSave(true)
      await manager.startPhoneNumberChange('+12065550100')
      await expect(manager.completePhoneNumberChange('123456')).rejects.toBeInstanceOf(WalletStateTransitionError)
      expect(f.publish).toHaveBeenCalledTimes(1)
      expect(request.mock.calls.some(([path]) => path.endsWith('/finalize'))).toBe(false)

      f.failSave(false)
      await manager.recoverPendingUMPUpdate()
      await expect(manager.completePhoneNumberChange('123456')).resolves.toEqual({ changeId: 42 })
      expect(f.publish).toHaveBeenCalledTimes(1)
      expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1)
      expect(request.mock.calls.filter(([path]) => path.endsWith('/finalize'))).toHaveLength(1)
    }
  )
  test('late activation cannot republish identity after destroy', async () => {
    const f = await fixture()
    const id = await f.manager.addProfile('Work')
    const gate = deferred<void>()
    f.holdBuild(gate.promise)
    const switching = f.manager.switchProfile(id)
    await Promise.resolve()
    await Promise.resolve()
    f.manager.destroy()
    gate.resolve()
    await expect(switching).rejects.toThrow('session changed')
    expect(f.manager.authenticated).toBe(false)
    await expect(f.manager.getPublicKey({ identityKey: true }, 'app.invalid')).rejects.toThrow()
  })
  test('refresh rebuilds the same selected profile and refuses silent fallback after deletion', async () => {
    const f = await fixture()
    const id = await f.manager.addProfile('Work')
    await f.manager.switchProfile(id)
    const key = (await f.manager.getPublicKey({ identityKey: true }, 'app.invalid')).publicKey
    f.visible({ ...f.state.currentUMPToken, currentOutpoint: '03'.repeat(32) + '.0' })
    expect(await f.manager.syncUMPToken()).toBe(true)
    expect((await f.manager.getPublicKey({ identityKey: true }, 'app.invalid')).publicKey).toBe(key)
    f.visible({
      ...f.state.currentUMPToken,
      currentOutpoint: '04'.repeat(32) + '.0',
      profilesEncrypted: new SymmetricKey(root).encrypt(Utils.toArray('[]', 'utf8')) as number[]
    })
    await expect(f.manager.syncUMPToken()).rejects.toThrow('Choose a profile explicitly')
    expect(f.manager.listProfiles().find(profile => profile.active)?.id).toEqual(id)
  })
  test('legacy refresh keeps its single lookup and the current wallet instance', async () => {
    const f = await fixture({ attachPersistence: false })
    const next = { ...f.state.currentUMPToken, currentOutpoint: nextOutpoint }
    const lookup = jest.fn(async () => next)
    f.interactor.findByPresentationKeyHash = lookup
    f.interactor.verifyToken = jest.fn(async () => {
      throw new Error('unexpected extra lookup')
    })
    await expect(f.manager.syncUMPToken()).resolves.toBe(true)
    expect(lookup).toHaveBeenCalledWith(next.presentationHash)
    expect(f.interactor.verifyToken).not.toHaveBeenCalled()
    expect(f.builder).toHaveBeenCalledTimes(1)
    expect(f.state.currentUMPToken.currentOutpoint).toBe(nextOutpoint)
  })
  test('destroy during reconciliation cannot restore the old account after lookup returns', async () => {
    const f = await fixture()
    f.failSave(true)
    await expect(f.manager.addProfile('Work')).rejects.toBeInstanceOf(WalletStateTransitionError)
    f.failSave(false)
    const current = f.state.currentUMPToken
    const entered = deferred<void>(),
      gate = deferred<void>()
    f.interactor.findByPresentationKeyHash = async () => {
      entered.resolve()
      await gate.promise
      return current
    }
    const recovery = f.manager.recoverPendingUMPUpdate()
    await entered.promise
    f.manager.destroy()
    gate.resolve()
    await expect(recovery).rejects.toThrow()
    expect(f.manager.authenticated).toBe(false)
    await expect(f.manager.getPublicKey({ identityKey: true }, 'app.invalid')).rejects.toThrow()
  })
  test('destroy while saving admission cannot start a financial action', async () => {
    const f = await fixture()
    const entered = deferred<void>(),
      gate = deferred<void>()
    const save = (f.persistence.savePendingUpdate as jest.Mock).getMockImplementation()!
    ;(f.persistence.savePendingUpdate as jest.Mock).mockImplementation(async pending => {
      await save(pending)
      if (pending?.stage === 'submitting') {
        entered.resolve()
        await gate.promise
      }
    })
    let admitted = 0
    f.publish.mockImplementationOnce(async (_wallet, _admin, _token, _old, checkpoint) => {
      await checkpoint!.onStarting?.()
      admitted++
      await checkpoint!.onCompleted([1], nextOutpoint)
      return nextOutpoint
    })
    const creation = f.manager.addProfile('Work')
    await entered.promise
    f.manager.destroy()
    gate.resolve()
    await expect(creation).rejects.toThrow()
    expect(admitted).toBe(0)
    expect(f.pending).toBeNull()
    expect(f.manager.authenticated).toBe(false)
  })
  test('destroy during publication retains its original receipt without restoring the account', async () => {
    const f = await fixture()
    const entered = deferred<void>(),
      gate = deferred<void>()
    f.publish.mockImplementationOnce(async (_wallet, _admin, _token, _old, checkpoint) => {
      await checkpoint!.onStarting?.()
      await checkpoint!.onCompleted([1], nextOutpoint)
      entered.resolve()
      await gate.promise
      return nextOutpoint
    })
    const creation = f.manager.addProfile('Work')
    await entered.promise
    f.manager.destroy()
    gate.resolve()
    await expect(creation).rejects.toThrow()
    expect(f.pending?.stage).toBe('signed')
    expect(f.saved).toBeUndefined()
    expect(f.manager.authenticated).toBe(false)
  })
  test('a signature returned after destroy is retained without releasing the old session', async () => {
    const f = await fixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    const broadcast = jest.fn()
    f.publish.mockImplementationOnce(async (_wallet, _admin, _token, _old, checkpoint) => {
      await checkpoint!.onStarting?.()
      entered.resolve()
      await release.promise
      await checkpoint!.onCompleted([1], nextOutpoint)
      broadcast()
      return nextOutpoint
    })
    const update = f.manager.addProfile('Work')
    await entered.promise
    f.manager.destroy()
    release.resolve()
    await expect(update).rejects.toThrow('session changed')
    expect(broadcast).not.toHaveBeenCalled()
    expect(f.pending).toMatchObject({ stage: 'signed', outpoint: nextOutpoint })
    const other = await fixture({ rootValue: 8 })
    await expect(f.manager.loadSnapshot(other.manager.saveSnapshot())).resolves.toBeUndefined()
    expect(() => f.manager.loadPendingUMPUpdate(f.pending!)).toThrow('another account')
  })
  test('unchanged and absent verified lookups remain distinguishable and local save retry never publishes', async () => {
    const f = await fixture()
    expect(f.manager.getUMPTokenSyncStatus()).toBe('unknown')
    expect(await f.manager.syncUMPToken()).toBe(false)
    expect(f.manager.getUMPTokenSyncStatus()).toBe('not-found')
    f.visible(f.state.currentUMPToken)
    expect(await f.manager.syncUMPToken()).toBe(false)
    expect(f.manager.getUMPTokenSyncStatus()).toBe('unchanged')
    f.failSave(true)
    await expect(f.manager.retryStatePersistence()).rejects.toBeInstanceOf(WalletStateTransitionError)
    f.failSave(false)
    await f.manager.retryStatePersistence()
    expect(f.saved).toBeDefined()
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.republish).not.toHaveBeenCalled()
    await f.manager.recoverPendingUMPUpdate()
  })
  test('checkpoint storage cannot be replaced after attaching, and recovery requires its original authenticated root', async () => {
    const f = await fixture()
    f.manager.setStatePersistence(f.persistence)
    expect(() => f.manager.setStatePersistence({ ...f.persistence })).toThrow('already attached')
    f.failSave(true)
    await expect(f.manager.addProfile('Work')).rejects.toThrow()
    const checkpoint = f.pending!
    const other = await fixture({ rootValue: 8 })
    expect(() => other.manager.loadPendingUMPUpdate(checkpoint)).toThrow('another account')
    f.manager.destroy()
    await expect(f.manager.recoverPendingUMPUpdate()).resolves.toBeUndefined()
    f.failSave(false)
    await f.manager.loadSnapshot(checkpoint.previousSnapshot)
    f.manager.loadPendingUMPUpdate(checkpoint)
    await f.manager.recoverPendingUMPUpdate()
    expect(f.pending).toBeNull()
    expect(f.publish).toHaveBeenCalledTimes(1)
    expect(f.republish).not.toHaveBeenCalled()
  })
  test('prepared-only intent can be retired without publication, while an incomplete signed protocol remains pending', async () => {
    const f = await fixture()
    f.failSave(true)
    await expect(f.manager.addProfile('Work')).rejects.toThrow()
    const { transaction: _transaction, outpoint: _outpoint, ...checkpoint } = f.pending!
    const reopened = await fixture()
    await reopened.manager.loadSnapshot(checkpoint.previousSnapshot)
    reopened.manager.loadPendingUMPUpdate({ ...checkpoint, stage: 'prepared' })
    await reopened.manager.recoverPendingUMPUpdate()
    expect(reopened.events).toEqual(['snapshot', 'clear'])
    expect(reopened.publish).not.toHaveBeenCalled()
    expect(reopened.republish).not.toHaveBeenCalled()
    const omitted = await fixture()
    omitted.publish.mockImplementationOnce(async (_wallet, _admin, _token, _old, pending) => {
      await pending!.onStarting?.()
      return nextOutpoint
    })
    await expect(omitted.manager.addProfile('Work')).rejects.toThrow('needs reconciliation')
    expect(omitted.pending?.stage).toBe('submitting')
    expect(omitted.manager.listProfiles().map(profile => profile.name)).toEqual(['default'])
    const unsupported = await fixture()
    delete unsupported.interactor.checkpointVersion
    await expect(unsupported.manager.addProfile('Work')).rejects.toThrow('cannot retain recoverable')
    expect(unsupported.publish).not.toHaveBeenCalled()
  })
  test('recovery refuses conflicting overlay successors and restores the selected identity after re-publication failure', async () => {
    const f = await fixture()
    f.failSave(true)
    await expect(f.manager.addProfile('Work')).rejects.toThrow()
    const checkpoint = f.pending!
    const reopened = await fixture()
    await reopened.manager.loadSnapshot(checkpoint.previousSnapshot)
    reopened.manager.loadPendingUMPUpdate(checkpoint)
    reopened.visible({ ...f.state.currentUMPToken, currentOutpoint: '03'.repeat(32) + '.0' })
    await expect(reopened.manager.recoverPendingUMPUpdate()).rejects.toThrow('needs reconciliation')
    expect(reopened.republish).not.toHaveBeenCalled()
    reopened.visible({ ...reopened.state.currentUMPToken, currentOutpoint: '04'.repeat(32) + '.0' })
    await expect(reopened.manager.recoverPendingUMPUpdate()).rejects.toThrow('needs reconciliation')
    expect(reopened.republish).not.toHaveBeenCalled()
    reopened.visible(undefined)
    reopened.republish.mockRejectedValueOnce(new Error('publication unavailable'))
    const key = new PrivateKey(root).toPublicKey().toString()
    await expect(reopened.manager.recoverPendingUMPUpdate()).rejects.toThrow('needs reconciliation')
    expect(reopened.manager.listProfiles().find(profile => profile.active)?.identityKey).toBe(key)
    expect(reopened.publish).not.toHaveBeenCalled()
    expect(reopened.republish).toHaveBeenCalledTimes(1)
  })
  test('invalid selection and unauthenticated mutations cannot publish or persist a replacement', async () => {
    const f = await fixture()
    for (const id of [[], Array(16).fill(-1), Array(16).fill(256), Array(16).fill(1.5)]) {
      await expect(f.manager.switchProfile(id)).rejects.toThrow('Invalid wallet profile ID')
    }
    await expect(f.manager.deleteProfile(Array(16).fill(0))).rejects.toThrow('Cannot delete the default')
    await expect(f.manager.changePresentationKey([1])).rejects.toThrow('must be 32 bytes')
    f.manager.destroy()
    await expect(f.manager.syncUMPToken()).rejects.toThrow('not authenticated')
    await expect(f.manager.addProfile('Work')).rejects.toThrow('not fully initialized')
    await expect(f.manager.deleteProfile(Array(16).fill(1))).rejects.toThrow('not fully initialized')
    await expect(f.manager.changePresentationKey(Array(32).fill(2))).rejects.toThrow('Not authenticated')
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.saved).toBeUndefined()
  })
  test('checkpoint validation rejects malformed and stage-inconsistent durable capability data', () => {
    const checkpoint: PendingUMPUpdate = {
      version: 1,
      operationId: '01'.repeat(16),
      rootIdentityKey: new PrivateKey(root).toPublicKey().toString(),
      previousSnapshot: [1],
      proposedToken: [1],
      activeProfileId: Array(16).fill(0),
      stage: 'prepared'
    }
    expect(() => validatePendingUMPUpdate(checkpoint)).not.toThrow()
    for (const invalid of [
      null,
      [],
      'checkpoint',
      {},
      { ...checkpoint, version: 2 },
      { ...checkpoint, operationId: 'ff' },
      { ...checkpoint, rootIdentityKey: '04' + '01'.repeat(32) },
      { ...checkpoint, previousSnapshot: [] },
      { ...checkpoint, proposedToken: [-1] },
      { ...checkpoint, activeProfileId: [1] },
      { ...checkpoint, stage: 'unknown' },
      { ...checkpoint, stage: 'signed' },
      { ...checkpoint, stage: 'signed', transaction: [1], outpoint: 'bad' },
      { ...checkpoint, transaction: [1] },
      { ...checkpoint, outpoint: firstOutpoint }
    ]) {
      expect(() => validatePendingUMPUpdate(invalid)).toThrow('Invalid pending wallet update')
    }
  })
  test('malformed or foreign checkpoints do not replace the authenticated account', async () => {
    const f = await fixture()
    expect(() => validatePendingUMPUpdate({})).toThrow('Invalid pending')
    f.failSave(true)
    await expect(f.manager.addProfile('Work')).rejects.toThrow()
    const checkpoint = { ...f.pending!, rootIdentityKey: new PrivateKey(Array(32).fill(8)).toPublicKey().toString() }
    expect(() => f.manager.loadPendingUMPUpdate(checkpoint)).toThrow('another account')
  })
})

describe('original signed UMP checkpoint binding', () => {
  async function signedFixture() {
    const wallet = new ProtoWallet(new PrivateKey(42))
    const sourceToken = Object.fromEntries(fields.map(field => [field, Array(32).fill(1)])) as unknown as UMPToken
    const nextToken = { ...sourceToken, passwordSalt: Array(32).fill(2) }
    const subject = new OverlayUMPTokenInteractor({} as never, {} as never)
    const tokenFields = (subject as unknown as { tokenFields(token: UMPToken): number[][] }).tokenFields.bind(subject)
    const script = async (value: UMPToken) =>
      new PushDrop(wallet).lock(tokenFields(value), [2, 'admin user management token'], '1', 'self', true, true)
    const source = new Transaction(1, [], [{ satoshis: 1, lockingScript: await script(sourceToken) }], 0)
    source.merklePath = new MerklePath(100, [[{ offset: 0, hash: source.id('hex'), txid: true }]])
    sourceToken.currentOutpoint = `${source.id('hex')}.0`
    const transaction = new Transaction(1, [], [{ satoshis: 1, lockingScript: await script(nextToken) }], 0)
    transaction.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript([]),
      sequence: 0xffffffff
    })
    transaction.inputs[0].unlockingScript = await new PushDrop(wallet)
      .unlock([2, 'admin user management token'], '1', 'self')
      .sign(transaction, 0)
    const outpoint = `${transaction.id('hex')}.0`
    const checkpoint: PendingUMPUpdate = {
      version: 1,
      operationId: '01'.repeat(16),
      rootIdentityKey: (await wallet.getPublicKey({ identityKey: true })).publicKey,
      previousSnapshot: [1],
      proposedToken: [1],
      activeProfileId: Array(16).fill(0),
      stage: 'signed',
      transaction: transaction.toAtomicBEEF(),
      outpoint
    }
    const broadcast = jest.fn(async (_transaction: Transaction) => ({
      status: 'success' as const,
      txid: transaction.id('hex'),
      message: 'published'
    }))
    const createAction = jest.fn<WalletInterface['createAction']>(async () => ({
      sendWithResults: [{ txid: transaction.id('hex'), status: 'unproven' }]
    }))
    Object.assign(wallet, { createAction })
    Object.assign(subject, { broadcaster: { broadcast } })
    return { wallet, subject, sourceToken, nextToken, transaction, checkpoint, broadcast, createAction, outpoint }
  }
  test('verifies discovered proof ownership and refuses absent proof before recovery', async () => {
    const f = await signedFixture()
    const find = jest.fn(async () => ({ beef: f.transaction.toAtomicBEEF(), outputIndex: 0 }))
    Object.assign(f.subject, { findByOutpoint: find })
    await f.subject.verifyToken(f.wallet, 'admin.invalid', { ...f.nextToken, currentOutpoint: f.outpoint })
    await expect(f.subject.verifyToken(f.wallet, 'admin.invalid', f.nextToken)).rejects.toThrow('no outpoint')
    find.mockResolvedValueOnce(undefined as never)
    await expect(
      f.subject.verifyToken(f.wallet, 'admin.invalid', { ...f.nextToken, currentOutpoint: f.outpoint })
    ).rejects.toThrow('proof is unavailable')
    await expect(
      f.subject.publishCheckpoint(f.wallet as WalletInterface, 'admin.invalid', f.nextToken, f.nextToken, f.checkpoint)
    ).rejects.toThrow('needs reconciliation')
    expect(f.broadcast).not.toHaveBeenCalled()
  })
  test('captures the exact completed receipt before broadcast and refuses ambiguous token outputs', async () => {
    const f = await signedFixture()
    const events: string[] = []
    Object.assign(f.subject, { completeUMPAction: jest.fn(async () => f.transaction) })
    f.broadcast.mockImplementation(async () => {
      events.push('broadcast')
      return { status: 'success', txid: f.transaction.id('hex'), message: 'published' }
    })
    const completed = jest.fn(async (transaction: number[], outpoint: string) => {
      events.push('completed')
      expect(transaction).toEqual(f.transaction.toAtomicBEEF())
      expect(outpoint).toBe(f.outpoint)
    })
    await f.subject.buildAndSend(f.wallet as WalletInterface, 'admin.invalid', f.nextToken, undefined, {
      operationId: f.checkpoint.operationId,
      onCompleted: completed
    })
    expect(events).toEqual(['completed', 'broadcast'])
    f.transaction.outputs.push(f.transaction.outputs[0])
    await expect(
      f.subject.buildAndSend(f.wallet as WalletInterface, 'admin.invalid', f.nextToken, undefined, {
        operationId: f.checkpoint.operationId,
        onCompleted: completed
      })
    ).rejects.toThrow('exactly one requested token output')
    expect(f.broadcast).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledTimes(1)
  })
  test('holds both wallet and overlay publication until the signed receipt is durable', async () => {
    const f = await signedFixture()
    const events: string[] = []
    const txid = f.transaction.id('hex')
    const partial = Transaction.fromAtomicBEEF(f.transaction.toAtomicBEEF())
    partial.inputs[0].unlockingScript = new UnlockingScript([])
    const createAction = jest.fn<WalletInterface['createAction']>(async args => {
      if (args.options?.sendWith?.length) {
        events.push('wallet broadcast')
        expect(args.options.sendWith).toEqual([txid])
        return { sendWithResults: [{ txid, status: 'unproven' }] }
      }
      expect(args.options?.noSend).toBeUndefined()
      return { signableTransaction: { reference: 'dGVzdA==', tx: partial.toAtomicBEEF() } }
    })
    const signAction = jest.fn<WalletInterface['signAction']>(async args => {
      events.push(args.options?.noSend === true ? 'sign only' : 'sign and broadcast')
      return { txid, tx: f.transaction.toAtomicBEEF() }
    })
    const wallet = Object.assign(f.wallet, { createAction, signAction, abortAction: jest.fn() }) as WalletInterface
    Object.assign(f.subject, {
      findByOutpoint: async () => ({ beef: partial.inputs[0].sourceTransaction!.toBEEF(), outputIndex: 0 })
    })
    const onCompleted = jest.fn(async () => {
      throw new Error('disk full')
    })
    const onStarting = jest.fn(async () => {
      events.push('admitted')
    })
    const checkpoint = { operationId: f.checkpoint.operationId, onStarting, onCompleted }
    createAction.mockRejectedValueOnce(new Error('insufficient funds'))
    await expect(
      f.subject.buildAndSend(wallet, 'admin.invalid', f.nextToken, f.sourceToken, checkpoint)
    ).rejects.toThrow('insufficient funds')
    expect(onStarting).not.toHaveBeenCalled()
    expect(signAction).not.toHaveBeenCalled()

    await expect(
      f.subject.buildAndSend(wallet, 'admin.invalid', f.nextToken, f.sourceToken, checkpoint)
    ).rejects.toThrow('disk full')
    expect(events).toEqual(['admitted', 'sign only'])
    expect(f.broadcast).not.toHaveBeenCalled()

    onCompleted.mockImplementationOnce(async () => {
      events.push('durable receipt')
    })
    f.broadcast.mockImplementationOnce(async () => {
      events.push('overlay broadcast')
      return { status: 'success', txid, message: 'published' }
    })
    await expect(f.subject.buildAndSend(wallet, 'admin.invalid', f.nextToken, f.sourceToken, checkpoint)).resolves.toBe(
      f.outpoint
    )
    expect(events).toEqual([
      'admitted',
      'sign only',
      'admitted',
      'sign only',
      'durable receipt',
      'wallet broadcast',
      'overlay broadcast'
    ])
  })
  test('re-publishes the identical authenticated transaction without creating another action', async () => {
    const f = await signedFixture()
    await expect(
      f.subject.publishCheckpoint(
        f.wallet as WalletInterface,
        'admin.invalid',
        f.nextToken,
        f.sourceToken,
        f.checkpoint
      )
    ).resolves.toBe(f.outpoint)
    expect(f.createAction).toHaveBeenCalledTimes(1)
    expect(f.createAction).toHaveBeenCalledWith(
      {
        description: 'Broadcast signed UMP token',
        options: { sendWith: [f.transaction.id('hex')], acceptDelayedBroadcast: false }
      },
      'admin.invalid'
    )
    expect(f.broadcast).toHaveBeenCalledTimes(1)
    expect(f.broadcast.mock.calls[0][0].toAtomicBEEF()).toEqual(f.checkpoint.transaction)
    f.createAction.mockResolvedValueOnce({ sendWithResults: [{ txid: f.transaction.id('hex'), status: 'failed' }] })
    await expect(
      f.subject.publishCheckpoint(
        f.wallet as WalletInterface,
        'admin.invalid',
        f.nextToken,
        f.sourceToken,
        f.checkpoint
      )
    ).rejects.toThrow('did not confirm submission')
    expect(f.broadcast).toHaveBeenCalledTimes(1)
  })
  test('rejects a receipt with another owner, intended token, predecessor, or outpoint before broadcast', async () => {
    const f = await signedFixture()
    const otherWallet = new ProtoWallet(new PrivateKey(43))
    await expect(
      f.subject.publishCheckpoint(
        otherWallet as WalletInterface,
        'admin.invalid',
        f.nextToken,
        f.sourceToken,
        f.checkpoint
      )
    ).rejects.toThrow('not owned')
    await expect(
      f.subject.publishCheckpoint(
        f.wallet as WalletInterface,
        'admin.invalid',
        { ...f.nextToken, recoveryHash: Array(32).fill(9) },
        f.sourceToken,
        f.checkpoint
      )
    ).rejects.toThrow('intended update')
    await expect(
      f.subject.publishCheckpoint(
        f.wallet as WalletInterface,
        'admin.invalid',
        f.nextToken,
        { ...f.sourceToken, currentOutpoint: 'ff'.repeat(32) + '.0' },
        f.checkpoint
      )
    ).rejects.toThrow('exact predecessor')
    await expect(
      f.subject.publishCheckpoint(f.wallet as WalletInterface, 'admin.invalid', f.nextToken, f.sourceToken, {
        ...f.checkpoint,
        outpoint: 'ff'.repeat(32) + '.0'
      })
    ).rejects.toThrow('identity mismatch')
    expect(f.broadcast).not.toHaveBeenCalled()
  })
})
