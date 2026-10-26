import type { ModuleContext } from '../types.js'
import type {
  CreateActionArgs,
  SignActionArgs,
  WalletInterface
} from '../../wallet/Wallet.interfaces.js'
import PrivateKey from '../../primitives/PrivateKey.js'
import Transaction from '../../transaction/Transaction.js'
import Script from '../../script/Script.js'
import P2PKH from '../../script/templates/P2PKH.js'
import {
  Brc29RemittanceModule,
  DefaultNonceProvider,
  DefaultLockingScriptProvider
} from '../modules/BasicBRC29.js'

const _consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

const makeContext = (wallet: WalletInterface): ModuleContext => ({
  wallet,
  originator: 'example.com',
  now: () => 123
})

const PUBLIC_KEY = new PrivateKey(2).toPublicKey().toString()
const PAYMENT_SCRIPT = new P2PKH().lock(new PrivateKey(2).toPublicKey().toAddress()).toHex()

const addFundingInput = (transaction: Transaction): void => {
  const source = new Transaction()
  source.addOutput({ satoshis: 1_000_000, lockingScript: Script.fromASM('OP_1') })
  transaction.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_1')
  })
}

const makeWallet = (overrides: Partial<WalletInterface> = {}): WalletInterface => {
  let pending: Transaction | undefined
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: PUBLIC_KEY })),
    createAction: jest.fn(async (args: CreateActionArgs) => {
      pending = new Transaction(args.version ?? 1, [], [], args.lockTime ?? 0)
      addFundingInput(pending)
      for (const output of args.outputs ?? []) {
        pending.addOutput({
          satoshis: output.satoshis,
          lockingScript: Script.fromHex(output.lockingScript)
        })
      }
      return {
        signableTransaction: {
          reference: 'YnJjMjktYWRkaXRpb25hbA==',
          tx: pending.toAtomicBEEF(true)
        }
      }
    }),
    signAction: jest.fn(async (_args: SignActionArgs) => ({
      tx: pending!.toAtomicBEEF(true),
      txid: pending!.id('hex')
    })),
    abortAction: jest.fn(async () => ({ aborted: true })),
    internalizeAction: jest.fn(async () => ({ accepted: true })),
    ...overrides
  } as unknown as WalletInterface
}

const validSettlement = {
  customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
  transaction: new Transaction(
    1,
    [],
    [{ satoshis: 1000, lockingScript: Script.fromHex(PAYMENT_SCRIPT) }]
  ).toAtomicBEEF(true),
  amountSatoshis: 1000
}

// ---------------------------------------------------------------------------
// buildSettlement – option validation edge cases
// ---------------------------------------------------------------------------

describe('Brc29RemittanceModule – buildSettlement option validation', () => {
  it('terminates when option is null', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      { threadId: 'tid', option: null as any },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
    if (result.action === 'terminate') {
      expect(result.termination.code).toBe('brc29.invalid_option')
    }
  })

  it('terminates when option is a non-object primitive', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      { threadId: 'tid', option: 'not-an-object' as any },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when amountSatoshis is a float (non-integer)', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 1.5, payee: 'payee' } },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
    if (result.action === 'terminate') {
      expect(result.termination.code).toBe('brc29.invalid_option')
    }
  })

  it('terminates when outputIndex is a negative integer', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 100, payee: 'pk', outputIndex: -1 } },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when outputIndex is a float', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 100, payee: 'pk', outputIndex: 0.5 } },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when protocolID is not an array', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 100, payee: 'pk', protocolID: 'bad' as any } },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when protocolID has wrong array length', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 100, payee: 'pk', protocolID: [1] as any } },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when protocolID has negative protocol number', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      {
        threadId: 'tid',
        option: { amountSatoshis: 100, payee: 'pk', protocolID: [-1, 'proto'] as any }
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when protocolID string is empty', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      {
        threadId: 'tid',
        option: { amountSatoshis: 100, payee: 'pk', protocolID: [2, '   '] as any }
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when labels contains an empty string', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 100, payee: 'pk', labels: ['valid', ''] } },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when labels is not an array', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      {
        threadId: 'tid',
        option: { amountSatoshis: 100, payee: 'pk', labels: 'single-label' as any }
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when description is an empty string', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 100, payee: 'pk', description: '   ' } },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })
})

// ---------------------------------------------------------------------------
// buildSettlement – wallet-side failure paths
// ---------------------------------------------------------------------------

describe('Brc29RemittanceModule – buildSettlement wallet failures', () => {
  it.each([
    ['an empty public key', '', PAYMENT_SCRIPT, 'brc29.public_key_missing'],
    ['a whitespace-only public key', '   ', PAYMENT_SCRIPT, 'brc29.public_key_missing'],
    ['an empty locking script', PUBLIC_KEY, '', 'brc29.build_failed'],
    ['a whitespace-only locking script', PUBLIC_KEY, '   ', 'brc29.build_failed']
  ])(
    'terminates when the wallet path returns %s',
    async (_case, publicKey, lockingScript, expectedCode) => {
      const wallet = makeWallet({
        getPublicKey: jest.fn(async () => ({ publicKey }))
      })
      const module = new Brc29RemittanceModule({
        nonceProvider: { createNonce: jest.fn().mockResolvedValue('nonce') },
        lockingScriptProvider: { pubKeyToP2PKHLockingScript: jest.fn(async () => lockingScript) }
      })

      const result = await module.buildSettlement(
        { threadId: 'tid', option: { amountSatoshis: 1000, payee: 'pk' } },
        makeContext(wallet)
      )
      expect(result.action).toBe('terminate')
      if (result.action === 'terminate') {
        expect(result.termination.code).toBe(expectedCode)
      }
    }
  )

  it('settles successfully through the deferred-signing wallet path', async () => {
    const wallet = makeWallet()
    const module = new Brc29RemittanceModule({
      nonceProvider: {
        createNonce: jest.fn().mockResolvedValueOnce('prefix').mockResolvedValueOnce('suffix')
      }
    })

    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 500, payee: 'pk' } },
      makeContext(wallet)
    )
    expect(result.action).toBe('settle')
    if (result.action === 'settle') {
      expect(Transaction.fromAtomicBEEF(result.artifact.transaction).outputs[0].satoshis).toBe(500)
    }
  })

  it('terminates when tx is not a valid byte array (contains non-byte values)', async () => {
    const wallet = makeWallet({
      getPublicKey: jest.fn(async () => ({ publicKey: PUBLIC_KEY })),
      createAction: jest.fn(async () => ({ tx: [256, 1, 2] })) // 256 is out of byte range
    })
    const module = new Brc29RemittanceModule({
      nonceProvider: {
        createNonce: jest.fn().mockResolvedValueOnce('p').mockResolvedValueOnce('s')
      }
    })

    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 100, payee: 'pk' } },
      makeContext(wallet)
    )
    expect(result.action).toBe('terminate')
    if (result.action === 'terminate') {
      expect(result.termination.code).toBe('brc29.build_failed')
    }
  })

  it('terminates when tx is an empty array', async () => {
    const wallet = makeWallet({
      getPublicKey: jest.fn(async () => ({ publicKey: PUBLIC_KEY })),
      createAction: jest.fn(async () => ({ tx: [] })) // empty
    })
    const module = new Brc29RemittanceModule({
      nonceProvider: {
        createNonce: jest.fn().mockResolvedValueOnce('p').mockResolvedValueOnce('s')
      }
    })

    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 100, payee: 'pk' } },
      makeContext(wallet)
    )
    expect(result.action).toBe('terminate')
    if (result.action === 'terminate') {
      expect(result.termination.code).toBe('brc29.build_failed')
    }
  })

  it('terminates when createAction throws an unexpected error', async () => {
    const wallet = makeWallet({
      getPublicKey: jest.fn(async () => ({ publicKey: PUBLIC_KEY })),
      createAction: jest.fn(async () => {
        throw new Error('unexpected wallet error')
      })
    })
    const module = new Brc29RemittanceModule({
      nonceProvider: {
        createNonce: jest.fn().mockResolvedValueOnce('p').mockResolvedValueOnce('s')
      }
    })

    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 100, payee: 'pk' } },
      makeContext(wallet)
    )
    expect(result.action).toBe('terminate')
    if (result.action === 'terminate') {
      expect(result.termination.code).toBe('brc29.build_failed')
      expect(result.termination.message).not.toContain('unexpected wallet error')
    }
  })

  it('terminates when createNonce throws', async () => {
    const wallet = makeWallet()
    const module = new Brc29RemittanceModule({
      nonceProvider: {
        createNonce: jest.fn(async () => {
          throw new Error('nonce error')
        })
      },
      lockingScriptProvider: { pubKeyToP2PKHLockingScript: jest.fn(async () => 'script') }
    })

    const result = await module.buildSettlement(
      { threadId: 'tid', option: { amountSatoshis: 500, payee: 'pk' } },
      makeContext(wallet)
    )
    expect(result.action).toBe('terminate')
    if (result.action === 'terminate') {
      expect(result.termination.code).toBe('brc29.build_failed')
    }
  })

  it('uses option-level protocolID, labels, and description overrides', async () => {
    const wallet = makeWallet()
    const module = new Brc29RemittanceModule({
      nonceProvider: {
        createNonce: jest.fn().mockResolvedValueOnce('pref').mockResolvedValueOnce('suf')
      }
    })

    const result = await module.buildSettlement(
      {
        threadId: 'tid',
        option: {
          amountSatoshis: 777,
          payee: 'pk',
          protocolID: [1, 'custom-proto'],
          labels: ['my-label'],
          description: 'Custom description',
          outputIndex: 0
        }
      },
      makeContext(wallet)
    )
    expect(result.action).toBe('settle')
    if (result.action === 'settle') {
      expect(result.artifact.outputIndex).toBe(0)
      expect(result.artifact.amountSatoshis).toBe(777)
    }

    // Verify getPublicKey was called with the option's protocolID
    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ protocolID: [1, 'custom-proto'] }),
      'example.com'
    )

    // Verify createAction was called with option's labels and description
    const createArgs = (wallet.createAction as jest.Mock).mock.calls[0][0]
    expect(createArgs.labels).toEqual(['my-label'])
    expect(createArgs.description).toBe('Custom description')
  })
})

// ---------------------------------------------------------------------------
// acceptSettlement – settlement validation edge cases
// ---------------------------------------------------------------------------

describe('Brc29RemittanceModule – acceptSettlement validation', () => {
  it('terminates when settlement is null', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      { threadId: 'tid', settlement: null as any, sender: 'pk' },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
    if (result.action === 'terminate') {
      expect(result.termination.code).toBe('brc29.internalize_failed')
    }
  })

  it('terminates when settlement is a non-object primitive', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      { threadId: 'tid', settlement: 'not-an-object' as any, sender: 'pk' },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when customInstructions is missing', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      {
        threadId: 'tid',
        settlement: { transaction: [1, 2, 3], amountSatoshis: 100 } as any,
        sender: 'pk'
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when derivationPrefix is empty', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      {
        threadId: 'tid',
        settlement: {
          customInstructions: { derivationPrefix: '', derivationSuffix: 'suffix' },
          transaction: [1, 2, 3],
          amountSatoshis: 100
        },
        sender: 'pk'
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when derivationSuffix is empty', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      {
        threadId: 'tid',
        settlement: {
          customInstructions: { derivationPrefix: 'prefix', derivationSuffix: '' },
          transaction: [1, 2, 3],
          amountSatoshis: 100
        },
        sender: 'pk'
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when amountSatoshis is zero', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      {
        threadId: 'tid',
        settlement: {
          customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
          transaction: [1, 2, 3],
          amountSatoshis: 0
        },
        sender: 'pk'
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when amountSatoshis is negative', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      {
        threadId: 'tid',
        settlement: {
          customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
          transaction: [1, 2, 3],
          amountSatoshis: -1
        },
        sender: 'pk'
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when outputIndex is negative', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      {
        threadId: 'tid',
        settlement: {
          customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
          transaction: [1, 2, 3],
          amountSatoshis: 1000,
          outputIndex: -2
        },
        sender: 'pk'
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when transaction is not a byte array (invalid bytes)', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      {
        threadId: 'tid',
        settlement: {
          customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
          transaction: [256, 0, 1], // 256 is out of range
          amountSatoshis: 1000
        },
        sender: 'pk'
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('terminates when transaction is an empty array', async () => {
    const module = new Brc29RemittanceModule()
    const result = await module.acceptSettlement(
      {
        threadId: 'tid',
        settlement: {
          customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
          transaction: [],
          amountSatoshis: 1000
        },
        sender: 'pk'
      },
      makeContext(makeWallet())
    )
    expect(result.action).toBe('terminate')
  })

  it('uses outputIndex=0 by default when outputIndex is undefined', async () => {
    const internalizeAction = jest.fn(async () => ({ accepted: true as const }))
    const wallet = makeWallet({ internalizeAction })
    const module = new Brc29RemittanceModule()

    const result = await module.acceptSettlement(
      { threadId: 'tid', settlement: { ...validSettlement }, sender: 'sender-key' },
      makeContext(wallet)
    )
    expect(result.action).toBe('accept')
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [expect.objectContaining({ outputIndex: 0 })]
      }),
      'example.com'
    )
  })

  it('rejects the unsafe basket insertion internalizeProtocol', () => {
    expect(() => new Brc29RemittanceModule({ internalizeProtocol: 'basket insertion' })).toThrow(
      'BRC-29 settlements cannot be internalized as basket insertions'
    )
  })
})

// ---------------------------------------------------------------------------
// Constructor defaults
// ---------------------------------------------------------------------------

describe('Brc29RemittanceModule – constructor defaults', () => {
  it('has expected default property values', () => {
    const module = new Brc29RemittanceModule()
    expect(module.id).toBe('brc29.p2pkh')
    expect(module.name).toBe('BSV (BRC-29 derived P2PKH)')
    expect(module.allowUnsolicitedSettlements).toBe(true)
    expect((module as any).protocolID).toEqual([2, '3241645161d8'])
    expect((module as any).labels).toEqual(['brc29'])
    expect((module as any).description).toBe('BRC-29 payment')
    expect((module as any).outputDescription).toBe('Payment for remittance invoice')
    expect((module as any).refundFeeSatoshis).toBe(1000)
    expect((module as any).minRefundSatoshis).toBe(1000)
    expect((module as any).internalizeProtocol).toBe('wallet payment')
  })

  it('accepts config overrides for all properties', () => {
    const customNonce = { createNonce: jest.fn() }
    const customScript = { pubKeyToP2PKHLockingScript: jest.fn() }
    const module = new Brc29RemittanceModule({
      protocolID: [1, 'custom'],
      labels: ['lbl'],
      description: 'desc',
      outputDescription: 'out-desc',
      refundFeeSatoshis: 500,
      minRefundSatoshis: 200,
      internalizeProtocol: 'wallet payment',
      nonceProvider: customNonce,
      lockingScriptProvider: customScript
    })
    expect((module as any).protocolID).toEqual([1, 'custom'])
    expect((module as any).labels).toEqual(['lbl'])
    expect((module as any).description).toBe('desc')
    expect((module as any).outputDescription).toBe('out-desc')
    expect((module as any).refundFeeSatoshis).toBe(500)
    expect((module as any).minRefundSatoshis).toBe(200)
    expect((module as any).internalizeProtocol).toBe('wallet payment')
    expect((module as any).nonceProvider).toBe(customNonce)
    expect((module as any).lockingScriptProvider).toBe(customScript)
  })
})

// ---------------------------------------------------------------------------
// DefaultNonceProvider and DefaultLockingScriptProvider are exported;
// test that they satisfy the interfaces (smoke tests only – actual crypto
// tested elsewhere).
// ---------------------------------------------------------------------------

describe('DefaultNonceProvider and DefaultLockingScriptProvider', () => {
  it('DefaultNonceProvider.createNonce delegates to createNonce util', async () => {
    const fakeWallet = {
      createHmac: jest.fn(async () => ({ data: Array.from({ length: 32 }).fill(0) }))
    } as unknown as WalletInterface
    // createNonce will fail without real wallet; just ensure the function exists and is async
    await expect(
      DefaultNonceProvider.createNonce(fakeWallet, 'self', 'example.com')
    ).rejects.toBeDefined() // real createNonce needs full wallet
  })

  it('DefaultLockingScriptProvider has pubKeyToP2PKHLockingScript method', () => {
    expect(typeof DefaultLockingScriptProvider.pubKeyToP2PKHLockingScript).toBe('function')
  })
})
