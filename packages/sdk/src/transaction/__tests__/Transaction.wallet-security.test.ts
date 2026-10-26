import Script from '../../script/Script'
import Transaction from '../Transaction'
import type {
  CreateActionArgs,
  CreateActionResult,
  SignActionArgs,
  SignActionResult,
  WalletInterface
} from '../../wallet/Wallet.interfaces'

function sourceTransaction(marker: number, satoshis = 10_000): Transaction {
  return new Transaction(1, [], [{ satoshis, lockingScript: Script.fromASM(`OP_${marker}`) }], 0)
}

function transactionFromAction(
  args: CreateActionArgs,
  inputOrder?: number[],
  mutate?: (transaction: Transaction) => void
): Transaction {
  const transaction = new Transaction(args.version ?? 1, [], [], args.lockTime ?? 0)
  const requestedInputs = args.inputs ?? []
  for (const inputIndex of inputOrder ?? requestedInputs.map((_, index) => index)) {
    const input = requestedInputs[inputIndex]
    const [sourceTXID, outputIndex] = input.outpoint.split('.')
    transaction.addInput({
      sourceTXID,
      sourceOutputIndex: Number(outputIndex),
      sequence: input.sequenceNumber,
      unlockingScript:
        input.unlockingScript == null
          ? Script.fromASM('OP_0')
          : Script.fromHex(input.unlockingScript)
    })
  }
  for (const output of args.outputs ?? []) {
    transaction.addOutput({
      satoshis: output.satoshis,
      lockingScript: Script.fromHex(output.lockingScript)
    })
  }
  mutate?.(transaction)
  return transaction
}

class BoundActionWallet {
  readonly abortAction = jest.fn(async () => ({ aborted: true }))
  readonly signAction = jest.fn(async (args: SignActionArgs): Promise<SignActionResult> => {
    if (this.pending == null) throw new Error('No pending transaction')
    const signed = Transaction.fromAtomicBEEF(this.pending.toAtomicBEEF(true))
    for (const [inputIndex, spend] of Object.entries(args.spends)) {
      signed.inputs[Number(inputIndex)].unlockingScript = Script.fromHex(spend.unlockingScript)
    }
    this.mutateSigned?.(signed)
    return {
      tx: signed.toAtomicBEEF(true),
      txid: this.returnedTxid ?? signed.id('hex')
    }
  })

  pending?: Transaction
  returnedTxid?: string
  inputOrder?: number[]
  mutatePartial?: (transaction: Transaction) => void
  mutateSigned?: (transaction: Transaction) => void

  async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    this.pending = transactionFromAction(args, this.inputOrder, this.mutatePartial)
    return {
      signableTransaction: {
        reference: 'c2VjdXJpdHktdGVzdA==',
        tx: this.pending.toAtomicBEEF(true)
      }
    }
  }
}

function templatedTransaction(
  sources: Transaction[],
  signedIndexes: number[],
  script = Script.fromASM('OP_9')
): Transaction {
  return new Transaction(
    1,
    sources.map((source, originalIndex) => ({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      sequence: 0xffffffff,
      unlockingScriptTemplate: {
        estimateLength: async () => 1,
        sign: async (_transaction: Transaction, inputIndex: number) => {
          signedIndexes[originalIndex] = inputIndex
          return Script.fromASM(`OP_${originalIndex + 1}`)
        }
      }
    })),
    [{ satoshis: 9_000, lockingScript: script }],
    0
  )
}

describe('Transaction.completeWithWallet template binding', () => {
  it('rejects a wallet-substituted requested input before invoking a signing template', async () => {
    const signedIndexes: number[] = []
    const transaction = templatedTransaction([sourceTransaction(1)], signedIndexes)
    const wallet = new BoundActionWallet()
    wallet.mutatePartial = partial => {
      partial.inputs[0].sourceTXID = '11'.repeat(32)
    }

    await expect(
      transaction.completeWithWallet(wallet as unknown as WalletInterface)
    ).rejects.toThrow('each requested input exactly once')
    expect(signedIndexes).toEqual([])
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledWith(
      { reference: 'c2VjdXJpdHktdGVzdA==' },
      undefined
    )
  })

  it('rejects a wallet-substituted requested output before invoking a signing template', async () => {
    const signedIndexes: number[] = []
    const transaction = templatedTransaction([sourceTransaction(1)], signedIndexes)
    const wallet = new BoundActionWallet()
    wallet.mutatePartial = partial => {
      partial.outputs[0].satoshis = 8_999
    }

    await expect(
      transaction.completeWithWallet(wallet as unknown as WalletInterface)
    ).rejects.toThrow('omitted or substituted a requested output')
    expect(signedIndexes).toEqual([])
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('signs the actual bound indexes when a wallet reorders requested inputs', async () => {
    const signedIndexes: number[] = []
    const first = sourceTransaction(1)
    const second = sourceTransaction(2)
    const transaction = templatedTransaction([first, second], signedIndexes)
    const wallet = new BoundActionWallet()
    wallet.inputOrder = [1, 0]

    await transaction.completeWithWallet(wallet as unknown as WalletInterface)

    expect(signedIndexes).toEqual([1, 0])
    expect(wallet.signAction.mock.calls[0][0].spends).toEqual({
      0: { unlockingScript: Script.fromASM('OP_2').toHex() },
      1: { unlockingScript: Script.fromASM('OP_1').toHex() }
    })
    expect(transaction.inputs[0].sourceTXID).toBe(second.id('hex'))
    expect(transaction.inputs[1].sourceTXID).toBe(first.id('hex'))
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('rejects output substitution between createAction and signAction', async () => {
    const transaction = templatedTransaction([sourceTransaction(1)], [])
    const wallet = new BoundActionWallet()
    wallet.mutateSigned = signed => {
      signed.outputs[0].lockingScript = Script.fromASM('OP_RETURN')
    }

    await expect(
      transaction.completeWithWallet(wallet as unknown as WalletInterface)
    ).rejects.toThrow('substituted an authorized output')
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('rejects a returned transaction ID that does not match the signed transaction', async () => {
    const transaction = templatedTransaction([sourceTransaction(1)], [])
    const wallet = new BoundActionWallet()
    wallet.returnedTxid = '22'.repeat(32)

    await expect(
      transaction.completeWithWallet(wallet as unknown as WalletInterface)
    ).rejects.toThrow('does not match its transaction data')
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('validates precompiled-script actions before finalizing them', async () => {
    const source = sourceTransaction(1)
    const unlockingScript = Script.fromASM('OP_1')
    const transaction = new Transaction(
      1,
      [{ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript }],
      [{ satoshis: 9_000, lockingScript: Script.fromASM('OP_9') }],
      0
    )
    const wallet = new BoundActionWallet()

    await transaction.completeWithWallet(wallet as unknown as WalletInterface)

    expect(wallet.signAction.mock.calls[0][0].spends).toEqual({})
    expect(transaction.inputs[0].unlockingScript?.toHex()).toBe(unlockingScript.toHex())
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })
})
