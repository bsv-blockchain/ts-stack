import { StorageProvider } from '../StorageProvider'
import { ProvenOrRawTx, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { TableOutput } from '../schema/tables'

describe('StorageProvider batch fallbacks', () => {
  const trx = {} as TrxToken

  test('inserts output batches in order through custom providers', async () => {
    const insertOutput = jest.fn(async () => 1)
    const outputs = [{ outputId: 1 }, { outputId: 2 }] as TableOutput[]

    await StorageProvider.prototype.insertOutputs.call({ insertOutput }, outputs, trx)

    expect(insertOutput.mock.calls).toEqual([
      [outputs[0], trx],
      [outputs[1], trx]
    ])
  })

  test('projects only the fields required by the funding planner', async () => {
    const rows = [{
      outputId: 11,
      transactionId: 22,
      satoshis: 33,
      txid: '44'.repeat(32),
      vout: 5,
      lockingScript: [0x51]
    }] as TableOutput[]
    const findAvailableManagedChangeInputs = jest.fn(async () => rows)

    const result = await StorageProvider.prototype.findAvailableManagedChangeInputCandidates.call(
      { findAvailableManagedChangeInputs },
      1,
      2,
      true,
      trx
    )

    expect(result).toEqual([{
      outputId: 11,
      transactionId: 22,
      satoshis: 33,
      txid: '44'.repeat(32),
      vout: 5
    }])
    expect(findAvailableManagedChangeInputs).toHaveBeenCalledWith(1, 2, true, trx)
  })

  test('filters locked funding rows by owner, reservation, and source status', async () => {
    const eligible = { outputId: 1, userId: 7, transactionId: 11 }
    const reserved = { outputId: 2, userId: 7, transactionId: 12 }
    const wrongUser = { outputId: 3, userId: 8, transactionId: 13 }
    const wrongStatus = { outputId: 4, userId: 7, transactionId: 14 }
    const rows = { 1: eligible, 2: reserved, 3: wrongUser, 4: wrongStatus } as Record<number, TableOutput>
    const provider = {
      findOutputsByIds: jest.fn(async () => rows),
      findReservedActionBatchOutputIds: jest.fn(async () => [2]),
      findTransactionStatusesByIds: jest.fn(async () => new Map([
        [11, 'completed'],
        [12, 'completed'],
        [13, 'completed'],
        [14, 'failed']
      ]))
    }

    const result = await StorageProvider.prototype.findFundingOutputsForUpdate.call(
      provider,
      7,
      [1, 2, 3, 4],
      ['completed'],
      trx
    )

    expect(result).toEqual({ 1: eligible })
    expect(provider.findTransactionStatusesByIds).toHaveBeenCalledWith(
      7,
      [11, 12, 13, 14],
      trx
    )
  })

  test('deduplicates and concurrently resolves proof records for custom providers', async () => {
    const getProvenOrRawTx = jest.fn(async (txid: string): Promise<ProvenOrRawTx> => ({
      rawTx: [Number.parseInt(txid.slice(0, 2), 16)]
    }))
    const provider = { getProvenOrRawTx }

    await expect(StorageProvider.prototype.getProvenOrRawTxs.call(provider, [], trx))
      .resolves.toEqual(new Map())
    const result = await StorageProvider.prototype.getProvenOrRawTxs.call(
      provider,
      ['11'.repeat(32), '22'.repeat(32), '11'.repeat(32)],
      trx
    )

    expect([...result.keys()]).toEqual(['11'.repeat(32), '22'.repeat(32)])
    expect(getProvenOrRawTx).toHaveBeenCalledTimes(2)
    expect(getProvenOrRawTx).toHaveBeenCalledWith('11'.repeat(32), trx)
    expect(getProvenOrRawTx).toHaveBeenCalledWith('22'.repeat(32), trx)
  })
})
