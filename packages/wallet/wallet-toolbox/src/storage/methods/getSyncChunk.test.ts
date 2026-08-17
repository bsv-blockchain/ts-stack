import { RequestSyncChunkArgs } from '../../sdk/WalletStorage.interfaces'
import { StorageReader } from '../StorageReader'
import { getSyncChunk } from './getSyncChunk'

const entityNames = [
  'provenTx',
  'outputBasket',
  'outputTag',
  'txLabel',
  'transaction',
  'output',
  'txLabelMap',
  'outputTagMap',
  'certificate',
  'certificateField',
  'commission',
  'provenTxReq'
]

function makeArgs(maxItems = 250, maxRoughSize = 2 * 1024 * 1024): RequestSyncChunkArgs {
  return {
    identityKey: '02'.repeat(33),
    maxItems,
    maxRoughSize,
    offsets: entityNames.map(name => ({ name, offset: 0 })),
    fromStorageIdentityKey: '11'.repeat(32),
    toStorageIdentityKey: '22'.repeat(32)
  }
}

function makeStorage(provenTxCount: number, payloadBytes = 0) {
  const now = new Date('2026-08-17T00:00:00.000Z')
  const provenTxs = Array.from({ length: provenTxCount }, (_, index) => ({
    provenTxId: index + 1,
    txid: index.toString(16).padStart(64, '0'),
    created_at: now,
    updated_at: now,
    rawTx: Array.from({ length: payloadBytes }, () => 1)
  }))
  const getProvenTxsForUser = jest.fn(async ({ paged }: { paged?: { limit: number; offset?: number } }) => {
    const offset = paged?.offset ?? 0
    return provenTxs.slice(offset, offset + (paged?.limit ?? provenTxs.length))
  })
  const empty = jest.fn(async () => [])
  const storage = {
    findUserByIdentityKey: jest.fn(async () => ({
      userId: 1,
      identityKey: '02'.repeat(33),
      created_at: now,
      updated_at: now
    })),
    getProvenTxsForUser,
    getSyncChunkTotals: jest.fn(async () => ({
      totalRecords: provenTxCount,
      records: {
        provenTxs: provenTxCount,
        outputBaskets: 0,
        outputTags: 0,
        txLabels: 0,
        transactions: 0,
        outputs: 0,
        txLabelMaps: 0,
        outputTagMaps: 0,
        certificates: 0,
        certificateFields: 0,
        commissions: 0,
        provenTxReqs: 0
      }
    })),
    findOutputBaskets: empty,
    findOutputTags: empty,
    findTxLabels: empty,
    findTransactions: empty,
    findOutputs: empty,
    getTxLabelMapsForUser: empty,
    getOutputTagMapsForUser: empty,
    findCertificates: empty,
    findCertificateFields: empty,
    findCommissions: empty,
    getProvenTxReqsForUser: empty
  } as unknown as StorageReader
  return { storage, getProvenTxsForUser, getSyncChunkTotals: storage.getSyncChunkTotals as jest.Mock }
}

describe('getSyncChunk query batching', () => {
  test('fills a 250-record proven transaction page in a bounded number of queries', async () => {
    const { storage, getProvenTxsForUser } = makeStorage(250)

    const chunk = await getSyncChunk(storage, makeArgs())

    expect(chunk.provenTxs).toHaveLength(250)
    expect(getProvenTxsForUser).toHaveBeenCalledTimes(3)
    expect(getProvenTxsForUser.mock.calls.map(call => call[0].paged?.limit)).toEqual([10, 80, 160])
  })

  test('uses observed record size to bound read-ahead for large records', async () => {
    const { storage, getProvenTxsForUser } = makeStorage(250, 20_000)

    const chunk = await getSyncChunk(storage, makeArgs(250, 750_000))

    expect(chunk.provenTxs!.length).toBeGreaterThan(10)
    expect(chunk.provenTxs!.length).toBeLessThan(20)
    expect(getProvenTxsForUser.mock.calls[1][0].paged?.limit).toBeLessThan(10)
  })

  test('includes efficient source totals only when requested', async () => {
    const { storage, getSyncChunkTotals } = makeStorage(250)
    const args = makeArgs()
    args.includeTotals = true

    const chunk = await getSyncChunk(storage, args)

    expect(chunk.totals).toMatchObject({ totalRecords: 250, records: { provenTxs: 250 } })
    expect(getSyncChunkTotals).toHaveBeenCalledTimes(1)
  })

  test('does not add count-query overhead for legacy requests', async () => {
    const { storage, getSyncChunkTotals } = makeStorage(25)

    const chunk = await getSyncChunk(storage, makeArgs())

    expect(chunk.totals).toBeUndefined()
    expect(getSyncChunkTotals).not.toHaveBeenCalled()
  })

  test('continues synchronization when optional totals cannot be counted', async () => {
    const { storage, getSyncChunkTotals } = makeStorage(25)
    getSyncChunkTotals.mockRejectedValueOnce(new Error('count unavailable'))
    const args = makeArgs()
    args.includeTotals = true

    const chunk = await getSyncChunk(storage, args)

    expect(chunk.provenTxs).toHaveLength(25)
    expect(chunk.totals).toBeUndefined()
  })
})
