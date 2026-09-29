import { CreateActionArgs, LockingScript, Transaction, UnlockingScript, WalletInterface } from '@bsv/sdk'
import { validateWalletResult } from '@bsv/sdk/wallet/WalletResultValidation'
import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { setExactActionSpend } from '../utility/exactActionSpend'

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
      { description: 'Broadcast probe', outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'Probe output' }] },
      'app.example'
    )
    await expect(manager.abortAction({ reference: txid! }, 'app.example')).rejects.toThrow('not issued')
    expect(underlying.abortAction).not.toHaveBeenCalled()
  })
})
