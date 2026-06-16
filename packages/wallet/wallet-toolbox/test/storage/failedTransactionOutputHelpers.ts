import { _tu } from '../utils/TestUtilsWalletStorage'
import type { TransactionStatus } from '../../src/sdk/types'
import type { StorageProvider } from '../../src/storage/StorageProvider'
import type { TableOutput, TableTransaction } from '../../src/storage/schema/tables'

interface FailedTransactionOutputState {
  failedTx: TableTransaction
  generatedOutput: TableOutput
  inputOutput: TableOutput
}

export async function seedFailedTransactionOutputState (
  storage: StorageProvider,
  status: TransactionStatus
): Promise<FailedTransactionOutputState> {
  const { tx: fundingTx, user } = await _tu.insertTestTransaction(storage, undefined, false, {
    status: 'completed',
    txid: 'b'.repeat(64)
  })
  const { tx: failedTx } = await _tu.insertTestTransaction(storage, user, false, {
    status,
    txid: status === 'failed' ? 'c'.repeat(64) : undefined
  })
  const inputOutput = await _tu.insertTestOutput(storage, fundingTx, 0, 1000, undefined, false, {
    spendable: false,
    spentBy: failedTx.transactionId
  })
  const generatedOutput = await _tu.insertTestOutput(storage, failedTx, 0, 900, undefined, false, {
    spendable: true,
    spentBy: failedTx.transactionId
  })

  return { failedTx, generatedOutput, inputOutput }
}

export async function expectFailedTransactionOutputStateRepaired (
  storage: StorageProvider,
  state: FailedTransactionOutputState
): Promise<void> {
  const inputAfter = await findOneOutput(storage, state.inputOutput.outputId)
  expect(inputAfter.spendable).toBe(true)
  expect(inputAfter.spentBy).toBeUndefined()

  const generatedAfter = await findOneOutput(storage, state.generatedOutput.outputId)
  expect(generatedAfter.spendable).toBe(false)
  expect(generatedAfter.spentBy).toBeUndefined()
}

async function findOneOutput (storage: StorageProvider, outputId: number): Promise<TableOutput> {
  const outputs = await storage.findOutputs({ partial: { outputId } })
  expect(outputs).toHaveLength(1)
  return outputs[0]
}
