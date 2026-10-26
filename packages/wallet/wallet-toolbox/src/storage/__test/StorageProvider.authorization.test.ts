import { StorageProvider } from '../StorageProvider'
import { StorageIdb } from '../StorageIdb'
import { StorageKnex } from '../StorageKnex'

describe('StorageProvider authorization boundaries', () => {
  test('scopes certificate relinquishment to the authenticated user', async () => {
    const findCertificates = jest.fn().mockResolvedValue([{ certificateId: 42 }])
    const updateCertificate = jest.fn().mockResolvedValue(1)
    const provider = { findCertificates, updateCertificate }
    const auth = { userId: 7, identityKey: `02${'1'.repeat(64)}` }
    const args = {
      type: Buffer.alloc(32, 1).toString('base64'),
      serialNumber: Buffer.alloc(32, 2).toString('base64'),
      certifier: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    }

    await expect(StorageProvider.prototype.relinquishCertificate.call(provider, auth, args)).resolves.toBe(1)

    expect(findCertificates).toHaveBeenCalledWith({
      partial: {
        userId: 7,
        type: args.type,
        serialNumber: args.serialNumber,
        certifier: args.certifier
      }
    })
    expect(updateCertificate).toHaveBeenCalledWith(42, { isDeleted: true })
  })

  test('limits proof-request reads to transactions tracked by the authenticated user', async () => {
    const ownedTxid = '1'.repeat(64)
    const unownedTxid = '2'.repeat(64)
    const countTransactions = jest.fn(async ({ partial }: { partial: { txid: string } }) =>
      partial.txid === ownedTxid ? 1 : 0
    )
    const findProvenTxReqs = jest.fn().mockResolvedValue([{ txid: ownedTxid }])
    const provider = { countTransactions, findProvenTxReqs }

    await expect(
      StorageProvider.prototype.findProvenTxReqsAuth.call(
        provider,
        { userId: 7, identityKey: `02${'1'.repeat(64)}` },
        { partial: {}, txids: [ownedTxid, unownedTxid], paged: { limit: 5, offset: 0 } }
      )
    ).resolves.toEqual([{ txid: ownedTxid }])

    expect(countTransactions).toHaveBeenCalledTimes(2)
    expect(findProvenTxReqs).toHaveBeenCalledWith({
      partial: {},
      txids: [ownedTxid],
      paged: { limit: 5, offset: 0 }
    })
  })

  test('bounds the compatibility ownership scan for custom providers without exact txids', async () => {
    const getProvenTxReqsForUser = jest.fn().mockResolvedValue(
      Array.from({ length: 10_001 }, (_, index) => ({ txid: index.toString(16).padStart(64, '0') }))
    )
    const findProvenTxReqs = jest.fn()

    await expect(
      StorageProvider.prototype.findProvenTxReqsAuth.call(
        { getProvenTxReqsForUser, findProvenTxReqs },
        { userId: 7, identityKey: `02${'1'.repeat(64)}` },
        { partial: {}, paged: { limit: 5, offset: 0 } }
      )
    ).rejects.toThrow('provider-native scoped query or exact txids')

    expect(getProvenTxReqsForUser).toHaveBeenCalledWith({
      userId: 7,
      paged: { limit: 10_001, offset: 0 },
      trx: undefined
    })
    expect(findProvenTxReqs).not.toHaveBeenCalled()
  })

  test('pushes authenticated ownership into the IndexedDB cursor before pagination', async () => {
    const row = { txid: '1'.repeat(64) }
    const filterProvenTxReqs = jest.fn(async (_args, accept, userId) => {
      expect(userId).toBe(7)
      accept(row)
    })
    const storage = {
      filterProvenTxReqs,
      validateEntity: jest.fn(value => value)
    }

    await expect(StorageIdb.prototype.findProvenTxReqsAuth.call(
      storage,
      { userId: 7, identityKey: `02${'1'.repeat(64)}` },
      { partial: {}, paged: { limit: 1, offset: 5 } }
    )).resolves.toEqual([row])
    expect(filterProvenTxReqs).toHaveBeenCalledWith(
      { partial: {}, paged: { limit: 1, offset: 5 } },
      expect.any(Function),
      7
    )
  })

  test('pushes authenticated ownership into the Knex query before pagination', async () => {
    const row = { txid: '1'.repeat(64) }
    const subquery = {
      from: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis()
    }
    const knex = { select: jest.fn(() => subquery) }
    const whereExists = jest.fn().mockResolvedValue([row])
    const storage = {
      toDb: jest.fn(() => knex),
      findProvenTxReqsQuery: jest.fn(() => ({ whereExists })),
      validateEntities: jest.fn(value => value)
    }

    await expect(StorageKnex.prototype.findProvenTxReqsAuth.call(
      storage,
      { userId: 7, identityKey: `02${'1'.repeat(64)}` },
      { partial: {}, paged: { limit: 1, offset: 5 } }
    )).resolves.toEqual([row])
    expect(subquery.where).toHaveBeenCalledWith('transactions.userId', 7)
    expect(whereExists).toHaveBeenCalledWith(subquery)
  })

  test('rejects proof completion for a transaction not tracked by the authenticated user', async () => {
    const txid = '3'.repeat(64)
    const now = new Date()
    const findProvenTxReqs = jest.fn().mockResolvedValue([
      {
        created_at: now,
        updated_at: now,
        provenTxReqId: 9,
        status: 'unconfirmed',
        attempts: 1,
        notified: false,
        txid,
        history: '{}',
        notify: '{}',
        rawTx: [1]
      }
    ])
    const countTransactions = jest.fn().mockResolvedValue(0)
    const updateProvenTxReqWithNewProvenTx = jest.fn()
    const provider = { findProvenTxReqs, countTransactions, updateProvenTxReqWithNewProvenTx }
    const args = {
      provenTxReqId: 9,
      txid,
      attempts: 1,
      status: 'completed' as const,
      history: '{}',
      height: 1,
      index: 0,
      blockHash: '4'.repeat(64),
      merkleRoot: '5'.repeat(64),
      merklePath: [1]
    }

    await expect(
      StorageProvider.prototype.updateProvenTxReqWithNewProvenTxAuth.call(
        provider,
        { userId: 7, identityKey: `02${'1'.repeat(64)}` },
        args
      )
    ).rejects.toThrow(/does not belong to the authenticated wallet/)
    expect(countTransactions).toHaveBeenCalledWith({ partial: { userId: 7, txid } })
    expect(updateProvenTxReqWithNewProvenTx).not.toHaveBeenCalled()
  })

  test('validates an owned proof before completing shared proof state', async () => {
    const txid = '3'.repeat(64)
    const now = new Date()
    const findProvenTxReqs = jest.fn().mockResolvedValue([
      {
        created_at: now,
        updated_at: now,
        provenTxReqId: 9,
        status: 'unconfirmed',
        attempts: 1,
        notified: false,
        txid,
        history: '{}',
        notify: '{}',
        rawTx: [1]
      }
    ])
    const updateProvenTxReqWithNewProvenTx = jest.fn()
    const provider = {
      findProvenTxReqs,
      countTransactions: jest.fn().mockResolvedValue(1),
      getServices: jest.fn(),
      updateProvenTxReqWithNewProvenTx
    }

    await expect(
      StorageProvider.prototype.updateProvenTxReqWithNewProvenTxAuth.call(
        provider,
        { userId: 7, identityKey: `02${'1'.repeat(64)}` },
        {
          provenTxReqId: 9,
          txid,
          attempts: 1,
          status: 'completed',
          history: '{}',
          height: 1,
          index: 0,
          blockHash: '4'.repeat(64),
          merkleRoot: '5'.repeat(64),
          merklePath: [1]
        }
      )
    ).rejects.toThrow(/server-verified proof/)
    expect(updateProvenTxReqWithNewProvenTx).not.toHaveBeenCalled()
  })
})
