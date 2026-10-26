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
import { Brc29RemittanceModule } from '../modules/BasicBRC29.js'

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
          reference: 'YnJjMjktYmFzZQ==',
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

const settlement = (amountSatoshis = 1000) => ({
  customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
  transaction: new Transaction(
    1,
    [],
    [{ satoshis: amountSatoshis, lockingScript: Script.fromHex(PAYMENT_SCRIPT) }]
  ).toAtomicBEEF(true),
  amountSatoshis,
  outputIndex: 0
})

describe('Brc29RemittanceModule', () => {
  // Prevent console.log output during tests
  const _consoleErrorSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

  describe('unsolicited settlements (no invoice)', () => {
    it('builds a settlement artifact for unsolicited payment', async () => {
      const wallet = makeWallet()

      const module = new Brc29RemittanceModule({
        protocolID: [2, 'test-protocol'],
        labels: ['label-1'],
        description: 'Test payment',
        outputDescription: 'Test output',
        nonceProvider: {
          createNonce: jest.fn().mockResolvedValueOnce('prefix').mockResolvedValueOnce('suffix')
        }
      })

      const option = { amountSatoshis: 1000, payee: 'payee-key' }
      const result = await module.buildSettlement(
        { threadId: 'thread-1', option, note: 'unsolicited payment' },
        makeContext(wallet)
      )
      expect(result.action).toBe('settle')
      if (result.action !== 'settle') return

      expect(result.artifact.customInstructions).toEqual({
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix',
        protocolID: [2, 'test-protocol']
      })
      expect(result.artifact.amountSatoshis).toBe(1000)
      expect(result.artifact.outputIndex).toBe(0)
      expect(Transaction.fromAtomicBEEF(result.artifact.transaction).outputs[0].satoshis).toBe(1000)

      expect(wallet.getPublicKey).toHaveBeenCalledWith(
        {
          protocolID: [2, 'test-protocol'],
          keyID: 'prefix suffix',
          counterparty: option.payee
        },
        'example.com'
      )

      const createArgs = (wallet.createAction as jest.Mock).mock.calls[0][0]
      const customInstructions = JSON.parse(createArgs.outputs[0].customInstructions as string)
      expect(customInstructions).toEqual({
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix',
        protocolID: [2, 'test-protocol'],
        payee: option.payee,
        threadId: 'thread-1',
        note: 'unsolicited payment'
      })
      expect(createArgs.outputs[0].outputDescription).toBe('Test output')
    })

    it('returns the verified signed transaction as portable JSON bytes', async () => {
      const wallet = makeWallet()

      const module = new Brc29RemittanceModule({
        nonceProvider: {
          createNonce: jest.fn().mockResolvedValueOnce('prefix').mockResolvedValueOnce('suffix')
        }
      })

      const result = await module.buildSettlement(
        { threadId: 'thread-1', option: { amountSatoshis: 1000, payee: 'payee-key' } },
        makeContext(wallet)
      )

      expect(result.action).toBe('settle')
      if (result.action !== 'settle') return
      expect(Array.isArray(result.artifact.transaction)).toBe(true)
      expect(JSON.parse(JSON.stringify(result.artifact.transaction))).toEqual(
        result.artifact.transaction
      )
    })

    it('terminates on invalid amounts for unsolicited settlements', async () => {
      const wallet = {
        getPublicKey: jest.fn(async () => ({ publicKey: '02deadbeef' })),
        createAction: jest.fn(async () => ({ tx: [1, 2, 3] }))
      } as unknown as WalletInterface

      const module = new Brc29RemittanceModule()
      const option = { amountSatoshis: 0, payee: 'payee-key' }
      const result = await module.buildSettlement(
        { threadId: 'thread-1', option },
        makeContext(wallet)
      )
      expect(result.action).toBe('terminate')
    })

    it('terminates on invalid option data for unsolicited settlements', async () => {
      const wallet = {
        getPublicKey: jest.fn(async () => ({ publicKey: '02deadbeef' })),
        createAction: jest.fn(async () => ({ tx: [1, 2, 3] }))
      } as unknown as WalletInterface

      const module = new Brc29RemittanceModule()
      const option = { amountSatoshis: -5, payee: 'payee-key', outputIndex: -1 }
      const result = await module.buildSettlement(
        { threadId: 'thread-1', option },
        makeContext(wallet)
      )
      expect(result.action).toBe('terminate')
      if (result.action === 'terminate') {
        expect(result.termination.code).toBe('brc29.invalid_option')
      }
    })
  })

  describe('settlement building edge cases', () => {
    it('terminates when wallet fails to create transaction', async () => {
      const wallet = makeWallet({ createAction: jest.fn(async () => ({})) })

      const module = new Brc29RemittanceModule({
        nonceProvider: {
          createNonce: jest.fn().mockResolvedValueOnce('prefix').mockResolvedValueOnce('suffix')
        }
      })
      const option = { amountSatoshis: 1000, payee: 'payee-key' }
      const result = await module.buildSettlement(
        { threadId: 'thread-1', option },
        makeContext(wallet)
      )
      expect(result.action).toBe('terminate')
      if (result.action === 'terminate') {
        expect(result.termination.code).toBe('brc29.build_failed')
      }
    })
  })

  describe('settlement acceptance', () => {
    it('accepts settlements by internalizing the payment', async () => {
      const wallet = makeWallet()

      const module = new Brc29RemittanceModule()
      const payment = settlement()
      const result = await module.acceptSettlement(
        { threadId: 'thread-1', settlement: payment, sender: 'payer-key' },
        makeContext(wallet)
      )
      expect(result.action).toBe('accept')
      if (result.action === 'accept') {
        expect(result.receiptData?.internalizeResult).toEqual({ accepted: true })
      }

      expect(wallet.internalizeAction).toHaveBeenCalledWith(
        {
          tx: payment.transaction,
          outputs: [
            {
              paymentRemittance: {
                derivationPrefix: 'p',
                derivationSuffix: 's',
                senderIdentityKey: 'payer-key'
              },
              outputIndex: 0,
              protocol: 'wallet payment'
            }
          ],
          labels: ['brc29'],
          description: 'BRC-29 payment received'
        },
        'example.com'
      )
    })

    it.each([{ accepted: false }, {}])(
      'terminates without affirmative wallet acceptance: %j',
      async result => {
        const wallet = makeWallet({ internalizeAction: jest.fn(async () => result) })
        const module = new Brc29RemittanceModule()
        const accepted = await module.acceptSettlement(
          {
            threadId: 'thread-1',
            sender: 'payer-key',
            settlement: settlement()
          },
          makeContext(wallet)
        )
        expect(accepted).toMatchObject({
          action: 'terminate',
          termination: { code: 'brc29.internalize_failed' }
        })
      }
    )

    it('terminates when internalization fails', async () => {
      const wallet = makeWallet({
        internalizeAction: jest.fn(async () => {
          throw new Error('fail')
        })
      })

      const module = new Brc29RemittanceModule()
      const result = await module.acceptSettlement(
        { threadId: 'thread-1', settlement: settlement(), sender: 'payer-key' },
        makeContext(wallet)
      )
      expect(result.action).toBe('terminate')
      if (result.action === 'terminate') {
        expect(result.termination.code).toBe('brc29.internalize_failed')
      }
    })
  })
})
