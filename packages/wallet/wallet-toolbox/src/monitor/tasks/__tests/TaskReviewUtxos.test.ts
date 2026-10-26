import { TaskReviewUtxos } from '../TaskReviewUtxos'
import { specOpInvalidChange } from '../../../sdk'

const KEY_1 = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const KEY_2 = '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function makeUser(userId: number, identityKey = userId === 1 ? KEY_1 : KEY_2): any {
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

    const log = await task.reviewByIdentityKey(KEY_1)

    expect(m.findUsers).toHaveBeenCalledWith({ partial: { identityKey: KEY_1 } })
    expect(m.listOutputs).toHaveBeenCalledWith(
      { userId: 1, identityKey: KEY_1 },
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

    await task.reviewByIdentityKey(KEY_1, 'change')

    expect(m.listOutputs).toHaveBeenCalledWith(
      { userId: 1, identityKey: KEY_1 },
      expect.objectContaining({
        tags: []
      })
    )
  })

  test('2 reviewByIdentityKey requires an explicit release argument before changing state', async () => {
    const users = [makeUser(1)]
    const m = makeMonitor(users, { 1: [makeOutput('tx1.0', 50, false)] })
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.reviewByIdentityKey(KEY_1, 'all', true)

    expect(m.listOutputs).toHaveBeenCalledWith(
      { userId: 1, identityKey: KEY_1 },
      expect.objectContaining({ tags: ['release', 'all'] })
    )
    expect(log).toContain('confirmed spent and updated to unspendable')
  })

  test('3 reviewByIdentityKey returns no-findings summary when the user has no invalid utxos', async () => {
    const users = [makeUser(1)]
    const m = makeMonitor(users, {})
    const task = new TaskReviewUtxos(m.monitor as any)

    const log = await task.reviewByIdentityKey(KEY_1)

    expect(log).toBe(`userId 1: no invalid utxos found, ${KEY_1}\n`)
  })

  test('4 reviewByIdentityKey reports when the identity key does not exist', async () => {
    const m = makeMonitor([], {})
    const task = new TaskReviewUtxos(m.monitor as any)

    await expect(task.reviewByIdentityKey('missing-key')).rejects.toThrow('canonical compressed public key')
    expect(m.listOutputs).not.toHaveBeenCalled()
  })

  test('4a paged operator review reports unknowns and a continuation without timing out on the whole wallet', async () => {
    const user = makeUser(1, KEY_1)
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

    const result = await task.reviewPageByIdentityKey(KEY_1, 'all', false, 2, 0)

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

    const result = await task.reviewPageByIdentityKey(KEY_2)

    expect(result).toMatchObject({
      found: false,
      identityKey: KEY_2,
      mode: 'all',
      release: false,
      offset: 0,
      pageLimit: 20,
      sourceScanned: 0,
      complete: true,
      checked: 0,
      unknown: 0
    })
    expect(result.log).toBe(`identityKey ${KEY_2} was not found\n`)
  })

  test('4c paged change review safely returns an empty page when the default basket is absent', async () => {
    const user = makeUser(1, KEY_1)
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

    await expect(task.reviewPageByIdentityKey(KEY_1, 'change', true, 999.9, -5.2)).rejects.toThrow('pageLimit')

    expect(sp.findOutputBaskets).not.toHaveBeenCalled()
    expect(sp.findOutputs).not.toHaveBeenCalled()
  })

  test('4d rejects invalid control values and copies constructor tags', async () => {
    const m = makeMonitor([], {})
    const tags = ['all']
    const task = new TaskReviewUtxos(m.monitor as any, 0, 10, 0, tags)
    tags[0] = 'release'

    expect(task.tags).toEqual(['all'])
    await expect(task.reviewPageByIdentityKey(KEY_1, 'all', false, Number.NaN, 0)).rejects.toThrow('pageLimit')
    await expect(task.reviewPageByIdentityKey(KEY_1, 'invalid' as never, false)).rejects.toThrow('mode')
    await expect(task.reviewPageByIdentityKey(KEY_1, 'all', 'yes' as never)).rejects.toThrow('release')
    expect(() => new TaskReviewUtxos(m.monitor as any, -1)).toThrow('triggerMsecs')
  })

  test('5 trigger and runTask are stubbed out', async () => {
    const m = makeMonitor([], {})
    const task = new TaskReviewUtxos(m.monitor as any)

    expect(task.trigger(Date.now())).toEqual({ run: false })
    await expect(task.runTask()).resolves.toBe('TaskReviewUtxos is disabled; use reviewByIdentityKey instead.\n')
  })
})
