import { CachedKeyDeriver, LockingScript, PrivateKey, RPuzzle, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { WABAccountContinuityError, WalletAuthenticationManager } from '../WalletAuthenticationManager'
import { CWIStyleWalletManager } from '../CWIStyleWalletManager'
import { _tu } from '../../test/utils/TestUtilsWalletStorage'
import { ScriptTemplateBRC29 } from '../utility/ScriptTemplateBRC29'

const temporaryKey = '11'.repeat(32)
const existingKey = '22'.repeat(32)

function subject() {
  const authMethod = { methodType: 'TwilioPhone' }
  const wabClient = {
    startAuthMethod: jest.fn(async () => ({ success: true })),
    completeAuthMethod: jest.fn(async () => ({
      success: true,
      presentationKey: temporaryKey,
      accountStatus: 'new-user'
    })),
    transport: {
      request: jest.fn(async () => ({ success: true, changeId: 73 }))
    }
  }
  const manager = Object.create(WalletAuthenticationManager.prototype) as WalletAuthenticationManager
  Object.assign(manager as any, {
    authenticated: false,
    authMethod,
    authSessionTtlMs: 10_000,
    wabClient,
    telemetry: {
      enabled: false,
      capture: jest.fn(),
      createCorrelationId: jest.fn(() => 'correlation')
    },
    authenticationFlow: 'new-user',
    providePresentationKey: jest.fn(async () => undefined)
  })
  return { manager, authMethod, wabClient }
}

describe('WAB authentication continuity', () => {
  it('refuses to re-fund a resumed registration when its original token checkpoint is missing', async () => {
    const { manager, wabClient } = subject()
    await manager.startAuth({ phoneNumber: '+12065550100' })
    wabClient.completeAuthMethod.mockResolvedValueOnce({
      success: true,
      presentationKey: existingKey,
      accountStatus: 'existing-user',
      registrationStatus: 'pending'
    })
    await manager.completeAuth({ otp: '123456' })

    const basePassword = jest.spyOn(CWIStyleWalletManager.prototype, 'providePassword').mockResolvedValueOnce()
    await expect(manager.providePassword('password')).rejects.toThrow(/checkpoint/i)
    expect(basePassword).not.toHaveBeenCalled()
  })

  it('surfaces a WAB faucet failure message before attempting wallet funding', async () => {
    const wabClient = {
      requestFaucet: jest.fn(async () => ({ success: false, message: 'faucet unavailable' }))
    }
    const manager = new WalletAuthenticationManager(
      'admin.example',
      async () => Object.create(null),
      undefined,
      async () => true,
      async () => 'password',
      wabClient as any
    )

    await expect(
      (manager as any).newWalletFunder(Array(32).fill(1), Object.create(null), 'admin.example')
    ).rejects.toThrow('Faucet request failed: faucet unavailable')
  })

  it('binds faucet redemption to the exact payment input even when wallet inputs are reordered', async () => {
    const faucetK = new PrivateKey(2)
    let rValue = faucetK.toPublicKey().getX().toArray()
    if (rValue[0] > 127) rValue = [0, ...rValue]
    const payment = new Transaction(1, [], [{ satoshis: 1_000, lockingScript: new RPuzzle().lock(rValue) }], 0)
    // The wallet-added input must independently fund the wallet-added output;
    // this test is about binding the externally signed faucet outpoint after
    // input reordering, not authorizing that outpoint to fund arbitrary output.
    const unrelated = new Transaction(1, [], [{ satoshis: 1_000, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
    const partial = new Transaction(
      1,
      [
        {
          sourceTransaction: unrelated,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: UnlockingScript.fromASM('OP_TRUE')
        },
        {
          sourceTransaction: payment,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript()
        }
      ],
      [{ satoshis: 1_000, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    const wallet = {
      getPublicKey: jest.fn(async () => ({ publicKey: new PrivateKey(3).toPublicKey().toString() })),
      createAction: jest.fn(async (args: any) => {
        if (args.inputs == null) return { sendWithResults: [{ txid: partial.id('hex'), status: 'unproven' }] }
        partial.outputs[0].lockingScript = LockingScript.fromHex(args.outputs[0].lockingScript)
        return {
          signableTransaction: { reference: 'ZmF1Y2V0LXJlZmVyZW5jZQ==', tx: partial.toAtomicBEEF() }
        }
      }),
      signAction: jest.fn(async (args: any) => {
        partial.inputs[1].unlockingScript = UnlockingScript.fromHex(args.spends[1].unlockingScript)
        return { txid: partial.id('hex'), tx: partial.toAtomicBEEF() }
      }),
      abortAction: jest.fn(),
      internalizeAction: jest.fn(async () => ({ accepted: true })),
      listOutputs: jest.fn(async () => ({ totalOutputs: 0, outputs: [] })),
      listActions: jest.fn(async () => ({ totalActions: 0, actions: [] }))
    }
    const wabClient = {
      requestFaucet: jest.fn(async () => ({
        success: true,
        paymentData: { k: faucetK.toString(16), tx: payment.toAtomicBEEF(), txid: payment.id('hex') }
      }))
    }
    const manager = new WalletAuthenticationManager(
      'admin.example',
      async () => wallet as any,
      undefined,
      async () => true,
      async () => 'password',
      wabClient as any
    )

    await expect((manager as any).newWalletFunder(Array(32).fill(1), wallet, 'admin.example')).resolves.toBeUndefined()
    expect(wallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [expect.objectContaining({ outpoint: `${payment.id('hex')}.0` })],
        options: expect.objectContaining({ signAndProcess: false, returnTXIDOnly: false })
      }),
      'admin.example'
    )
    expect(wallet.signAction).toHaveBeenCalledWith(
      expect.objectContaining({ spends: { 1: { unlockingScript: expect.any(String) } } }),
      'admin.example'
    )
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [expect.objectContaining({ protocol: 'wallet payment' })]
      }),
      'admin.example'
    )
  })

  it('funds an empty real wallet only through an exact wallet-owned output', async () => {
    const setup = await _tu.createSQLiteTestWallet({
      databaseName: 'emptyWalletFaucetBinding',
      chain: 'test',
      rootKeyHex: '3'.repeat(64),
      dropAll: true
    })
    const faucetK = new PrivateKey(2)
    let rValue = faucetK.toPublicKey().getX().toArray()
    if (rValue[0] > 127) rValue = [0, ...rValue]
    const payment = new Transaction(1, [], [{ satoshis: 1_000, lockingScript: new RPuzzle().lock(rValue) }], 0)
    const wabClient = {
      requestFaucet: jest.fn(async () => ({
        success: true,
        paymentData: { k: faucetK.toString(16), tx: payment.toAtomicBEEF(), txid: payment.id('hex') }
      }))
    }
    const manager = new WalletAuthenticationManager(
      'admin.example',
      async () => setup.wallet,
      undefined,
      async () => true,
      async () => 'password',
      wabClient as any
    )

    try {
      _tu.mockPostServicesAsSuccess([setup])
      jest.spyOn(setup.services, 'getChainTracker').mockResolvedValue({
        isValidRootForHeight: async () => true
      } as any)
      await expect(
        (manager as any).newWalletFunder(Array(32).fill(1), setup.wallet, 'admin.example')
      ).resolves.toBeUndefined()
      await expect(setup.wallet.balance()).resolves.toBeGreaterThan(0)
    } finally {
      await setup.wallet.destroy()
    }
  })

  it('recovers a previously signed faucet output instead of authorizing the faucet input again', async () => {
    const faucetK = new PrivateKey(2)
    let rValue = faucetK.toPublicKey().getX().toArray()
    if (rValue[0] > 127) rValue = [0, ...rValue]
    const payment = new Transaction(1, [], [{ satoshis: 1_000, lockingScript: new RPuzzle().lock(rValue) }], 0)
    const faucetOutpoint = `${payment.id('hex')}.0`
    const recipient = new PrivateKey(3)
    const sender = new PrivateKey(4)
    const derivationPrefix = Utils.toBase64(Array(16).fill(5))
    const derivationSuffix = Utils.toBase64(Array(16).fill(6))
    const template = new ScriptTemplateBRC29({
      derivationPrefix,
      derivationSuffix,
      keyDeriver: new CachedKeyDeriver(sender)
    })
    const redemption = new Transaction(
      1,
      [
        {
          sourceTransaction: payment,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: UnlockingScript.fromASM('OP_TRUE')
        }
      ],
      [{ satoshis: 900, lockingScript: template.lock(sender.toString(), recipient.toPublicKey().toString()) }],
      0
    )
    const instructions = JSON.stringify({
      version: 1,
      faucetOutpoint,
      derivationPrefix,
      derivationSuffix,
      senderIdentityKey: sender.toPublicKey().toString()
    })
    const wallet = {
      listOutputs: jest.fn(async () => ({
        totalOutputs: 1,
        BEEF: redemption.toAtomicBEEF(),
        outputs: [
          {
            outpoint: `${redemption.id('hex')}.0`,
            satoshis: 900,
            spendable: true,
            customInstructions: instructions
          }
        ]
      })),
      listActions: jest.fn(),
      internalizeAction: jest.fn(async () => ({ accepted: true })),
      getPublicKey: jest.fn(),
      createAction: jest.fn(),
      signAction: jest.fn(),
      abortAction: jest.fn()
    }
    const manager = new WalletAuthenticationManager(
      'admin.example',
      async () => wallet as any,
      undefined,
      async () => true,
      async () => 'password',
      {
        requestFaucet: jest.fn(async () => ({
          success: true,
          paymentData: { k: faucetK.toString(16), tx: payment.toAtomicBEEF(), txid: payment.id('hex') }
        }))
      } as any
    )

    await expect((manager as any).newWalletFunder(Array(32).fill(1), wallet, 'admin.example')).resolves.toBeUndefined()
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('recognizes a completed, already-internalized faucet action after interruption', async () => {
    const faucetK = new PrivateKey(2)
    let rValue = faucetK.toPublicKey().getX().toArray()
    if (rValue[0] > 127) rValue = [0, ...rValue]
    const payment = new Transaction(1, [], [{ satoshis: 1_000, lockingScript: new RPuzzle().lock(rValue) }], 0)
    const faucetOutpoint = `${payment.id('hex')}.0`
    const instructions = JSON.stringify({
      version: 1,
      faucetOutpoint,
      derivationPrefix: Utils.toBase64(Array(16).fill(5)),
      derivationSuffix: Utils.toBase64(Array(16).fill(6)),
      senderIdentityKey: new PrivateKey(4).toPublicKey().toString()
    })
    const wallet = {
      listOutputs: jest.fn(async () => ({ totalOutputs: 0, outputs: [] })),
      listActions: jest.fn(async () => ({
        totalActions: 1,
        actions: [
          {
            txid: 'aa'.repeat(32),
            status: 'unproven',
            labels: [`wab faucet ${payment.id('hex')}`],
            inputs: [{ sourceOutpoint: faucetOutpoint }],
            outputs: [{ basket: 'default', customInstructions: instructions }]
          }
        ]
      })),
      internalizeAction: jest.fn(),
      getPublicKey: jest.fn(),
      createAction: jest.fn(),
      signAction: jest.fn(),
      abortAction: jest.fn()
    }
    const manager = new WalletAuthenticationManager(
      'admin.example',
      async () => wallet as any,
      undefined,
      async () => true,
      async () => 'password',
      {
        requestFaucet: jest.fn(async () => ({
          success: true,
          paymentData: { k: faucetK.toString(16), tx: payment.toAtomicBEEF(), txid: payment.id('hex') }
        }))
      } as any
    )

    await expect((manager as any).newWalletFunder(Array(32).fill(1), wallet, 'admin.example')).resolves.toBeUndefined()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('rejects substituted faucet identities and scalars before asking the wallet to sign', async () => {
    const payment = new Transaction(1, [], [{ satoshis: 1_000, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
    const wallet = { createAction: jest.fn(), signAction: jest.fn(), abortAction: jest.fn() }
    const wabClient = {
      requestFaucet: jest
        .fn()
        .mockResolvedValueOnce({
          success: true,
          paymentData: { k: '2', tx: payment.toAtomicBEEF(), txid: 'f'.repeat(64) }
        })
        .mockResolvedValueOnce({
          success: true,
          paymentData: { k: '0', tx: payment.toAtomicBEEF(), txid: payment.id('hex') }
        })
    }
    const manager = new WalletAuthenticationManager(
      'admin.example',
      async () => wallet as any,
      undefined,
      async () => true,
      async () => 'password',
      wabClient as any
    )

    await expect((manager as any).newWalletFunder([], wallet, 'admin.example')).rejects.toThrow(
      'transaction ID does not match'
    )
    await expect((manager as any).newWalletFunder([], wallet, 'admin.example')).rejects.toThrow(
      'R-puzzle scalar is invalid'
    )
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('starts, cancels, switches, and reports failed authentication starts', async () => {
    const { manager, authMethod, wabClient } = subject()
    Object.assign(manager as any, { authMethod: undefined })
    await expect(manager.startAuth({ phoneNumber: '+12065550100' })).rejects.toThrow('No WAB authentication')

    manager.setAuthMethod(authMethod as any)
    Object.assign(manager as any, { authenticated: true })
    await expect(manager.startAuth({ phoneNumber: '+12065550100' })).rejects.toThrow('already authenticated')

    Object.assign(manager as any, { authenticated: false })
    wabClient.startAuthMethod.mockResolvedValueOnce({ success: false, message: 'start rejected' })
    await expect(manager.startAuth({ phoneNumber: '+12065550100' })).rejects.toThrow('start rejected')
    expect((manager as any).authSession).toBeUndefined()

    await expect(manager.startAuth({ phoneNumber: '+12065550100' })).resolves.toBeUndefined()
    expect((manager as any).authSession.presentationKey).toMatch(/^[0-9a-f]{64}$/)
    manager.setAuthMethod({ methodType: 'Other' } as any)
    expect((manager as any).authSession).toBeUndefined()
    manager.cancelAuth()
  })

  it('passes a WAB pin only through a successful, matching account-continuity completion', async () => {
    const { manager, wabClient } = subject()
    await manager.startAuth({ phoneNumber: '+12065550100' })
    const sessionKey = (manager as any).authSession.presentationKey as string
    const pinnedOutpoint = `${'a'.repeat(64)}.3`
    wabClient.completeAuthMethod.mockResolvedValueOnce({
      success: true,
      presentationKey: sessionKey,
      accountStatus: 'new-user',
      existingUser: false,
      umpTokenOutpoint: pinnedOutpoint
    })

    await expect(manager.completeAuth({ otp: '123456' })).resolves.toBeUndefined()
    expect((manager as any).providePresentationKey).toHaveBeenCalledWith(expect.any(Array), {
      pinnedOutpoint
    })
    expect((manager as any).authSession).toBeUndefined()
  })

  it('uses and finalizes a staged presentation key after an interrupted phone change', async () => {
    const { manager, wabClient } = subject()
    await manager.startAuth({ phoneNumber: '+12065550100' })
    const pendingKey = '33'.repeat(32)
    wabClient.completeAuthMethod.mockResolvedValueOnce({
      success: true,
      presentationKey: existingKey,
      accountStatus: 'existing-user',
      pendingPresentationKey: pendingKey,
      pendingPhoneChangeId: 73
    })
    ;(manager as any).providePresentationKey.mockImplementation(async (key: number[]) => {
      ;(manager as any).authenticationFlow = key[0] === 0x33 ? 'existing-user' : 'new-user'
    })

    await expect(manager.completeAuth({ otp: '123456' })).resolves.toBeUndefined()
    expect((manager as any).providePresentationKey).toHaveBeenCalledTimes(2)
    expect(wabClient.transport.request).toHaveBeenCalledWith('/auth/phone-change/finalize', {
      operation: 'phone-change',
      body: {
        changeId: 73,
        presentationKey: existingKey,
        newPresentationKey: pendingKey
      }
    })
  })

  it('rejects missing, switched, expired, unsuccessful, and malformed completion state', async () => {
    const { manager, authMethod, wabClient } = subject()
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toThrow('Start WAB authentication')

    Object.assign(manager as any, {
      authSession: { presentationKey: temporaryKey, methodType: 'Other', expiresAt: Date.now() + 1000 }
    })
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toThrow('method changed')

    Object.assign(manager as any, {
      authMethod,
      authSession: { presentationKey: temporaryKey, methodType: authMethod.methodType, expiresAt: Date.now() }
    })
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toThrow('expired')

    Object.assign(manager as any, {
      authSession: { presentationKey: temporaryKey, methodType: authMethod.methodType, expiresAt: Date.now() + 1000 }
    })
    wabClient.completeAuthMethod.mockResolvedValueOnce({ success: false, message: 'bad OTP' })
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toThrow('bad OTP')

    wabClient.completeAuthMethod.mockResolvedValueOnce({ success: true, presentationKey: 'not-hex' })
    await expect(manager.completeAuth({ otp: '123456' })).rejects.toBeInstanceOf(WABAccountContinuityError)
  })

  it('validates every additive and compatibility account-status combination', () => {
    const { manager } = subject()
    const infer = (result: Record<string, unknown>, key = temporaryKey) =>
      (manager as any).inferAccountStatus({ success: true, presentationKey: key, ...result }, temporaryKey)

    expect(infer({})).toBe('new-user')
    expect(infer({ existingUser: false })).toBe('new-user')
    expect(infer({ accountStatus: 'existing-user' }, existingKey)).toBe('existing-user')
    expect(infer({ existingUser: true }, existingKey.toUpperCase())).toBe('existing-user')
    expect(() => infer({ accountStatus: 'invalid' })).toThrow('invalid account status')
    expect(() => infer({ existingUser: 'yes' })).toThrow('invalid existing-user')
    expect(() => infer({ accountStatus: 'new-user', existingUser: true })).toThrow('conflicting account status')
    expect(() => infer({ accountStatus: 'new-user' }, existingKey)).toThrow('conflicting account status')
    expect(() => infer({ accountStatus: 'existing-user' })).toThrow('conflicting account status')
    expect(() => (manager as any).inferAccountStatus({ success: true }, temporaryKey)).toThrow(
      'did not return a presentation key'
    )
    expect((manager as any).constantTimeHexEqual('aa', 'AA')).toBe(true)
    expect((manager as any).constantTimeHexEqual('aa', 'ab')).toBe(false)
    expect((manager as any).constantTimeHexEqual('a', 'aa')).toBe(false)
    expect(new WABAccountContinuityError().code).toBe('WERR_WAB_ACCOUNT_CONTINUITY')
  })

  it('clears both authentication sessions when the manager is destroyed', () => {
    const { manager } = subject()
    Object.assign(manager as any, {
      authSession: { presentationKey: temporaryKey },
      phoneChangeSession: ['+12065550100', temporaryKey]
    })

    manager.destroy()

    expect((manager as any).authSession).toBeUndefined()
    expect((manager as any).phoneChangeSession).toBeUndefined()
    expect(manager.authenticated).toBe(false)
  })
})
