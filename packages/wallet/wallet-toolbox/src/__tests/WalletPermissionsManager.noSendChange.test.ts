import {
  CreateActionArgs,
  CreateActionResult,
  LockingScript,
  SendWithResult,
  SignActionArgs,
  SignActionResult,
  Transaction,
  UnlockingScript,
  WalletInterface,
  WERR_REVIEW_ACTIONS as SDK_WERR_REVIEW_ACTIONS
} from '@bsv/sdk'
import { validateWalletResult } from '@bsv/sdk/wallet/WalletResultValidation'
import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { setExactActionSpend } from '../utility/exactActionSpend'
import { WERR_REVIEW_ACTIONS } from '../sdk/WERR_errors'

describe('permission-managed noSend createAction', () => {
  // A non-admin createAction is created signable and then signed by the
  // manager. Signing changes the txid, so the noSendChange outpoints the
  // signable result named must move to the signed transaction.
  test('reports noSendChange on the signed transaction it returns', async () => {
    const source = new Transaction()
    source.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 2000 })
    const build = (unlock: string): Transaction => {
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScript: UnlockingScript.fromHex(unlock)
      })
      tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1 })
      tx.addOutput({ lockingScript: LockingScript.fromHex('52'), satoshis: 1900 })
      return tx
    }
    const unsigned = build('')
    const signed = build('51')
    expect(signed.id('hex')).not.toBe(unsigned.id('hex'))

    const created = {
      noSendChange: [`${unsigned.id('hex')}.1`],
      signableTransaction: { reference: 'bm9zZW5kLXByb2Jl', tx: unsigned.toAtomicBEEF() }
    }
    setExactActionSpend(created, 1901)
    const underlying = {
      createAction: jest.fn(async () => created),
      signAction: jest.fn(async () => ({ txid: signed.id('hex'), tx: signed.toAtomicBEEF() })),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }
    const manager = new WalletPermissionsManager(underlying as unknown as WalletInterface, 'admin.example', {
      encryptWalletMetadata: false
    })
    jest.spyOn(manager, 'ensureSpendingAuthorization').mockResolvedValue(true)
    const args: CreateActionArgs = {
      description: 'Conformance no-send probe',
      outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Probe output' }],
      options: { noSend: true, acceptDelayedBroadcast: false }
    }

    const result = await manager.createAction(args, 'app.example')

    expect(underlying.signAction).toHaveBeenCalledTimes(1)
    expect(result.txid).toBe(signed.id('hex'))
    expect(result.noSendChange).toEqual([`${signed.id('hex')}.1`])
    expect(() => validateWalletResult('createAction', result, args)).not.toThrow()
  })

  test('lets the originator abort the no-send action it created, by txid, and nobody else', async () => {
    const source = new Transaction()
    source.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 2000 })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('51') })
    tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1 })
    tx.addOutput({ lockingScript: LockingScript.fromHex('52'), satoshis: 1900 })
    const created = { signableTransaction: { reference: 'YWJvcnQtcHJvYmU=', tx: tx.toAtomicBEEF() } }
    setExactActionSpend(created, 1901)
    const underlying = {
      createAction: jest.fn(async () => created),
      signAction: jest.fn(async () => ({ txid: tx.id('hex'), tx: tx.toAtomicBEEF() })),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }
    const manager = new WalletPermissionsManager(underlying as unknown as WalletInterface, 'admin.example', {
      encryptWalletMetadata: false
    })
    jest.spyOn(manager, 'ensureSpendingAuthorization').mockResolvedValue(true)
    const args: CreateActionArgs = {
      description: 'Conformance no-send probe',
      outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Probe output' }],
      options: { noSend: true }
    }
    const { txid } = await manager.createAction(args, 'app.example')

    await expect(manager.abortAction({ reference: txid! }, 'other.example')).rejects.toThrow('different originator')
    await expect(manager.abortAction({ reference: txid! }, 'app.example')).resolves.toEqual({ aborted: true })
    expect(underlying.abortAction).toHaveBeenCalledTimes(1)
    // Released once; it cannot be aborted again through this manager.
    await expect(manager.abortAction({ reference: txid! }, 'app.example')).rejects.toThrow('not issued')
  })

  test('does not make a broadcast action abortable by txid', async () => {
    const source = new Transaction()
    source.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 2000 })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('51') })
    tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1 })
    tx.addOutput({ lockingScript: LockingScript.fromHex('52'), satoshis: 1900 })
    const created = { signableTransaction: { reference: 'c2VudC1wcm9iZQ==', tx: tx.toAtomicBEEF() } }
    setExactActionSpend(created, 1901)
    const underlying = {
      createAction: jest.fn(async () => created),
      signAction: jest.fn(async () => ({ txid: tx.id('hex'), tx: tx.toAtomicBEEF() })),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }
    const manager = new WalletPermissionsManager(underlying as unknown as WalletInterface, 'admin.example', {
      encryptWalletMetadata: false
    })
    jest.spyOn(manager, 'ensureSpendingAuthorization').mockResolvedValue(true)
    const { txid } = await manager.createAction(
      {
        description: 'Broadcast probe',
        outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Probe output' }]
      },
      'app.example'
    )
    await expect(manager.abortAction({ reference: txid! }, 'app.example')).rejects.toThrow('not issued')
    expect(underlying.abortAction).not.toHaveBeenCalled()
  })

  function noSendManager(abortResult = { aborted: true }) {
    const source = new Transaction()
    source.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 2000 })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('51') })
    tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1 })
    tx.addOutput({ lockingScript: LockingScript.fromHex('52'), satoshis: 1900 })
    const created = { signableTransaction: { reference: 'bm8tb3JpZ2luYXRvcg==', tx: tx.toAtomicBEEF() } }
    setExactActionSpend(created, 1901)
    const underlying = {
      createAction: jest.fn(async () => created),
      signAction: jest.fn(async () => ({ txid: tx.id('hex'), tx: tx.toAtomicBEEF() })),
      abortAction: jest.fn(async () => abortResult)
    }
    const manager = new WalletPermissionsManager(underlying as unknown as WalletInterface, 'admin.example', {
      encryptWalletMetadata: false
    })
    jest.spyOn(manager, 'ensureSpendingAuthorization').mockResolvedValue(true)
    const args: CreateActionArgs = {
      description: 'Conformance no-send probe',
      outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Probe output' }],
      options: { noSend: true }
    }
    return { manager, underlying, args }
  }

  test('binds a no-send action created without an originator to that same empty originator', async () => {
    const { manager, underlying, args } = noSendManager()
    const { txid } = await manager.createAction(args)

    await expect(manager.abortAction({ reference: txid! }, 'app.example')).rejects.toThrow('different originator')
    await expect(manager.abortAction({ reference: txid! })).resolves.toEqual({ aborted: true })
    expect(underlying.abortAction).toHaveBeenCalledTimes(1)
  })

  test('refuses an abort with no originator for a no-send action an app created', async () => {
    const { manager, underlying, args } = noSendManager()
    const { txid } = await manager.createAction(args, 'app.example')

    await expect(manager.abortAction({ reference: txid! })).rejects.toThrow('different originator')
    expect(underlying.abortAction).not.toHaveBeenCalled()
  })

  test('keeps a no-send action abortable when the wallet did not abort it', async () => {
    const { manager, underlying, args } = noSendManager({ aborted: false })
    const { txid } = await manager.createAction(args, 'app.example')

    await expect(manager.abortAction({ reference: txid! }, 'app.example')).resolves.toEqual({ aborted: false })
    await expect(manager.abortAction({ reference: txid! }, 'app.example')).resolves.toEqual({ aborted: false })
    expect(underlying.abortAction).toHaveBeenCalledTimes(2)
  })

  // signAndProcess: false hands the caller the signable reference. Once it
  // signs a no-send action with signAction, the manager drops that reference
  // as pending, but the action is still unsent and the caller still holds the
  // reference (and now the txid) to release it by.
  function signableNoSendManager(created: { noSend?: boolean } = { noSend: true }) {
    const { manager, underlying } = noSendManager()
    const reference = 'bm8tb3JpZ2luYXRvcg=='
    const args: CreateActionArgs = {
      description: 'Conformance sign probe',
      outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Probe output' }],
      options: { signAndProcess: false, ...created }
    }
    return { manager, underlying, args, reference }
  }

  test('lets the originator abort a no-send action it signed, by reference or txid, and nobody else', async () => {
    const { manager, underlying, args, reference } = signableNoSendManager()
    const created = await manager.createAction(args, 'app.example')
    expect(created.signableTransaction?.reference).toBe(reference)
    const { txid } = await manager.signAction({ reference, spends: {}, options: { noSend: true } }, 'app.example')

    await expect(manager.abortAction({ reference }, 'other.example')).rejects.toThrow('different originator')
    await expect(manager.abortAction({ reference: txid! }, 'other.example')).rejects.toThrow('different originator')
    await expect(manager.abortAction({ reference }, 'app.example')).resolves.toEqual({ aborted: true })
    expect(underlying.abortAction).toHaveBeenCalledWith({ reference }, 'app.example')
    // Released once, under either name.
    await expect(manager.abortAction({ reference }, 'app.example')).rejects.toThrow('not issued')
    await expect(manager.abortAction({ reference: txid! }, 'app.example')).rejects.toThrow('not issued')
  })

  test('takes noSend from the created action when signAction does not set it', async () => {
    const { manager, underlying, args, reference } = signableNoSendManager()
    await manager.createAction(args, 'app.example')
    const { txid } = await manager.signAction({ reference, spends: {} }, 'app.example')

    await expect(manager.abortAction({ reference: txid! }, 'app.example')).resolves.toEqual({ aborted: true })
    await expect(manager.abortAction({ reference }, 'app.example')).rejects.toThrow('not issued')
    expect(underlying.abortAction).toHaveBeenCalledTimes(1)
  })

  test('does not make a signed action abortable when signAction broadcasts it', async () => {
    const { manager, underlying, args, reference } = signableNoSendManager()
    await manager.createAction(args, 'app.example')
    const { txid } = await manager.signAction({ reference, spends: {}, options: { noSend: false } }, 'app.example')

    await expect(manager.abortAction({ reference }, 'app.example')).rejects.toThrow('not issued')
    await expect(manager.abortAction({ reference: txid! }, 'app.example')).rejects.toThrow('not issued')
    expect(underlying.abortAction).not.toHaveBeenCalled()
  })

  test('does not make a signed action abortable when it was created to broadcast', async () => {
    const { manager, underlying, args, reference } = signableNoSendManager({})
    await manager.createAction(args, 'app.example')
    await manager.signAction({ reference, spends: {} }, 'app.example')

    await expect(manager.abortAction({ reference }, 'app.example')).rejects.toThrow('not issued')
    expect(underlying.abortAction).not.toHaveBeenCalled()
  })

  test('treats a non-string abort reference as one the manager did not issue', async () => {
    const { manager, underlying } = noSendManager()
    await expect(manager.abortAction({ reference: 42 as unknown as string }, 'app.example')).rejects.toThrow(
      'not issued'
    )
    expect(underlying.abortAction).not.toHaveBeenCalled()
  })
})

describe('no-send ownership after broadcast', () => {
  const originator = 'app.example'
  const actionArgs = (options: CreateActionArgs['options']): CreateActionArgs => ({
    description: 'No-send lifecycle regression',
    outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Probe output' }],
    options
  })

  function lifecycleManager() {
    const transactions = new Map<string, Transaction>()
    const signedResult = (reference: string): SignActionResult => {
      const tx = transactions.get(reference)!
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    }
    const underlying = {
      createAction: jest.fn(async (_args: CreateActionArgs): Promise<CreateActionResult> => {
        const source = new Transaction()
        source.lockTime = transactions.size + 1
        source.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 2000 })
        const tx = new Transaction()
        tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('51') })
        tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1 })
        tx.addOutput({ lockingScript: LockingScript.fromHex('52'), satoshis: 1900 })
        const reference = Buffer.from(`action-${transactions.size}`).toString('base64')
        transactions.set(reference, tx)
        const result = { signableTransaction: { reference, tx: tx.toAtomicBEEF() } }
        setExactActionSpend(result, 1901)
        return result
      }),
      signAction: jest.fn(async (args: SignActionArgs): Promise<SignActionResult> => signedResult(args.reference)),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }
    const manager = new WalletPermissionsManager(underlying as unknown as WalletInterface, 'admin.example', {
      encryptWalletMetadata: false
    })
    jest.spyOn(manager, 'ensureSpendingAuthorization').mockResolvedValue(true)
    const stage = async (callerSigns = true) => {
      const created = await manager.createAction(
        actionArgs({ noSend: true, ...(callerSigns ? { signAndProcess: false } : {}) }),
        originator
      )
      const reference = created.signableTransaction?.reference
      const signed = reference === undefined ? created : await manager.signAction({ reference, spends: {} }, originator)
      return { reference, txid: signed.txid! }
    }
    const broadcast = async (txids: string[]) =>
      await manager.createAction(
        {
          description: 'Broadcast staged actions',
          options: { sendWith: txids }
        },
        originator
      )
    return { manager, underlying, stage, broadcast, signedResult }
  }

  test.each<SendWithResult['status']>(['sending', 'unproven'])(
    'retires signed txids and references after a sendWith-only %s result',
    async status => {
      const { manager, underlying, stage, broadcast } = lifecycleManager()
      const signed = await stage()
      const automatic = await stage(false)
      const unknownTxid = 'ab'.repeat(32)
      const result = {
        sendWithResults: [signed.txid, automatic.txid, unknownTxid].map(txid => ({
          txid: txid.toUpperCase(),
          status
        }))
      }
      underlying.createAction.mockResolvedValueOnce(result)

      await expect(broadcast([signed.txid, automatic.txid, unknownTxid])).resolves.toEqual(result)

      for (const reference of [signed.reference!, signed.txid, automatic.txid]) {
        await expect(manager.abortAction({ reference }, originator)).rejects.toThrow('not issued')
      }
      expect(underlying.abortAction).not.toHaveBeenCalled()
    }
  )

  test('keeps failed and unreported actions bound to their originator after a mixed batch', async () => {
    const { manager, underlying, stage, broadcast } = lifecycleManager()
    const sent = await stage()
    const failed = await stage()
    const unreported = await stage()
    underlying.createAction.mockResolvedValueOnce({
      sendWithResults: [
        { txid: sent.txid, status: 'unproven' },
        { txid: failed.txid, status: 'failed' }
      ]
    })
    await broadcast([sent.txid, failed.txid, unreported.txid])

    await expect(manager.abortAction({ reference: sent.reference! }, originator)).rejects.toThrow('not issued')
    for (const action of [failed, unreported]) {
      await expect(manager.abortAction({ reference: action.txid }, 'other.example')).rejects.toThrow(
        'different originator'
      )
      await expect(manager.abortAction({ reference: action.reference! }, originator)).resolves.toEqual({
        aborted: true
      })
      await expect(manager.abortAction({ reference: action.txid }, originator)).rejects.toThrow('not issued')
    }
  })

  test.each([false, true])('retires prior and newly sent actions when caller signing is %s', async callerSigns => {
    const { manager, underlying, stage, signedResult } = lifecycleManager()
    const prior = await stage()
    underlying.signAction.mockImplementationOnce(async args => {
      const signed = signedResult(args.reference)
      return {
        ...signed,
        sendWithResults: [prior.txid, signed.txid!].map(txid => ({ txid, status: 'sending' as const }))
      }
    })
    const created = await manager.createAction(
      actionArgs({
        noSend: true,
        sendWith: [prior.txid],
        ...(callerSigns ? { signAndProcess: false } : {})
      }),
      originator
    )
    const signed = callerSigns
      ? await manager.signAction({ reference: created.signableTransaction!.reference, spends: {} }, originator)
      : created

    for (const reference of [prior.txid, prior.reference!, signed.txid!]) {
      await expect(manager.abortAction({ reference }, originator)).rejects.toThrow('not issued')
    }
    if (callerSigns) {
      await expect(
        manager.abortAction({ reference: created.signableTransaction!.reference }, originator)
      ).rejects.toThrow('not issued')
    }
    expect(underlying.abortAction).not.toHaveBeenCalled()
  })

  test.each([WERR_REVIEW_ACTIONS, SDK_WERR_REVIEW_ACTIONS])(
    'retires successful members reported in an undelayed batch error',
    async ReviewActions => {
      const { manager, underlying, stage, broadcast } = lifecycleManager()
      const sent = await stage()
      const failed = await stage()
      const error = new ReviewActions(
        [],
        [
          { txid: sent.txid, status: 'unproven' },
          { txid: failed.txid, status: 'failed' }
        ]
      )
      underlying.createAction.mockRejectedValueOnce(error)
      await expect(broadcast([sent.txid, failed.txid])).rejects.toBe(error)
      await expect(manager.abortAction({ reference: sent.reference! }, originator)).rejects.toThrow('not issued')
      await expect(manager.abortAction({ reference: failed.reference! }, originator)).resolves.toEqual({
        aborted: true
      })
    }
  )

  test.each([false, true])(
    'retires successful batch members when caller signing %s throws a review error',
    async callerSigns => {
      const { manager, underlying, stage } = lifecycleManager()
      const sent = await stage()
      const error = new WERR_REVIEW_ACTIONS([], [{ txid: sent.txid, status: 'unproven' }])
      underlying.signAction.mockRejectedValueOnce(error)
      const creating = manager.createAction(
        actionArgs({
          noSend: true,
          sendWith: [sent.txid],
          ...(callerSigns ? { signAndProcess: false } : {})
        }),
        originator
      )
      if (callerSigns) {
        const created = await creating
        await expect(
          manager.signAction({ reference: created.signableTransaction!.reference, spends: {} }, originator)
        ).rejects.toBe(error)
      } else {
        await expect(creating).rejects.toBe(error)
      }
      await expect(manager.abortAction({ reference: sent.reference! }, originator)).rejects.toThrow('not issued')
    }
  )

  test('retains ownership when a broadcast fails without positive results', async () => {
    const { manager, underlying, stage, broadcast } = lifecycleManager()
    const action = await stage()
    const error = new Error('Temporary transport failure')
    underlying.createAction.mockRejectedValueOnce(error)
    await expect(broadcast([action.txid])).rejects.toBe(error)
    underlying.createAction.mockResolvedValueOnce({})
    await broadcast([action.txid])
    await expect(manager.abortAction({ reference: action.reference! }, originator)).resolves.toEqual({ aborted: true })
  })

  test('does not retire a reference the underlying wallet reused for a newer action', async () => {
    const { manager, underlying, stage, broadcast, signedResult } = lifecycleManager()
    const first = await stage()
    const replacement = await underlying.createAction(actionArgs({ noSend: true, signAndProcess: false }))
    const signedReplacement = signedResult(replacement.signableTransaction!.reference)
    replacement.signableTransaction!.reference = first.reference!
    underlying.createAction.mockResolvedValueOnce(replacement)
    underlying.signAction.mockResolvedValueOnce(signedReplacement)
    const newer = await stage()
    expect(newer.txid).not.toBe(first.txid)
    expect(newer.reference).toBe(first.reference)

    underlying.createAction.mockResolvedValueOnce({ sendWithResults: [{ txid: first.txid, status: 'sending' }] })
    await broadcast([first.txid])

    await expect(manager.abortAction({ reference: first.txid }, originator)).rejects.toThrow('not issued')
    await expect(manager.abortAction({ reference: newer.reference! }, originator)).resolves.toEqual({ aborted: true })
    await expect(manager.abortAction({ reference: newer.txid }, originator)).rejects.toThrow('not issued')
  })
})
