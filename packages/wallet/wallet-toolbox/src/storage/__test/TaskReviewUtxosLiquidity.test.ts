import { TaskReviewUtxos } from '../../monitor/tasks/TaskReviewUtxos'
import { managedChangeOutputFields } from '../methods/managedChange'

describe('TaskReviewUtxos managed-change liquidity report', () => {
  test('reports value, reservation, and parent-status health without mutation', async () => {
    const now = new Date()
    const output = (outputId: number, transactionId: number, satoshis: number): any => ({
      outputId,
      transactionId,
      userId: 1,
      basketId: 7,
      satoshis,
      txid: outputId.toString(16).padStart(64, '0'),
      vout: 0,
      spendable: true,
      spentBy: undefined,
      derivationPrefix: 'prefix',
      derivationSuffix: `suffix-${outputId}`,
      created_at: now,
      updated_at: now,
      ...managedChangeOutputFields
    })
    const outputs = [output(11, 101, 5_000), output(12, 102, 4_999), output(13, 103, 8_000)]
    const provider = {
      findUsers: jest.fn().mockResolvedValue([{
        userId: 1,
        identityKey: 'key-1',
        activeStorage: 'storage-key',
        created_at: now,
        updated_at: now
      }]),
      findOutputBaskets: jest.fn().mockResolvedValue([{
        basketId: 7,
        userId: 1,
        name: 'default',
        numberOfDesiredUTXOs: 144,
        minimumDesiredUTXOValue: 5_000
      }]),
      findOutputs: jest.fn().mockResolvedValue(outputs),
      findReservedActionBatchOutputIds: jest.fn().mockResolvedValue([13]),
      findTransactionStatusesByIds: jest.fn().mockResolvedValue(new Map([
        [101, 'completed'],
        [102, 'unproven'],
        [103, 'sending']
      ]))
    }
    const runAsStorageProvider = jest.fn(async (fn: any) => await fn(provider))
    const task = new TaskReviewUtxos({ storage: { runAsStorageProvider } } as any)

    const log = await task.reviewManagedChangeByIdentityKey('key-1')

    expect(provider.findOutputs).toHaveBeenCalledWith(expect.objectContaining({
      txStatus: ['completed', 'unproven', 'sending'],
      noScript: true
    }))
    expect(log).toBe(
      'userId 1: managed change 3/144, healthy 2, undersized 1, reserved 1, ' +
      'completed 1, unproven 1, sending 1, satoshis 17999, preferred minimum 5000\n'
    )
  })
})
