import Script from '../../script/Script.js'
import Transaction from '../../transaction/Transaction.js'
import PrivateKey from '../../primitives/PrivateKey.js'
import type {
  CreateActionArgs,
  SignActionArgs,
  WalletInterface
} from '../../wallet/Wallet.interfaces.js'
import { Brc29RemittanceModule, DefaultLockingScriptProvider } from '../modules/BasicBRC29.js'
import type { ModuleContext } from '../types.js'

const RECIPIENT_KEY = new PrivateKey(2).toPublicKey().toString()

function addFundingInput(transaction: Transaction): void {
  const source = new Transaction()
  source.addOutput({ satoshis: 1_000_000, lockingScript: Script.fromASM('OP_1') })
  transaction.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_1')
  })
}

class BoundPaymentWallet {
  readonly abortAction = jest.fn(async () => ({ aborted: true }))
  readonly internalizeAction = jest.fn(async () => ({ accepted: true }))
  readonly getPublicKey = jest.fn(async () => ({ publicKey: RECIPIENT_KEY }))
  readonly signAction = jest.fn(async (_args: SignActionArgs) => {
    if (this.pending == null) throw new Error('missing pending transaction')
    return {
      tx: this.pending.toAtomicBEEF(true),
      txid: this.pending.id('hex')
    }
  })

  pending?: Transaction
  mutatePartial?: (transaction: Transaction) => void

  async createAction(args: CreateActionArgs) {
    this.pending = new Transaction(args.version ?? 1, [], [], args.lockTime ?? 0)
    addFundingInput(this.pending)
    for (const output of args.outputs ?? []) {
      this.pending.addOutput({
        satoshis: output.satoshis,
        lockingScript: Script.fromHex(output.lockingScript)
      })
    }
    this.mutatePartial?.(this.pending)
    return {
      signableTransaction: {
        reference: 'YnJjMjktc2VjdXJpdHk=',
        tx: this.pending.toAtomicBEEF(true)
      }
    }
  }
}

function context(wallet: BoundPaymentWallet): ModuleContext {
  return {
    wallet: wallet as unknown as WalletInterface,
    originator: 'example.com',
    now: () => 1
  }
}

function module(): Brc29RemittanceModule {
  let nonce = 0
  return new Brc29RemittanceModule({
    nonceProvider: {
      createNonce: async () => `nonce-${++nonce}`
    }
  })
}

async function withAmbientObjectProperties<T>(
  properties: Record<string, unknown>,
  callback: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries(properties)) {
    previous.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key))
    Object.defineProperty(Object.prototype, key, {
      value,
      configurable: true,
      writable: true
    })
  }
  try {
    return await callback()
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor == null) {
        Reflect.deleteProperty(Object.prototype, key)
      } else {
        Object.defineProperty(Object.prototype, key, descriptor)
      }
    }
  }
}

describe('Brc29RemittanceModule financial boundary hardening', () => {
  it('does not accept required payment terms inherited from Object.prototype', async () => {
    const wallet = new BoundPaymentWallet()
    const result = await withAmbientObjectProperties(
      { amountSatoshis: 1000, payee: 'ambient-payee' },
      async () =>
        await module().buildSettlement(
          {
            threadId: 'thread-1',
            option: {} as { amountSatoshis: number; payee: string }
          },
          context(wallet)
        )
    )

    expect(result).toMatchObject({
      action: 'terminate',
      termination: { code: 'brc29.invalid_option' }
    })
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('ignores an inherited protocol override when payment terms omit it', async () => {
    const wallet = new BoundPaymentWallet()
    const subject = module()
    const result = await withAmbientObjectProperties(
      { protocolID: [1, 'ambient-protocol'] },
      async () =>
        await subject.buildSettlement(
          {
            threadId: 'thread-1',
            option: { amountSatoshis: 1000, payee: 'payee-identity' }
          },
          context(wallet)
        )
    )

    expect(result.action).toBe('settle')
    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ protocolID: [2, '3241645161d8'] }),
      'example.com'
    )
  })

  it('does not accept required settlement terms inherited from Object.prototype', async () => {
    const wallet = new BoundPaymentWallet()
    const script = await DefaultLockingScriptProvider.pubKeyToP2PKHLockingScript(RECIPIENT_KEY)
    const transaction = new Transaction(
      1,
      [],
      [{ satoshis: 1000, lockingScript: Script.fromHex(script) }]
    )
    const result = await withAmbientObjectProperties(
      {
        customInstructions: { derivationPrefix: 'nonce-1', derivationSuffix: 'nonce-2' },
        transaction: transaction.toAtomicBEEF(true),
        amountSatoshis: 1000,
        outputIndex: 0
      },
      async () =>
        await module().acceptSettlement(
          {
            threadId: 'thread-1',
            sender: 'payer-identity',
            settlement: {} as never
          },
          context(wallet)
        )
    )

    expect(result).toMatchObject({
      action: 'terminate',
      termination: { code: 'brc29.internalize_failed' }
    })
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('does not accept derivation authority inherited by settlement instructions', async () => {
    const wallet = new BoundPaymentWallet()
    const script = await DefaultLockingScriptProvider.pubKeyToP2PKHLockingScript(RECIPIENT_KEY)
    const transaction = new Transaction(
      1,
      [],
      [{ satoshis: 1000, lockingScript: Script.fromHex(script) }]
    )
    const result = await withAmbientObjectProperties(
      { derivationPrefix: 'ambient-prefix', derivationSuffix: 'ambient-suffix' },
      async () =>
        await module().acceptSettlement(
          {
            threadId: 'thread-1',
            sender: 'payer-identity',
            settlement: {
              customInstructions: {} as never,
              transaction: transaction.toAtomicBEEF(true),
              amountSatoshis: 1000
            }
          },
          context(wallet)
        )
    )

    expect(result).toMatchObject({
      action: 'terminate',
      termination: { code: 'brc29.internalize_failed' }
    })
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('deferred-signs a bound recipient output and carries its verified index', async () => {
    const wallet = new BoundPaymentWallet()
    const result = await module().buildSettlement(
      {
        threadId: 'thread-1',
        option: { amountSatoshis: 1000, payee: 'payee-identity' }
      },
      context(wallet)
    )

    expect(result.action).toBe('settle')
    if (result.action !== 'settle') return
    expect(wallet.signAction).toHaveBeenCalledTimes(1)
    expect(result.artifact.outputIndex).toBe(0)
    expect(result.artifact.customInstructions.protocolID).toEqual([2, '3241645161d8'])
    const transaction = Transaction.fromAtomicBEEF(result.artifact.transaction)
    expect(transaction.outputs[0].satoshis).toBe(1000)
    expect(transaction.outputs[0].lockingScript.toHex()).toBe(
      await DefaultLockingScriptProvider.pubKeyToP2PKHLockingScript(RECIPIENT_KEY)
    )
  })

  it('rejects a wallet-substituted payment before signing it', async () => {
    const wallet = new BoundPaymentWallet()
    wallet.mutatePartial = transaction => {
      transaction.outputs[0].satoshis = 1
    }

    const result = await module().buildSettlement(
      {
        threadId: 'thread-1',
        option: { amountSatoshis: 1000, payee: 'payee-identity' }
      },
      context(wallet)
    )

    expect(result).toMatchObject({
      action: 'terminate',
      termination: { code: 'brc29.build_failed' }
    })
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('rejects a settlement whose claimed amount does not match its selected output', async () => {
    const wallet = new BoundPaymentWallet()
    const script = await DefaultLockingScriptProvider.pubKeyToP2PKHLockingScript(RECIPIENT_KEY)
    const transaction = new Transaction(
      1,
      [],
      [{ satoshis: 999, lockingScript: Script.fromHex(script) }]
    )

    const result = await module().acceptSettlement(
      {
        threadId: 'thread-1',
        sender: 'payer-identity',
        settlement: {
          customInstructions: {
            derivationPrefix: 'nonce-1',
            derivationSuffix: 'nonce-2',
            protocolID: [2, '3241645161d8']
          },
          transaction: transaction.toAtomicBEEF(true),
          amountSatoshis: 1000,
          outputIndex: 0
        }
      },
      context(wallet)
    )

    expect(result).toMatchObject({
      action: 'terminate',
      termination: { code: 'brc29.internalize_failed' }
    })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('rejects a settlement paid to a different derived script', async () => {
    const wallet = new BoundPaymentWallet()
    const wrongScript = await DefaultLockingScriptProvider.pubKeyToP2PKHLockingScript(
      new PrivateKey(3).toPublicKey().toString()
    )
    const transaction = new Transaction(
      1,
      [],
      [{ satoshis: 1000, lockingScript: Script.fromHex(wrongScript) }]
    )

    const result = await module().acceptSettlement(
      {
        threadId: 'thread-1',
        sender: 'payer-identity',
        settlement: {
          customInstructions: {
            derivationPrefix: 'nonce-1',
            derivationSuffix: 'nonce-2'
          },
          transaction: transaction.toAtomicBEEF(true),
          amountSatoshis: 1000,
          outputIndex: 0
        }
      },
      context(wallet)
    )

    expect(result).toMatchObject({
      action: 'terminate',
      termination: { code: 'brc29.internalize_failed' }
    })
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })
})
