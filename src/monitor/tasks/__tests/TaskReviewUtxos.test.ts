import { TaskReviewUtxos } from '../TaskReviewUtxos'
import { specOpInvalidChange } from '../../../sdk'

function makeUser(userId: number, identityKey = `key-${userId}`): any {
  const now = new Date()
  return {
    created_at: now,
    updated_at: now,
    userId,
    identityKey,
    activeStorage: 'storage-key'
  }
}

function makeOutput(outpoint: string, satoshis: number, spendable: boolean): any {
  return { outpoint, satoshis, spendable }
}

function makeMonitor(users: any[], outputsByUserId: Record<number, any[]>) {
  const findUsers = jest.fn().mockResolvedValue(users)
  const listOutputs = jest.fn(async (auth: any) => {
    const outputs = outputsByUserId[auth.userId] ?? []
    return {
      totalOutputs: outputs.length,
      outputs
    }
  })
  const runAsStorageProvider = jest.fn(async (fn: any) => await fn({ findUsers, listOutputs }))
  const logEvent = jest.fn().mockResolvedValue(undefined)

  return {
    monitor: {
      storage: { runAsStorageProvider },
      logEvent
    },
    findUsers,
    listOutputs,
    runAsStorageProvider,
    logEvent
  }
}

describe('TaskReviewUtxos', () => {
  test('0 reviews paged users and logs findings for invalid utxos', async () => {
    const users = [makeUser(1), makeUser(2)]
    const m = makeMonitor(
      users,
      {
        1: [makeOutput('tx1.0', 50, false)],
        2: []
      }
    )
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.runTask()

    expect(m.findUsers).toHaveBeenCalledWith({ partial: {}, paged: { limit: 10, offset: 0 } })
    expect(m.listOutputs).toHaveBeenCalledWith(
      { userId: 1, identityKey: 'key-1' },
      expect.objectContaining({
        basket: specOpInvalidChange,
        tags: ['release', 'all'],
        tagQueryMode: 'all',
        limit: 0,
        offset: 0
      })
    )
    expect(m.logEvent).toHaveBeenCalledTimes(1)
    expect(log).toContain('2 users reviewed')
    expect(log).toContain('userId 1: 1 spendable utxos updated to unspendable')
    expect(log).toContain('tx1.0 50 now spent')
  })

  test('1 returns no-findings summary when users have no invalid utxos', async () => {
    const users = [makeUser(1)]
    const m = makeMonitor(users, {})
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.runTask()

    expect(m.logEvent).toHaveBeenCalledTimes(1)
    expect(log).toBe('1 users reviewed, no invalid utxos found\n')
  })

  test('2 returns zero-users summary when the page is empty', async () => {
    const m = makeMonitor([], {})
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.runTask()

    expect(m.listOutputs).not.toHaveBeenCalled()
    expect(m.logEvent).toHaveBeenCalledTimes(1)
    expect(log).toBe('0 users reviewed\n')
  })
})
