import { TaskFailAbandoned } from '../TaskFailAbandoned'

describe('TaskFailAbandoned', () => {
  test('uses source-page size and mutation-safe offsets so later abandoned rows are not skipped', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const fresh = new Date()
    const rows = [
      { transactionId: 1, status: 'unprocessed', updated_at: old },
      ...Array.from({ length: 99 }, (_, index) => ({
        transactionId: index + 2,
        status: 'unprocessed',
        updated_at: fresh
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        transactionId: index + 101,
        status: 'unsigned',
        updated_at: old
      }))
    ]
    const provider = {
      findTransactions: jest.fn(async ({ paged }: { paged: { limit: number; offset: number } }) =>
        rows
          .filter(row => row.status === 'unprocessed' || row.status === 'unsigned')
          .slice(paged.offset, paged.offset + paged.limit)
      ),
      updateTransactionStatus: jest.fn(async (status: string, transactionId: number) => {
        const row = rows.find(candidate => candidate.transactionId === transactionId)
        if (row != null) row.status = status
      })
    }
    const monitor = {
      storage: {
        runAsStorageProvider: async (callback: (sp: typeof provider) => Promise<unknown>) => await callback(provider)
      },
      options: { abandonedMsecs: 60 * 60 * 1000 }
    }

    await new TaskFailAbandoned(monitor as never).runTask()

    expect(rows.filter(row => row.updated_at === old && row.status !== 'failed')).toHaveLength(0)
    expect(provider.updateTransactionStatus).toHaveBeenCalledTimes(51)
    expect(provider.findTransactions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ paged: { limit: 100, offset: 99 } })
    )
  })
})
