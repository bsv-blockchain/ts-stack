import Script from '../../script/Script'
import Transaction from '../../transaction/Transaction'
import Beef from '../../transaction/Beef'
import type { CreateActionArgs, SignActionArgs, WalletInterface } from '../Wallet.interfaces'
import { completeBoundAction } from '../completeBoundAction'

function sourceTransaction(satoshis: number, opcode: string): Transaction {
  const source = new Transaction()
  source.addOutput({ satoshis, lockingScript: Script.fromASM(opcode) })
  return source
}

const requestedSource = sourceTransaction(100, 'OP_2')
const walletFundingSource = sourceTransaction(10, 'OP_3')
const sourceTXID = requestedSource.id('hex')
const requestedOutpoint = `${sourceTXID}.0`

function partialFromArgs(args: CreateActionArgs): Transaction {
  const transaction = new Transaction(args.version ?? 1, [], [], args.lockTime ?? 0)
  transaction.addInput({
    sourceTransaction: walletFundingSource,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_0')
  })
  transaction.addInput({
    sourceTransaction: requestedSource,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_0')
  })
  for (const output of args.outputs ?? []) {
    transaction.addOutput({
      satoshis: output.satoshis,
      lockingScript: Script.fromHex(output.lockingScript)
    })
  }
  return transaction
}

class TestWallet {
  readonly abortAction = jest.fn(async () => ({ aborted: true }))
  readonly signAction = jest.fn(async (args: SignActionArgs) => {
    if (this.partial == null) throw new Error('No partial transaction')
    const signed = Transaction.fromAtomicBEEF(this.partial.toAtomicBEEF(true))
    for (const [inputIndex, spend] of Object.entries(args.spends)) {
      signed.inputs[Number(inputIndex)].unlockingScript = Script.fromHex(spend.unlockingScript)
    }
    this.mutateSigned?.(signed)
    return { tx: signed.toAtomicBEEF(true), txid: signed.id('hex') }
  })

  partial?: Transaction
  onCreate?: () => void
  mutateRequest?: (args: CreateActionArgs) => void
  mutatePartial?: (transaction: Transaction) => void
  mutateSigned?: (transaction: Transaction) => void

  async createAction(args: CreateActionArgs) {
    this.onCreate?.()
    this.mutateRequest?.(args)
    this.partial = partialFromArgs(args)
    this.mutatePartial?.(this.partial)
    return {
      signableTransaction: {
        reference: 'Ym91bmQtYWN0aW9u',
        tx: this.partial.toAtomicBEEF(true)
      }
    }
  }
}

function createArgs(): CreateActionArgs {
  return {
    description: 'Bound action security test',
    version: 1,
    lockTime: 0,
    inputs: [
      {
        outpoint: requestedOutpoint,
        inputDescription: 'Requested token input',
        unlockingScriptLength: 1
      }
    ],
    outputs: [
      {
        satoshis: 1,
        lockingScript: Script.fromASM('OP_9').toHex(),
        outputDescription: 'Requested token output'
      }
    ]
  }
}

const sparseAuthorizations: unknown[] = []
sparseAuthorizations.length = 1

describe('completeBoundAction', () => {
  it('binds an explicitly authorized additional output without relaxing other extra outputs', async () => {
    const wallet = new TestWallet()
    wallet.mutatePartial = tx =>
      tx.addOutput({ satoshis: 50, lockingScript: Script.fromASM('OP_4') })
    const tx = await completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
      inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') },
      authorizeAdditionalOutputs: () => [{ outputIndex: 1, lockingScript: '54', satoshis: 50 }]
    })
    expect(tx.outputs[1].satoshis).toBe(50)
    expect(wallet.signAction).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ outputIndex: 1, lockingScript: '55', satoshis: 50 }],
    [{ outputIndex: 1, lockingScript: '54', satoshis: 49 }],
    [{ outputIndex: 2, lockingScript: '54', satoshis: 50 }],
    [{ outputIndex: 0, lockingScript: '59', satoshis: 1 }],
    [
      { outputIndex: 1, lockingScript: '54', satoshis: 50 },
      { outputIndex: 1, lockingScript: '54', satoshis: 50 }
    ]
  ])(
    'rejects substituted, missing, requested or duplicate additional authorizations: %j',
    async (...outputs) => {
      const wallet = new TestWallet()
      wallet.mutatePartial = tx =>
        tx.addOutput({ satoshis: 50, lockingScript: Script.fromASM('OP_4') })
      const signer = jest.fn(async () => Script.fromASM('OP_1'))
      await expect(
        completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
          inputSigners: { [requestedOutpoint]: signer },
          authorizeAdditionalOutputs: () => outputs
        })
      ).rejects.toThrow('authorized additional output')
      expect(signer).not.toHaveBeenCalled()
      expect(wallet.signAction).not.toHaveBeenCalled()
      expect(wallet.abortAction).toHaveBeenCalledTimes(1)
    }
  )

  it('does not authorize another injected output along with an approved fee', async () => {
    const wallet = new TestWallet()
    wallet.mutatePartial = tx => {
      tx.addOutput({ satoshis: 50, lockingScript: Script.fromASM('OP_4') })
      tx.addOutput({ satoshis: 20, lockingScript: Script.fromASM('OP_5') })
    }
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') },
        authorizeAdditionalOutputs: () => [{ outputIndex: 1, lockingScript: '54', satoshis: 50 }]
      })
    ).rejects.toThrow('requested input to fund an unrequested output')
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('aborts if local output policy rejects the result', async () => {
    const wallet = new TestWallet()
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        authorizeAdditionalOutputs: () => {
          throw new Error('Policy refused')
        }
      })
    ).rejects.toThrow('Policy refused')
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it.each([
    null,
    sparseAuthorizations,
    [{ outputIndex: -1, lockingScript: '54', satoshis: 50 }],
    [{ outputIndex: 1, lockingScript: '5', satoshis: 50 }],
    [{ outputIndex: 1, lockingScript: '54', satoshis: Number.NaN }],
    [{ outputIndex: 1, lockingScript: '54', satoshis: 50, ignored: true }]
  ])('rejects malformed local policy output: %j', async outputs => {
    const wallet = new TestWallet()
    const signer = jest.fn(async () => Script.fromASM('OP_1'))
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: signer },
        authorizeAdditionalOutputs: () => outputs as never
      })
    ).rejects.toThrow()
    expect(signer).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('does not invoke accessors on local output authorizations', async () => {
    const wallet = new TestWallet()
    const getter = jest.fn(() => 50)
    const output = { outputIndex: 1, lockingScript: '54' }
    Object.defineProperty(output, 'satoshis', { enumerable: true, get: getter })
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        authorizeAdditionalOutputs: () => [output as never]
      })
    ).rejects.toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('still conserves input value with an explicitly authorized fee', async () => {
    const wallet = new TestWallet()
    wallet.mutatePartial = tx =>
      tx.addOutput({ satoshis: 110, lockingScript: Script.fromASM('OP_4') })
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        authorizeAdditionalOutputs: () => [{ outputIndex: 1, lockingScript: '54', satoshis: 110 }]
      })
    ).rejects.toThrow('spends more than its inputs')
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('rejects a fee substitution in the signed response', async () => {
    const wallet = new TestWallet()
    wallet.mutatePartial = tx =>
      tx.addOutput({ satoshis: 50, lockingScript: Script.fromASM('OP_4') })
    wallet.mutateSigned = tx => {
      tx.outputs[1].lockingScript = Script.fromASM('OP_5')
    }
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') },
        authorizeAdditionalOutputs: () => [{ outputIndex: 1, lockingScript: '54', satoshis: 50 }]
      })
    ).rejects.toThrow('substituted an authorized output')
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('signs the unique requested outpoint at its actual partial-transaction index', async () => {
    const wallet = new TestWallet()
    const signer = jest.fn(async (_transaction: Transaction, inputIndex: number) => {
      expect(inputIndex).toBe(1)
      return Script.fromASM('OP_1')
    })

    const transaction = await completeBoundAction(
      wallet as unknown as WalletInterface,
      createArgs(),
      { inputSigners: { [requestedOutpoint]: signer } }
    )

    expect(signer).toHaveBeenCalledTimes(1)
    expect(wallet.signAction.mock.calls[0][0].spends).toEqual({
      1: { unlockingScript: Script.fromASM('OP_1').toHex() }
    })
    expect(transaction.inputs[1].unlockingScript?.toHex()).toBe(Script.fromASM('OP_1').toHex())
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('rejects a substituted requested output before calling its signer', async () => {
    const wallet = new TestWallet()
    wallet.mutatePartial = transaction => {
      transaction.outputs[0].satoshis = 2
    }
    const signer = jest.fn(async () => Script.fromASM('OP_1'))

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: signer }
      })
    ).rejects.toThrow('omitted or substituted a requested output')
    expect(signer).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('rejects an unrequested output funded by the externally signed input', async () => {
    const wallet = new TestWallet()
    wallet.mutatePartial = transaction => {
      transaction.addOutput({ satoshis: 50, lockingScript: Script.fromASM('OP_4') })
    }
    const signer = jest.fn(async () => Script.fromASM('OP_1'))

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: signer }
      })
    ).rejects.toThrow('requested input to fund an unrequested output')
    expect(signer).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('binds a fee-adjusted requested output to its exact script and authorized amount range', async () => {
    const wallet = new TestWallet()
    const args = createArgs()
    args.outputs![0].satoshis = 1_000
    wallet.mutatePartial = transaction => {
      transaction.outputs[0].satoshis = 99
    }

    const transaction = await completeBoundAction(wallet as unknown as WalletInterface, args, {
      inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') },
      outputSatoshisRanges: { 0: { minimumSatoshis: 90, maximumSatoshis: 100 } }
    })

    expect(transaction.outputs[0].satoshis).toBe(99)
    expect(transaction.outputs[0].lockingScript.toHex()).toBe(args.outputs![0].lockingScript)
  })

  it('binds duplicate identical requested outputs as a multiset', async () => {
    const wallet = new TestWallet()
    const args = createArgs()
    args.outputs![1] = { ...args.outputs![0] }

    const transaction = await completeBoundAction(wallet as unknown as WalletInterface, args, {
      inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
    })

    expect(transaction.outputs).toHaveLength(2)
    expect(transaction.outputs[0].satoshis).toBe(1)
    expect(transaction.outputs[1].satoshis).toBe(1)
  })

  it('preserves requested output positions only when randomization is disabled', async () => {
    const orderedArgs = createArgs()
    orderedArgs.outputs![1] = {
      satoshis: 2,
      lockingScript: Script.fromASM('OP_8').toHex(),
      outputDescription: 'Second requested output'
    }
    orderedArgs.options = { randomizeOutputs: false }
    const reordered = new TestWallet()
    reordered.mutatePartial = transaction => {
      const first = transaction.outputs[0]
      transaction.outputs[0] = transaction.outputs[1]
      transaction.outputs[1] = first
    }
    const signer = jest.fn(async () => Script.fromASM('OP_1'))

    await expect(
      completeBoundAction(reordered as unknown as WalletInterface, orderedArgs, {
        inputSigners: { [requestedOutpoint]: signer }
      })
    ).rejects.toThrow('requested output position')
    expect(signer).not.toHaveBeenCalled()

    const randomizedArgs = createArgs()
    randomizedArgs.outputs![1] = { ...orderedArgs.outputs![1] }
    const randomized = new TestWallet()
    randomized.mutatePartial = reordered.mutatePartial
    await expect(
      completeBoundAction(randomized as unknown as WalletInterface, randomizedArgs, {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).resolves.toBeInstanceOf(Transaction)
  })

  it('rejects fee-adjusted outputs outside their amount range or with an ambiguous match', async () => {
    const args = createArgs()
    args.outputs![0].satoshis = 1_000
    const outside = new TestWallet()
    outside.mutatePartial = transaction => {
      transaction.outputs[0].satoshis = 89
    }
    await expect(
      completeBoundAction(outside as unknown as WalletInterface, args, {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') },
        outputSatoshisRanges: { 0: { minimumSatoshis: 90, maximumSatoshis: 100 } }
      })
    ).rejects.toThrow('omitted or substituted a requested output')

    const ambiguous = new TestWallet()
    ambiguous.mutatePartial = transaction => {
      transaction.outputs[0].satoshis = 99
      transaction.addOutput({ satoshis: 98, lockingScript: transaction.outputs[0].lockingScript })
    }
    await expect(
      completeBoundAction(ambiguous as unknown as WalletInterface, args, {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') },
        outputSatoshisRanges: { 0: { minimumSatoshis: 90, maximumSatoshis: 100 } }
      })
    ).rejects.toThrow('omitted or substituted a requested output')
  })

  it('rejects signed-transaction substitution after the authorized signer runs', async () => {
    const wallet = new TestWallet()
    wallet.mutateSigned = transaction => {
      transaction.outputs[0].lockingScript = Script.fromASM('OP_RETURN')
    }

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow('substituted an authorized output')
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('does not let a wallet hide substituted unlocking scripts through Map iteration', async () => {
    const wallet = new TestWallet()
    wallet.mutateSigned = transaction => {
      transaction.inputs[1].unlockingScript = Script.fromASM('OP_2')
    }
    const originalIterator = Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator)!
    const signAction = wallet.signAction.getMockImplementation()!
    wallet.signAction.mockImplementationOnce(async args => {
      const result = await signAction(args)
      Object.defineProperty(Map.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value: function* () {}
      })
      return result
    })

    try {
      await expect(
        completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
          inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
        })
      ).rejects.toThrow('modified shared JavaScript intrinsics')
    } finally {
      Object.defineProperty(Map.prototype, Symbol.iterator, originalIterator)
    }
  })

  it('owns its authorization request across asynchronous wallet work', async () => {
    const wallet = new TestWallet()
    const args = createArgs()
    wallet.onCreate = () => {
      args.outputs![0].satoshis = 99
      args.inputs![0].outpoint = `${'33'.repeat(32)}.4`
    }

    const transaction = await completeBoundAction(wallet as unknown as WalletInterface, args, {
      inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
    })

    expect(transaction.outputs[0].satoshis).toBe(1)
    expect(transaction.inputs[1].sourceTXID).toBe(sourceTXID)
  })

  it('owns and validates trusted source amounts before asynchronous wallet work', async () => {
    const wallet = new TestWallet()
    const trustedAmounts = [100]
    wallet.onCreate = () => {
      trustedAmounts[0] = -100
    }

    await expect(
      completeBoundAction(
        wallet as unknown as WalletInterface,
        createArgs(),
        { inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') } },
        undefined,
        trustedAmounts
      )
    ).resolves.toBeInstanceOf(Transaction)

    const accessorAmounts = [100]
    const getter = jest.fn(() => 100)
    Object.defineProperty(accessorAmounts, '0', { enumerable: true, get: getter })
    await expect(
      completeBoundAction(
        new TestWallet() as unknown as WalletInterface,
        createArgs(),
        {},
        undefined,
        accessorAmounts
      )
    ).rejects.toThrow('dense data arrays')
    expect(getter).not.toHaveBeenCalled()

    await expect(
      completeBoundAction(
        new TestWallet() as unknown as WalletInterface,
        createArgs(),
        {},
        undefined,
        [-1]
      )
    ).rejects.toThrow('valid satoshi amount')
  })

  it('accepts a valid legacy number-array input BEEF above the structural node cap', async () => {
    const largeSource = new Transaction()
    largeSource.addOutput({
      satoshis: 1,
      lockingScript: Script.fromHex('00'.repeat(1_000_001))
    })
    const beef = new Beef()
    beef.mergeTransaction(requestedSource)
    beef.mergeTransaction(largeSource)
    const inputBEEF = beef.toBinary()
    expect(inputBEEF.length).toBeGreaterThan(1_000_000)

    const args = createArgs()
    args.inputBEEF = inputBEEF
    await expect(
      completeBoundAction(new TestWallet() as unknown as WalletInterface, args, {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).resolves.toBeInstanceOf(Transaction)
  })

  it('preserves repeated byte-array aliases in the isolated wallet request', async () => {
    const wallet = new TestWallet()
    const shared = [1, 2, 3]
    const args = createArgs() as CreateActionArgs & { first: number[]; second: number[] }
    args.first = shared
    args.second = shared
    wallet.mutateRequest = request => {
      const received = request as CreateActionArgs & { first: number[]; second: number[] }
      expect(received.first).toBe(received.second)
      expect(received.first).not.toBe(shared)
    }

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, args, {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).resolves.toBeInstanceOf(Transaction)
  })

  it.each([
    ['Buffer', (bytes: number[]): number[] => Buffer.from(bytes) as unknown as number[]],
    [
      'Uint8Array subclass',
      (bytes: number[]): number[] => {
        class WalletBytes extends Uint8Array {}
        return new WalletBytes(bytes) as unknown as number[]
      }
    ]
  ])('accepts intrinsic %s transaction bytes', async (_name, convert) => {
    const wallet = new TestWallet()
    const createAction = wallet.createAction.bind(wallet)
    wallet.createAction = async args => {
      const result = await createAction(args)
      result.signableTransaction.tx = convert(result.signableTransaction.tx)
      return result
    }
    const signAction = wallet.signAction.getMockImplementation()!
    wallet.signAction.mockImplementationOnce(async args => {
      const result = await signAction(args)
      result.tx = convert(result.tx)
      return result
    })

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).resolves.toBeInstanceOf(Transaction)
  })

  it('uses intrinsic typed-array bounds and rejects shared transaction storage', async () => {
    const shadowed = new TestWallet()
    const shadowedCreateAction = shadowed.createAction.bind(shadowed)
    shadowed.createAction = async args => {
      const result = await shadowedCreateAction(args)
      const tx = new Uint8Array(result.signableTransaction.tx)
      Object.defineProperties(tx, {
        byteLength: { value: 0, enumerable: false },
        length: { value: 0, enumerable: false }
      })
      result.signableTransaction.tx = tx as unknown as number[]
      return result
    }
    await expect(
      completeBoundAction(shadowed as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).resolves.toBeInstanceOf(Transaction)

    if (typeof SharedArrayBuffer === 'undefined') return
    const shared = new TestWallet()
    const sharedCreateAction = shared.createAction.bind(shared)
    shared.createAction = async args => {
      const result = await sharedCreateAction(args)
      const original = result.signableTransaction.tx
      const tx = new Uint8Array(new SharedArrayBuffer(original.length))
      tx.set(original)
      result.signableTransaction.tx = tx as unknown as number[]
      return result
    }
    await expect(
      completeBoundAction(shared as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow('shared byte storage')
  })

  it('owns wallet result descriptors instead of reading hostile get traps', async () => {
    const wallet = new TestWallet()
    const createAction = wallet.createAction.bind(wallet)
    let hostileReads = 0
    wallet.createAction = async args => {
      const result = await createAction(args)
      return new Proxy(result, {
        get(target, key, receiver) {
          if (key === 'signableTransaction') {
            hostileReads++
            return { reference: 'hostile', tx: [] }
          }
          return Reflect.get(target, key, receiver)
        }
      })
    }

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).resolves.toBeInstanceOf(Transaction)
    expect(hostileReads).toBe(0)
  })

  it('rejects accessor-backed input BEEF without invoking it', async () => {
    const args = createArgs()
    const getter = jest.fn(() => 1)
    const inputBEEF = [0]
    Object.defineProperty(inputBEEF, '0', { enumerable: true, get: getter })
    args.inputBEEF = inputBEEF

    await expect(
      completeBoundAction(new TestWallet() as unknown as WalletInterface, args)
    ).rejects.toThrow('dense data arrays')
    expect(getter).not.toHaveBeenCalled()
  })

  it('ignores accessor-free local symbol metadata on wallet results', async () => {
    const wallet = new TestWallet()
    const metadata = Symbol.for('local-wallet-result-metadata')
    const createAction = wallet.createAction.bind(wallet)
    wallet.createAction = async args => ({ ...(await createAction(args)), [metadata]: 10 })

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).resolves.toBeInstanceOf(Transaction)
  })

  it('rejects accessor symbol metadata on wallet results without invoking it', async () => {
    const wallet = new TestWallet()
    const metadata = Symbol.for('hostile-wallet-result-metadata')
    const createAction = wallet.createAction.bind(wallet)
    let invoked = 0
    wallet.createAction = async args => {
      const result = await createAction(args)
      Object.defineProperty(result, metadata, {
        enumerable: true,
        get() {
          invoked += 1
          return 10
        }
      })
      return result
    }

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow('symbol metadata must be a data property')
    expect(invoked).toBe(0)
  })

  it('rejects wallet mutation of its isolated request copy', async () => {
    const wallet = new TestWallet()
    wallet.mutateRequest = args => {
      args.outputs![0].satoshis = 99
    }

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow('omitted or substituted a requested output')
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('rejects transaction-template mutation by an input signer', async () => {
    const wallet = new TestWallet()

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: {
          [requestedOutpoint]: async transaction => {
            transaction.outputs[0].satoshis = 99
            return Script.fromASM('OP_1')
          }
        }
      })
    ).rejects.toThrow('substituted an authorized output')
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('rejects accessors without invoking them', async () => {
    const wallet = new TestWallet()
    const args = createArgs()
    let invoked = 0
    Object.defineProperty(args, 'description', {
      enumerable: true,
      get() {
        invoked += 1
        return 'hostile'
      }
    })

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, args, {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow('data properties')
    expect(invoked).toBe(0)
  })

  it.each([
    ['non-finite numbers', Number.POSITIVE_INFINITY, 'ambiguous number'],
    ['negative zero', -0, 'ambiguous number'],
    ['bigints', 1n, 'unsupported data'],
    ['functions', () => undefined, 'unsupported data']
  ])('rejects %s anywhere in the authorization graph', async (_name, value, message) => {
    const wallet = new TestWallet()
    const args = createArgs() as CreateActionArgs & { hostile?: unknown }
    args.hostile = value

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, args, {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow(message)
  })

  it('rejects cyclic and excessively deep authorization graphs', async () => {
    const wallet = new TestWallet()
    const cyclic = createArgs() as CreateActionArgs & { hostile?: unknown }
    cyclic.hostile = cyclic
    await expect(completeBoundAction(wallet as unknown as WalletInterface, cyclic)).rejects.toThrow(
      'contains a cycle'
    )

    const deep = createArgs() as CreateActionArgs & { hostile?: unknown }
    let cursor: Record<string, unknown> = {}
    deep.hostile = cursor
    for (let index = 0; index < 65; index++) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    await expect(completeBoundAction(wallet as unknown as WalletInterface, deep)).rejects.toThrow(
      'exceeds the depth limit'
    )
  })

  it('rejects sparse arrays and array metadata without evaluating accessors', async () => {
    const wallet = new TestWallet()
    const sparse = createArgs()
    sparse.outputs = Array(1)
    await expect(completeBoundAction(wallet as unknown as WalletInterface, sparse)).rejects.toThrow(
      'dense data arrays'
    )

    const accessor = createArgs()
    let invoked = 0
    Object.defineProperty(accessor.outputs!, 'extra', {
      enumerable: true,
      get() {
        invoked += 1
        return 'hostile'
      }
    })
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, accessor)
    ).rejects.toThrow('dense data arrays')
    expect(invoked).toBe(0)
  })

  it.each([
    [{ unexpected: true }, 'Unknown bound action option'],
    [{ inputSigners: { invalid: async () => Script.fromASM('OP_1') } }, 'canonical outpoint'],
    [{ inputSigners: { [requestedOutpoint]: 'not a signer' } }, 'uniquely identify'],
    [
      { outputSatoshisRanges: { '01': { minimumSatoshis: 0, maximumSatoshis: 1 } } },
      'output indexes'
    ],
    [{ outputSatoshisRanges: { 1: { minimumSatoshis: 0, maximumSatoshis: 1 } } }, 'output indexes'],
    [
      { outputSatoshisRanges: { 0: { minimumSatoshis: 0, maximumSatoshis: 1, extra: 2 } } },
      'Unknown output satoshi range option'
    ],
    [
      { outputSatoshisRanges: { 0: { minimumSatoshis: 2, maximumSatoshis: 1 } } },
      'minimum exceeds its maximum'
    ],
    [
      { outputSatoshisRanges: { 0: { minimumSatoshis: -1, maximumSatoshis: 1 } } },
      'valid satoshi amount'
    ]
  ])('rejects malformed bound options %#', async (options, message) => {
    const wallet = new TestWallet()
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), options as never)
    ).rejects.toThrow(message as string)
  })

  it.each([
    ['version', (transaction: Transaction) => (transaction.version = 2), 'requested version'],
    ['lock time', (transaction: Transaction) => (transaction.lockTime = 1), 'requested lock time'],
    [
      'sequence',
      (transaction: Transaction) => (transaction.inputs[1].sequence = 1),
      'requested input sequence'
    ],
    [
      'requested input',
      (transaction: Transaction) => transaction.inputs.splice(1, 1),
      'each requested input exactly once'
    ]
  ])('rejects wallet substitution of the %s', async (_name, mutate, message) => {
    const wallet = new TestWallet()
    wallet.mutatePartial = mutate
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow(message as string)
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'default version',
      (transaction: Transaction) => (transaction.version = 2),
      'requested version'
    ],
    [
      'default lock time',
      (transaction: Transaction) => (transaction.lockTime = 1),
      'requested lock time'
    ]
  ])('binds the omitted %s', async (_name, mutate, message) => {
    const wallet = new TestWallet()
    const args = createArgs()
    delete args.version
    delete args.lockTime
    wallet.mutatePartial = mutate

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, args, {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow(message as string)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('rejects duplicate wallet and requested input outpoints', async () => {
    const duplicateWalletInput = new TestWallet()
    duplicateWalletInput.mutatePartial = transaction => {
      transaction.inputs[0].sourceTransaction = requestedSource
      transaction.inputs[0].sourceTXID = sourceTXID
    }
    await expect(
      completeBoundAction(duplicateWalletInput as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow('duplicate input outpoint')

    const duplicateRequest = createArgs()
    duplicateRequest.inputs!.push({ ...duplicateRequest.inputs![0] })
    await expect(
      completeBoundAction(new TestWallet() as unknown as WalletInterface, duplicateRequest)
    ).rejects.toThrow('same input outpoint more than once')
  })

  it('validates fixed unlocking scripts and does not require a callback signer', async () => {
    const wallet = new TestWallet()
    const args = createArgs()
    args.inputs![0].unlockingScript = Script.fromASM('OP_0').toHex()
    delete args.inputs![0].unlockingScriptLength

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, args)
    ).resolves.toBeInstanceOf(Transaction)
    expect(wallet.signAction.mock.calls[0][0].spends).toEqual({})

    const substituted = new TestWallet()
    substituted.mutatePartial = transaction => {
      transaction.inputs[1].unlockingScript = Script.fromASM('OP_1')
    }
    await expect(
      completeBoundAction(substituted as unknown as WalletInterface, args)
    ).rejects.toThrow('substituted a requested unlocking script')
  })

  it('rejects missing and surplus signers before signing', async () => {
    await expect(
      completeBoundAction(new TestWallet() as unknown as WalletInterface, createArgs())
    ).rejects.toThrow('has no authorized signer')

    const surplusOutpoint = `${'34'.repeat(32)}.0`
    await expect(
      completeBoundAction(new TestWallet() as unknown as WalletInterface, createArgs(), {
        inputSigners: {
          [requestedOutpoint]: async () => Script.fromASM('OP_1'),
          [surplusOutpoint]: async () => Script.fromASM('OP_1')
        }
      })
    ).rejects.toThrow('does not match a requested signable input')
  })

  it.each(['xyz', '0'])('rejects invalid signer script %p', async unlockingScript => {
    await expect(
      completeBoundAction(new TestWallet() as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => unlockingScript }
      })
    ).rejects.toThrow('even-length hexadecimal string')
  })

  it.each([
    ['', 'reference is invalid'],
    ['not*base64', 'reference is invalid'],
    ['x'.repeat(4097), 'reference is invalid']
  ])('rejects invalid wallet references %#', async (reference, message) => {
    const wallet = new TestWallet()
    const createAction = wallet.createAction.bind(wallet)
    wallet.createAction = async args => {
      const result = await createAction(args)
      result.signableTransaction.reference = reference
      return result
    }
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs())
    ).rejects.toThrow(message)
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('rejects invalid signable and signed transaction envelopes', async () => {
    const malformedCreate = new TestWallet()
    malformedCreate.createAction = async () => ({
      signableTransaction: { reference: 'cmVm', tx: [] }
    })
    await expect(
      completeBoundAction(malformedCreate as unknown as WalletInterface, createArgs())
    ).rejects.toThrow('bounded non-empty byte array')
    expect(malformedCreate.abortAction).toHaveBeenCalledWith({ reference: 'cmVm' }, undefined)

    const malformedSign = new TestWallet()
    malformedSign.signAction.mockImplementationOnce(async () => ({ tx: [] }))
    await expect(
      completeBoundAction(malformedSign as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow('bounded non-empty byte array')
    expect(malformedSign.abortAction).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['version', (transaction: Transaction) => (transaction.version += 1), 'authorized template'],
    ['lock time', (transaction: Transaction) => (transaction.lockTime += 1), 'authorized template'],
    [
      'input sequence',
      (transaction: Transaction) => (transaction.inputs[0].sequence = 10),
      'authorized input'
    ],
    [
      'input outpoint',
      (transaction: Transaction) => (transaction.inputs[0].sourceOutputIndex = 1),
      'authorized input'
    ],
    [
      'output value',
      (transaction: Transaction) => (transaction.outputs[0].satoshis += 1),
      'authorized output'
    ]
  ])('rejects signed %s substitution', async (_name, mutate, message) => {
    const wallet = new TestWallet()
    wallet.mutateSigned = mutate
    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow(message as string)
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched signed txid and preserves the primary error if aborting fails', async () => {
    const wallet = new TestWallet()
    const signAction = wallet.signAction.getMockImplementation()!
    wallet.signAction.mockImplementationOnce(async args => ({
      ...(await signAction(args)),
      txid: 'ff'.repeat(32)
    }))
    wallet.abortAction.mockRejectedValueOnce(new Error('abort unavailable'))

    await expect(
      completeBoundAction(wallet as unknown as WalletInterface, createArgs(), {
        inputSigners: { [requestedOutpoint]: async () => Script.fromASM('OP_1') }
      })
    ).rejects.toThrow('ID does not match')
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
  })
})
