import {
  LockingScript,
  PrivateKey,
  ProtoWallet,
  Transaction,
  type CreateActionArgs,
  type CreateActionResult,
  type InternalizeActionArgs,
  type InternalizeActionResult,
  type WalletInterface
} from '@bsv/sdk'

export interface FixtureWallet extends WalletInterface {
  readonly createdActions: number
  readonly receivedSatoshis: number
  readonly internalizedActions: readonly InternalizeActionArgs[]
}

/**
 * Adds only the transaction methods deliberately absent from ProtoWallet.
 * It is an executable fixture for the reference workbench, not a network wallet:
 * production mode supplies the same WalletInterface from a BRC-100 wallet.
 */
export function createFixtureWallet(privateKey: number): FixtureWallet {
  const proto = new ProtoWallet(new PrivateKey(privateKey))
  const internalizedActions: InternalizeActionArgs[] = []
  let createdActions = 0
  let receivedSatoshis = 0

  const createAction = async (args: CreateActionArgs): Promise<CreateActionResult> => {
    createdActions += 1
    const outputs = (args.outputs ?? [])
      .map(output => ({
        satoshis: output.satoshis,
        lockingScript: LockingScript.fromHex(output.lockingScript)
      }))
      .reverse()
    const transaction = new Transaction(args.version ?? 1, [], outputs, args.lockTime ?? 0)
    return {
      txid: transaction.id('hex'),
      tx: transaction.toAtomicBEEF(true)
    }
  }

  const internalizeAction = async (
    args: InternalizeActionArgs
  ): Promise<InternalizeActionResult> => {
    const transaction = Transaction.fromAtomicBEEF(args.tx)
    for (const output of args.outputs) {
      const transactionOutput = transaction.outputs[output.outputIndex]
      if (transactionOutput?.satoshis !== undefined) receivedSatoshis += transactionOutput.satoshis
    }
    internalizedActions.push(args)
    return { accepted: true }
  }

  return new Proxy(proto as unknown as FixtureWallet, {
    get(target, property, receiver) {
      if (property === 'createAction') return createAction
      if (property === 'internalizeAction') return internalizeAction
      if (property === 'createdActions') return createdActions
      if (property === 'receivedSatoshis') return receivedSatoshis
      if (property === 'internalizedActions') return internalizedActions
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
