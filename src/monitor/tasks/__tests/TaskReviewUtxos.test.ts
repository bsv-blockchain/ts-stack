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
  test('0 reviewByIdentityKey reviews all invalid utxos for the matching user', async () => {
    const users = [makeUser(1), makeUser(2)]
    const m = makeMonitor(
      users,
      {
        1: [makeOutput('tx1.0', 50, false)],
        2: []
      }
    )
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.reviewByIdentityKey('key-1')

    expect(m.findUsers).toHaveBeenCalledWith({ partial: { identityKey: 'key-1' } })
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
    expect(m.logEvent).not.toHaveBeenCalled()
    expect(log).toContain('userId 1: 1 spendable utxos updated to unspendable')
    expect(log).toContain('tx1.0 50 now spent')
  })

  test('1 reviewByIdentityKey limits review to invalid change utxos when mode is change', async () => {
    const users = [makeUser(1)]
    const m = makeMonitor(users, { 1: [makeOutput('tx1.0', 50, false)] })
    const task = new TaskReviewUtxos(m.monitor as any)

    await task.reviewByIdentityKey('key-1', 'change')

    expect(m.listOutputs).toHaveBeenCalledWith(
      { userId: 1, identityKey: 'key-1' },
      expect.objectContaining({
        tags: ['release']
      })
    )
  })

  test('2 reviewByIdentityKey returns no-findings summary when the user has no invalid utxos', async () => {
    const users = [makeUser(1)]
    const m = makeMonitor(users, {})
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.reviewByIdentityKey('key-1')

    expect(log).toBe('userId 1: no invalid utxos found, key-1\n')
  })

  test('3 reviewByIdentityKey reports when the identity key does not exist', async () => {
    const m = makeMonitor([], {})
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.reviewByIdentityKey('missing-key')

    expect(m.listOutputs).not.toHaveBeenCalled()
    expect(log).toBe('identityKey missing-key was not found\n')
  })

  test('4 trigger and runTask are stubbed out', async () => {
    const m = makeMonitor([], {})
    const task = new TaskReviewUtxos(m.monitor as any)

    expect(task.trigger(Date.now())).toEqual({ run: false })
    await expect(task.runTask()).resolves.toBe('TaskReviewUtxos is disabled; use reviewByIdentityKey instead.\n')
  })
})
