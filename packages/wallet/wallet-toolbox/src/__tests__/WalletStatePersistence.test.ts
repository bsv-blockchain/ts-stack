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
async function fixture() {
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
  const manager = new CWIStyleWalletManager(
    'admin.invalid',
    builder,
    interactor,
    async () => true,
    async () => ''
  )
  const state = manager as unknown as FixtureManager
  state.currentUMPToken = Object.fromEntries(fields.map(field => [field, Array(32).fill(1)])) as unknown as UMPToken
  state.currentUMPToken.currentOutpoint = firstOutpoint
  await state.setupRoot(root)
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
  manager.setStatePersistence(persistence)
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
    Object.assign(subject, { broadcaster: { broadcast } })
    return { wallet, subject, sourceToken, nextToken, transaction, checkpoint, broadcast, outpoint }
  }
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
    expect(f.broadcast).toHaveBeenCalledTimes(1)
    expect(f.broadcast.mock.calls[0][0].toAtomicBEEF()).toEqual(f.checkpoint.transaction)
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
