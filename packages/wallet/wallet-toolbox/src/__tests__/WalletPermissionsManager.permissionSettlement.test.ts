import { LockingScript, PushDrop, Transaction, UnlockingScript } from '@bsv/sdk'
import { WalletPermissionsManager } from '../WalletPermissionsManager'

describe('WalletPermissionsManager permission settlement', () => {
  afterEach(() => jest.restoreAllMocks())

  it('queues a single durable permission token without inheriting broadcast latency', async () => {
    const completePermissionTokenAction = jest.fn(async () => undefined)
    const manager = Object.create(WalletPermissionsManager.prototype) as WalletPermissionsManager
    const internals = manager as any
    internals.adminOriginator = 'admin.com'
    internals.underlying = {}
    internals.completePermissionTokenAction = completePermissionTokenAction
    internals.buildPushdropFields = jest.fn().mockResolvedValue([])
    internals.buildTagsForRequest = jest.fn().mockReturnValue([])
    jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(LockingScript.fromHex('51'))

    await internals.createPermissionOnChain({ type: 'basket', originator: 'todo.example', basket: 'todo tokens' }, 0)

    expect(completePermissionTokenAction).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { acceptDelayedBroadcast: true }
      })
    )
  })

  it('queues grouped permission tokens without inheriting network-broadcast latency', async () => {
    const completePermissionTokenAction = jest.fn(async () => undefined)
    const manager = Object.create(WalletPermissionsManager.prototype) as WalletPermissionsManager
    const internals = manager as any
    internals.adminOriginator = 'admin.com'
    internals.completePermissionTokenAction = completePermissionTokenAction
    internals.buildPermissionOutput = jest.fn(async ({ request }: any) => ({
      request,
      output: {
        lockingScript: '51',
        satoshis: 1,
        outputDescription: 'basket permission token',
        basket: 'admin basket-access',
        tags: []
      }
    }))

    const granted = await internals.createPermissionTokensBestEffort(
      [
        {
          request: { type: 'basket', originator: 'todo.example', basket: 'todo tokens' },
          expiry: 0
        }
      ],
      true
    )

    expect(granted).toHaveLength(1)
    expect(completePermissionTokenAction).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { acceptDelayedBroadcast: true }
      })
    )
  })

  it('signs a permission token by exact outpoint after wallet input reordering', async () => {
    const tokenSource = new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
    const unrelatedSource = new Transaction(
      1,
      [],
      [{ satoshis: 10, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    const partial = new Transaction(
      1,
      [
        {
          sourceTransaction: unrelatedSource,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript()
        },
        {
          sourceTransaction: tokenSource,
          sourceOutputIndex: 0,
          sequence: 0xffffffff,
          unlockingScript: new UnlockingScript()
        }
      ],
      [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    const underlying = {
      createAction: jest.fn(async () => ({
        signableTransaction: { reference: 'cmVvcmRlcmVkLXRva2Vu', tx: partial.toAtomicBEEF() }
      })),
      signAction: jest.fn(async (args: any) => {
        const finalized = Transaction.fromAtomicBEEF(partial.toAtomicBEEF())
        finalized.inputs[1].unlockingScript = UnlockingScript.fromHex(args.spends[1].unlockingScript)
        return { txid: finalized.id('hex'), tx: finalized.toAtomicBEEF() }
      }),
      abortAction: jest.fn(async () => ({ aborted: true }))
    }
    jest.spyOn(PushDrop.prototype, 'unlock').mockReturnValue({
      sign: async () => UnlockingScript.fromHex('00'),
      estimateLength: async () => 73 as const
    })
    const manager = new WalletPermissionsManager(underlying as never, 'admin.example', {
      encryptWalletMetadata: false,
      seekSpendingPermissions: false
    })
    const outpoint = `${tokenSource.id('hex')}.0`

    await expect(
      (manager as any).completePermissionTokenAction(
        {
          description: 'Renew permission',
          inputBEEF: tokenSource.toBEEF(),
          inputs: [{ outpoint, unlockingScriptLength: 73, inputDescription: 'old token' }],
          outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'new token' }]
        },
        [{ tx: tokenSource.toBEEF(), txid: tokenSource.id('hex'), outputIndex: 0, outputScript: '51' }]
      )
    ).resolves.toBeInstanceOf(Transaction)
    expect(underlying.signAction).toHaveBeenCalledWith(
      expect.objectContaining({ spends: { 1: { unlockingScript: '00' } } }),
      'admin.example'
    )
  })
})
