jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual<typeof import('@bsv/sdk')>('@bsv/sdk')
  return { ...actual, completeBoundAction: jest.fn(actual.completeBoundAction) }
})

import {
  Beef,
  completeBoundAction,
  LockingScript,
  PrivateKey,
  RPuzzle,
  Transaction,
  UnlockingScript,
  Utils
} from '@bsv/sdk'
import { WalletAuthenticationManager } from '../WalletAuthenticationManager'

interface FaucetPaymentData {
  k: string
  tx: number[]
  txid: string
  outputIndex?: number
  amount?: number
}

function faucetFixture(lockingScript?: LockingScript, satoshis = 1_000, privateKey = 2) {
  const faucetKey = new PrivateKey(privateKey)
  let rValue = faucetKey.toPublicKey().getX().toArray()
  if (rValue[0] > 127) rValue = [0, ...rValue]
  const payment = new Transaction(
    1,
    [],
    [
      {
        satoshis,
        lockingScript: lockingScript ?? new RPuzzle().lock(rValue)
      }
    ],
    0
  )
  return {
    faucetKey,
    payment,
    paymentData: {
      k: faucetKey.toString(16),
      tx: payment.toAtomicBEEF(),
      txid: payment.id('hex')
    } satisfies FaucetPaymentData,
    faucetOutpoint: `${payment.id('hex')}.0`
  }
}

function recoveryInstructions(faucetOutpoint: string): Record<string, unknown> {
  return {
    version: 1,
    faucetOutpoint,
    derivationPrefix: Utils.toBase64(Array(16).fill(5)),
    derivationSuffix: Utils.toBase64(Array(16).fill(6)),
    senderIdentityKey: new PrivateKey(4).toPublicKey().toString()
  }
}

function managerFor(paymentData: FaucetPaymentData | null, wallet: Record<string, unknown>) {
  return new WalletAuthenticationManager(
    'admin.example',
    async () => wallet as any,
    undefined,
    async () => true,
    async () => 'password',
    {
      requestFaucet: jest.fn(async () => ({ success: true, paymentData }))
    } as any
  )
}

async function fund(manager: WalletAuthenticationManager, wallet: Record<string, unknown>): Promise<void> {
  await (manager as any).newWalletFunder(Array(32).fill(1), wallet, 'admin.example')
}

describe('WalletAuthenticationManager faucet boundaries', () => {
  afterEach(() => jest.restoreAllMocks())

  it('uses the bounded default error when WAB omits usable payment data', async () => {
    const wallet = {}
    const manager = new WalletAuthenticationManager(
      'admin.example',
      async () => wallet as any,
      undefined,
      async () => true,
      async () => 'password',
      {
        requestFaucet: jest.fn(async () => ({ success: false, message: '', paymentData: null }))
      } as any
    )

    await expect(fund(manager, wallet)).rejects.toThrow('Faucet request failed: Missing paymentData from WAB')
  })

  it('rejects absent required faucet fields before parsing transaction evidence', async () => {
    const { paymentData } = faucetFixture()
    const wallet = { listOutputs: jest.fn() }
    const manager = managerFor({ ...paymentData, k: '' }, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('Faucet response missing required fields')
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a malformed transaction ID',
      (data: FaucetPaymentData) => ({ ...data, txid: 'not-a-txid' }),
      'transaction ID is invalid'
    ],
    ['a malformed scalar', (data: FaucetPaymentData) => ({ ...data, k: 'not-hex' }), 'R-puzzle scalar is invalid'],
    [
      'an oversized scalar',
      (data: FaucetPaymentData) => ({ ...data, k: 'a'.repeat(65) }),
      'R-puzzle scalar is invalid'
    ],
    ['malformed transaction bytes', (data: FaucetPaymentData) => ({ ...data, tx: [0] }), 'Faucet redemption failed'],
    [
      'a substituted output index',
      (data: FaucetPaymentData) => ({ ...data, outputIndex: 1 }),
      'output index does not match'
    ],
    ['a substituted amount', (data: FaucetPaymentData) => ({ ...data, amount: 999 }), 'amount does not match']
  ])('rejects %s without consulting wallet recovery state', async (_name, mutate, expected) => {
    const { paymentData } = faucetFixture()
    const wallet = { listOutputs: jest.fn() }
    const manager = managerFor(mutate(paymentData), wallet)

    await expect(fund(manager, wallet)).rejects.toThrow(expected)
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('accepts the unprefixed R value encoding before applying response bindings', async () => {
    const { paymentData } = faucetFixture(undefined, 1_000, 1)
    const wallet = { listOutputs: jest.fn() }
    const manager = managerFor({ ...paymentData, outputIndex: 1 }, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('output index does not match output 0')
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('rejects missing, valueless, and scalar-unbound faucet outputs', async () => {
    const faucetKey = new PrivateKey(2)
    const empty = new Transaction(1, [], [], 0)
    const zeroValue = faucetFixture(undefined, 0)
    const unrelated = faucetFixture(LockingScript.fromASM('OP_TRUE'))
    const cases: Array<[FaucetPaymentData, string]> = [
      [
        { k: faucetKey.toString(16), tx: empty.toAtomicBEEF(), txid: empty.id('hex') },
        'transaction output 0 is missing'
      ],
      [zeroValue.paymentData, 'output 0 has an invalid amount'],
      [unrelated.paymentData, 'does not match its R-puzzle scalar']
    ]

    for (const [paymentData, expected] of cases) {
      const wallet = { listOutputs: jest.fn() }
      const manager = managerFor(paymentData, wallet)
      await expect(fund(manager, wallet)).rejects.toThrow(expected)
      expect(wallet.listOutputs).not.toHaveBeenCalled()
    }
  })

  it('ignores malformed recovery metadata rather than trusting partial instruction records', async () => {
    const { paymentData, faucetOutpoint } = faucetFixture()
    const valid = recoveryInstructions(faucetOutpoint)
    const invalidInstructions: unknown[] = [
      undefined,
      '',
      'x'.repeat(2049),
      '{',
      'null',
      '[]',
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, faucetOutpoint: 'not-an-outpoint' }),
      JSON.stringify({ ...valid, derivationPrefix: 1 }),
      JSON.stringify({ ...valid, derivationSuffix: 1 }),
      JSON.stringify({ ...valid, senderIdentityKey: 1 }),
      JSON.stringify({ ...valid, derivationPrefix: '' }),
      JSON.stringify({ ...valid, derivationPrefix: Utils.toBase64(Array(65).fill(1)) }),
      JSON.stringify({ ...valid, derivationPrefix: 'AQ' }),
      JSON.stringify({ ...valid, senderIdentityKey: 'not-a-public-key' })
    ]
    const wallet = {
      listOutputs: jest.fn(async () => ({
        totalOutputs: invalidInstructions.length,
        outputs: invalidInstructions.map((customInstructions, index) => ({
          outpoint: `${'a'.repeat(64)}.${index}`,
          satoshis: 1,
          customInstructions
        }))
      })),
      listActions: jest.fn(async () => ({ totalActions: 0, actions: undefined }))
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('Wallet returned invalid faucet recovery actions')
    expect(wallet.listActions).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-array recovery output response', async () => {
    const { paymentData } = faucetFixture()
    const wallet = {
      listOutputs: jest.fn(async () => ({ totalOutputs: 0, outputs: null }))
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('Wallet returned invalid faucet recovery outputs')
  })

  it('rejects duplicate recovery claims before accepting transaction evidence', async () => {
    const { paymentData, faucetOutpoint } = faucetFixture()
    const customInstructions = JSON.stringify(recoveryInstructions(faucetOutpoint))
    const wallet = {
      listOutputs: jest.fn(async () => ({
        totalOutputs: 2,
        outputs: [
          { outpoint: `${'a'.repeat(64)}.0`, satoshis: 1, customInstructions },
          { outpoint: `${'b'.repeat(64)}.0`, satoshis: 1, customInstructions }
        ]
      }))
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('ambiguous faucet recovery outputs')
  })

  it.each([
    ['missing BEEF', `${'a'.repeat(64)}.0`, undefined, 'omitted bounded faucet recovery transaction evidence'],
    ['a malformed outpoint', 'not-an-outpoint', [1], 'invalid faucet recovery outpoint'],
    ['an oversized output index', `${'a'.repeat(64)}.4294967296`, [1], 'invalid faucet recovery output index']
  ])('rejects recovery output evidence with %s', async (_name, outpoint, BEEF, expected) => {
    const { paymentData, faucetOutpoint } = faucetFixture()
    const wallet = {
      listOutputs: jest.fn(async () => ({
        totalOutputs: 1,
        BEEF,
        outputs: [
          {
            outpoint,
            satoshis: 1,
            customInstructions: JSON.stringify(recoveryInstructions(faucetOutpoint))
          }
        ]
      }))
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow(expected)
  })

  it('requires recovery BEEF to prove the exact output and faucet input', async () => {
    const { paymentData, faucetOutpoint, payment } = faucetFixture()
    const unrelated = new Transaction(1, [], [{ satoshis: 900, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
    const wallet = {
      listOutputs: jest.fn(async () => ({
        totalOutputs: 1,
        BEEF: unrelated.toAtomicBEEF(),
        outputs: [
          {
            outpoint: `${payment.id('hex')}.0`,
            satoshis: 1_000,
            customInstructions: JSON.stringify(recoveryInstructions(faucetOutpoint))
          }
        ]
      }))
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('unrelated faucet recovery transaction evidence')
  })

  it('does not count malformed transaction input metadata as faucet provenance', async () => {
    const { paymentData, faucetOutpoint } = faucetFixture()
    const recoveryTxid = 'a'.repeat(64)
    const parseBeef = Beef.fromBinaryStrict
    const fakeTransaction = {
      outputs: [{ satoshis: 900 }],
      inputs: [
        { sourceOutputIndex: -1 },
        { sourceOutputIndex: 0, sourceTXID: 'not-a-transaction-id' },
        {
          sourceOutputIndex: 0,
          sourceTransaction: { id: jest.fn(() => 'b'.repeat(64)) }
        }
      ]
    }
    jest
      .spyOn(Beef, 'fromBinaryStrict')
      .mockImplementationOnce(binary => parseBeef(binary))
      .mockReturnValueOnce({
        findTxid: jest.fn(() => ({ tx: fakeTransaction }))
      } as any)
    const wallet = {
      listOutputs: jest.fn(async () => ({
        totalOutputs: 1,
        BEEF: [1],
        outputs: [
          {
            outpoint: `${recoveryTxid}.0`,
            satoshis: 900,
            customInstructions: JSON.stringify(recoveryInstructions(faucetOutpoint))
          }
        ]
      }))
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('unrelated faucet recovery transaction evidence')
  })

  it('rejects a recovered transaction when the wallet refuses to internalize its proven output', async () => {
    const { paymentData, faucetOutpoint, payment } = faucetFixture()
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
      [{ satoshis: 900, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    const wallet = {
      listOutputs: jest.fn(async () => ({
        totalOutputs: 1,
        BEEF: redemption.toAtomicBEEF(),
        outputs: [
          {
            outpoint: `${redemption.id('hex')}.0`,
            satoshis: 900,
            customInstructions: JSON.stringify(recoveryInstructions(faucetOutpoint))
          }
        ]
      })),
      internalizeAction: jest.fn(async () => ({ accepted: false }))
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('did not accept its recovered WAB faucet payment')
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('rejects ambiguous, unrelated, and unreconciled prior faucet actions', async () => {
    const { paymentData, faucetOutpoint, payment } = faucetFixture()
    const label = `wab faucet ${payment.id('hex')}`
    const customInstructions = JSON.stringify(recoveryInstructions(faucetOutpoint))
    const validAction = {
      txid: 'b'.repeat(64),
      status: 'pending',
      labels: [label],
      inputs: [{ sourceOutpoint: faucetOutpoint }],
      outputs: [{ basket: 'wab faucet recovery', customInstructions }]
    }
    const cases: Array<[Record<string, unknown>[], string]> = [
      [[validAction, validAction], 'ambiguous faucet recovery actions'],
      [[{ ...validAction, inputs: [] }], 'unrelated faucet recovery action evidence'],
      [[{ ...validAction, inputs: undefined }], 'unrelated faucet recovery action evidence'],
      [[{ ...validAction, outputs: undefined }], 'unrelated faucet recovery action evidence'],
      [[validAction], 'requires reconciliation before retrying']
    ]

    for (const [actions, expected] of cases) {
      const wallet = {
        listOutputs: jest.fn(async () => ({ totalOutputs: 0, outputs: [] })),
        listActions: jest.fn(async () => ({ totalActions: actions.length, actions }))
      }
      const manager = managerFor(paymentData, wallet)
      await expect(fund(manager, wallet)).rejects.toThrow(expected)
    }
  })

  it('recognizes an already internalized faucet payment using wallet-visible output and transaction evidence', async () => {
    const { paymentData, faucetOutpoint, payment } = faucetFixture()
    const label = `wab faucet ${payment.id('hex')}`
    const redemption = new Transaction(
      1,
      [{
        sourceTransaction: payment,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: UnlockingScript.fromASM('OP_TRUE')
      }],
      [{ satoshis: 900, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    const wallet = {
      // Real Wallet.listActions omits external inputs and strips customInstructions.
      listActions: jest.fn(async () => ({
        totalActions: 1,
        actions: [{
          txid: redemption.id('hex'), status: 'unproven', labels: [label], inputs: [],
          outputs: [{ outputIndex: 0, basket: 'default', spendable: true, satoshis: 900 }]
        }]
      })),
      listOutputs: jest.fn(async (args: { basket: string }) => args.basket === 'default'
        ? {
            totalOutputs: 1,
            BEEF: redemption.toAtomicBEEF(),
            outputs: [{
              outpoint: `${redemption.id('hex')}.0`, satoshis: 900, spendable: true,
              labels: [label]
            }]
          }
        : { totalOutputs: 0, outputs: [] })
    }

    await expect(fund(managerFor(paymentData, wallet), wallet)).resolves.toBeUndefined()
    expect(wallet.listOutputs).toHaveBeenCalledWith(
      expect.objectContaining({ basket: 'default' }), 'admin.example'
    )
    expect(wallet.listActions).toHaveBeenCalledTimes(1)
    expect(faucetOutpoint).toBe(`${payment.id('hex')}.0`)
  })

  it('rejects a labeled default output whose transaction spent a different faucet output', async () => {
    const { paymentData, payment } = faucetFixture()
    const otherPayment = faucetFixture(undefined, 1_000, 3).payment
    const label = `wab faucet ${payment.id('hex')}`
    const redemption = new Transaction(
      1,
      [{
        sourceTransaction: otherPayment,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: UnlockingScript.fromASM('OP_TRUE')
      }],
      [{ satoshis: 900, lockingScript: LockingScript.fromASM('OP_TRUE') }],
      0
    )
    const wallet = {
      listActions: jest.fn(async () => ({
        totalActions: 1,
        actions: [{
          txid: redemption.id('hex'), status: 'unproven', labels: [label], inputs: [],
          outputs: [{ outputIndex: 0, basket: 'default', spendable: true, satoshis: 900 }]
        }]
      })),
      listOutputs: jest.fn(async (args: { basket: string }) => args.basket === 'default'
        ? {
            totalOutputs: 1,
            BEEF: redemption.toAtomicBEEF(),
            outputs: [{
              outpoint: `${redemption.id('hex')}.0`, satoshis: 900, spendable: true,
              labels: [label]
            }]
          }
        : { totalOutputs: 0, outputs: [] })
    }

    await expect(fund(managerFor(paymentData, wallet), wallet)).rejects.toThrow(
      'unrelated internalized faucet transaction evidence'
    )
  })

  it('broadcasts a no-send recovery action only once before requiring reconciliation', async () => {
    const { paymentData, faucetOutpoint, payment } = faucetFixture()
    const label = `wab faucet ${payment.id('hex')}`
    const action = {
      txid: 'b'.repeat(64),
      status: 'nosend',
      labels: [label],
      inputs: [{ sourceOutpoint: faucetOutpoint }],
      outputs: [
        {
          basket: 'wab faucet recovery',
          customInstructions: JSON.stringify(recoveryInstructions(faucetOutpoint))
        }
      ]
    }
    const wallet = {
      listOutputs: jest.fn(async () => ({ totalOutputs: 0, outputs: [] })),
      listActions: jest.fn(async () => ({ totalActions: 1, actions: [action] })),
      createAction: jest.fn(async () => ({ txid: action.txid }))
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('remained unsent after broadcast retry')
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(wallet.listActions).toHaveBeenCalledTimes(2)
  })

  it('rejects a signed faucet redemption that omits its wallet-owned output', async () => {
    jest
      .mocked(completeBoundAction)
      .mockResolvedValueOnce(
        new Transaction(1, [], [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
      )
    const { paymentData } = faucetFixture()
    const wallet = {
      listOutputs: jest.fn(async () => ({ totalOutputs: 0, outputs: [] })),
      listActions: jest.fn(async () => ({ totalActions: 0, actions: [] })),
      getPublicKey: jest.fn(async () => ({ publicKey: new PrivateKey(3).toPublicKey().toString() })),
      createAction: jest.fn(),
      internalizeAction: jest.fn()
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow(
      'Faucet redemption omitted or duplicated its wallet-owned output'
    )
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('rejects a newly signed faucet payment when wallet internalization fails', async () => {
    jest.mocked(completeBoundAction).mockImplementationOnce(async (_wallet, args) => {
      const output = args.outputs?.[0]
      if (output == null) throw new Error('missing requested faucet output')
      return new Transaction(
        1,
        [],
        [
          {
            satoshis: 1,
            lockingScript: LockingScript.fromHex(output.lockingScript)
          }
        ],
        0
      )
    })
    const { paymentData } = faucetFixture()
    const wallet = {
      listOutputs: jest.fn(async () => ({ totalOutputs: 0, outputs: [] })),
      listActions: jest.fn(async () => ({ totalActions: 0, actions: [] })),
      getPublicKey: jest.fn(async () => ({ publicKey: new PrivateKey(3).toPublicKey().toString() })),
      createAction: jest.fn(async () => ({ txid: 'c'.repeat(64) })),
      internalizeAction: jest.fn(async () => ({ accepted: false }))
    }
    const manager = managerFor(paymentData, wallet)

    await expect(fund(manager, wallet)).rejects.toThrow('Wallet did not accept its WAB faucet payment')
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })
})
