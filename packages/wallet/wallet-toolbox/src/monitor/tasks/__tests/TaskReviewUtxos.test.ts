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
  test('0 reviewByIdentityKey scans all invalid utxos without releasing by default', async () => {
    const users = [makeUser(1), makeUser(2)]
    const m = makeMonitor(users, {
      1: [makeOutput('tx1.0', 50, false)],
      2: []
    })
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.reviewByIdentityKey('key-1')

    expect(m.findUsers).toHaveBeenCalledWith({ partial: { identityKey: 'key-1' } })
    expect(m.listOutputs).toHaveBeenCalledWith(
      { userId: 1, identityKey: 'key-1' },
      expect.objectContaining({
        basket: specOpInvalidChange,
        tags: ['all'],
        tagQueryMode: 'all',
        limit: 0,
        offset: 0
      })
    )
    expect(m.logEvent).not.toHaveBeenCalled()
    expect(log).toContain('userId 1: 1 spendable utxos confirmed spent')
    expect(log).toContain('tx1.0 50 now spent')
  })

  test('1 reviewByIdentityKey limits a read-only review to invalid change utxos', async () => {
    const users = [makeUser(1)]
    const m = makeMonitor(users, { 1: [makeOutput('tx1.0', 50, false)] })
    const task = new TaskReviewUtxos(m.monitor as any)

    await task.reviewByIdentityKey('key-1', 'change')

    expect(m.listOutputs).toHaveBeenCalledWith(
      { userId: 1, identityKey: 'key-1' },
      expect.objectContaining({
        tags: []
      })
    )
  })

  test('2 reviewByIdentityKey requires an explicit release argument before changing state', async () => {
    const users = [makeUser(1)]
    const m = makeMonitor(users, { 1: [makeOutput('tx1.0', 50, false)] })
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.reviewByIdentityKey('key-1', 'all', true)

    expect(m.listOutputs).toHaveBeenCalledWith(
      { userId: 1, identityKey: 'key-1' },
      expect.objectContaining({ tags: ['release', 'all'] })
    )
    expect(log).toContain('confirmed spent and updated to unspendable')
  })

  test('3 reviewByIdentityKey returns no-findings summary when the user has no invalid utxos', async () => {
    const users = [makeUser(1)]
    const m = makeMonitor(users, {})
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.reviewByIdentityKey('key-1')

    expect(log).toBe('userId 1: no invalid utxos found, key-1\n')
  })

  test('4 reviewByIdentityKey reports when the identity key does not exist', async () => {
    const m = makeMonitor([], {})
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.reviewByIdentityKey('missing-key')

    expect(m.listOutputs).not.toHaveBeenCalled()
    expect(log).toBe('identityKey missing-key was not found\n')
  })

  test('4a paged operator review reports unknowns and a continuation without timing out on the whole wallet', async () => {
    const user = makeUser(1, 'key-1')
    const outputs = [
      {
        outputId: 1,
        userId: 1,
        basketId: 2,
        transactionId: 1,
        txid: '11'.repeat(32),
        vout: 0,
        satoshis: 50,
        spendable: true,
        lockingScript: [0]
      },
      {
        outputId: 2,
        userId: 1,
        basketId: 2,
        transactionId: 2,
        txid: '22'.repeat(32),
        vout: 0,
        satoshis: 60,
        spendable: true,
        lockingScript: [0]
      }
    ]
    const sp = {
      findUsers: jest.fn().mockResolvedValue([user]),
      findOutputBaskets: jest.fn().mockResolvedValue([{ basketId: 2 }]),
      findOutputs: jest.fn().mockResolvedValue(outputs),
      getServices: () => ({
        hashOutputScript: () => 'aa'.repeat(32),
        getUtxoStatus: async (_hash: string, _format: undefined, outpoint: string) =>
          outpoint.startsWith('11')
            ? { name: 'mock', status: 'success', details: [], isUtxo: false }
            : { name: 'mock', status: 'error', details: [] }
      }),
      validateOutputScript: jest.fn().mockResolvedValue(undefined)
    }
    const monitor = {
      storage: {
        runAsStorageProvider: jest.fn(async (scope: (provider: any) => Promise<any>) => await scope(sp))
      }
    }
    const task = new TaskReviewUtxos(monitor as any)

    const result = await task.reviewPageByIdentityKey('key-1', 'all', false, 2, 0)

    expect(sp.findOutputs).toHaveBeenCalledWith(expect.objectContaining({ paged: { limit: 2, offset: 0 } }))
    expect(result).toMatchObject({
      checked: 2,
      confirmedSpent: 1,
      unknown: 1,
      released: 0,
      complete: false,
      nextOffset: 2
    })
    expect(result.log).toContain('1 unknown')
    expect(result.log).toContain('continue at offset 2')
  })

  test('4b paged review returns structured diagnostics when the identity is unknown', async () => {
    const sp = { findUsers: jest.fn().mockResolvedValue([]) }
    const monitor = {
      storage: {
        runAsStorageProvider: jest.fn(async (scope: (provider: any) => Promise<any>) => await scope(sp))
      }
    }
    const task = new TaskReviewUtxos(monitor as any)

    const result = await task.reviewPageByIdentityKey('missing-key')

    expect(result).toMatchObject({
      found: false,
      identityKey: 'missing-key',
      mode: 'all',
      release: false,
      offset: 0,
      pageLimit: 20,
      sourceScanned: 0,
      complete: true,
      checked: 0,
      unknown: 0
    })
    expect(result.log).toBe('identityKey missing-key was not found\n')
  })

  test('4c paged change review safely returns an empty page when the default basket is absent', async () => {
    const user = makeUser(1, 'key-1')
    const sp = {
      findUsers: jest.fn().mockResolvedValue([user]),
      findOutputBaskets: jest.fn().mockResolvedValue([]),
      findOutputs: jest.fn()
    }
    const monitor = {
      storage: {
        runAsStorageProvider: jest.fn(async (scope: (provider: any) => Promise<any>) => await scope(sp))
      }
    }
    const task = new TaskReviewUtxos(monitor as any)

    const result = await task.reviewPageByIdentityKey('key-1', 'change', true, 999.9, -5.2)

    expect(sp.findOutputBaskets).toHaveBeenCalledWith({ partial: { userId: 1, name: 'default' } })
    expect(sp.findOutputs).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      found: true,
      userId: 1,
      mode: 'change',
      release: true,
      offset: 0,
      pageLimit: 250,
      sourceScanned: 0,
      complete: true,
      released: 0
    })
    expect(result.log).toBe('userId 1: no invalid utxos found, key-1\n')
  })

  test('5 trigger and runTask are stubbed out', async () => {
    const m = makeMonitor([], {})
    const task = new TaskReviewUtxos(m.monitor as any)

    expect(task.trigger(Date.now())).toEqual({ run: false })
    await expect(task.runTask()).resolves.toBe('TaskReviewUtxos is disabled; use reviewByIdentityKey instead.\n')
  })
})
