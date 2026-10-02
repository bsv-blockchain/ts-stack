import { jest } from '@jest/globals'
import { LockingScript, Transaction, Utils } from '@bsv/sdk'
import type { Db } from 'mongodb'
import { KVStoreLookupService } from '../kvstore/KVStoreLookupService.js'
import {
  createMandalaLookupService,
  MandalaLookupService
} from '../mandala/MandalaLookupService.js'
import { encodeAdminDetails } from '../mandala/details.js'

const txid = 'ab'.repeat(32)
const tokenId = `${'cd'.repeat(32)}_0`

const freezeRow = {
  tokenId,
  txid: 'ef'.repeat(32),
  outputIndex: 1,
  kind: 'freezeOutput',
  detailsHex: Utils.toHex(encodeAdminDetails({ kind: 'freezeOutput', outpoint: `${txid}.2` })),
  height: 10,
  offset: 3,
  admitSeq: 4
}

function mandalaStorage(methods: Record<string, jest.Mock> = {}): Record<string, jest.Mock> {
  return {
    findAdminHistory: jest.fn(async () => []),
    findMetadata: jest.fn(async () => null),
    getTokenRow: jest.fn(async () => null),
    getAuthorityRow: jest.fn(async () => null),
    putAssetState: jest.fn(),
    takeToken: jest.fn(async () => null),
    takeAuthority: jest.fn(async () => null),
    adjustBalance: jest.fn(),
    deleteMetadata: jest.fn(),
    ...methods
  }
}

const serviceOn = (storage: Record<string, jest.Mock>): MandalaLookupService =>
  new MandalaLookupService({ storage: storage as never, verifierWallet: {} as never })

describe('stateful lookup coverage', () => {
  it('rebuilds frozen Mandala state from authoritative token ownership', async () => {
    const storage = mandalaStorage({
      findAdminHistory: jest.fn(async () => [freezeRow]),
      getTokenRow: jest.fn(async () => ({ tokenId, amount: 7, identityKey: 'OwnerKey' }))
    })

    await serviceOn(storage).rebuildState(tokenId)

    expect(storage.getTokenRow).toHaveBeenCalledWith(txid, 2)
    expect(storage.putAssetState).toHaveBeenCalledTimes(1)
    expect(storage.putAssetState.mock.calls[0][0]).toMatchObject({
      tokenId,
      frozenOutpoints: [{ outpoint: `${txid}.2`, amount: 7, owner: 'ownerkey' }],
      lastProcessedHeight: 10,
      lastProcessedOffset: 3,
      lastAdmitSeq: 4
    })
  })

  it('uses empty freeze metadata when the referenced Mandala token is absent', async () => {
    const storage = mandalaStorage({ findAdminHistory: jest.fn(async () => [freezeRow]) })

    await serviceOn(storage).rebuildState(tokenId)

    expect(storage.putAssetState.mock.calls[0][0]).toMatchObject({
      frozenOutpoints: [{ outpoint: `${txid}.2`, amount: 0, owner: '' }]
    })
  })

  it('debits an evicted Mandala token exactly once and removes metadata only for vout 0', async () => {
    const storage = mandalaStorage({
      takeToken: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce({ identityKey: 'owner', amount: 7 })
        .mockResolvedValue(null)
    })
    const service = serviceOn(storage)

    await service.outputEvicted(txid, 0)
    await service.outputEvicted(txid, 1)
    await service.outputEvicted(txid, 2)

    expect(storage.adjustBalance).toHaveBeenCalledTimes(1)
    expect(storage.adjustBalance).toHaveBeenCalledWith('owner', -7)
    expect(storage.takeAuthority.mock.calls).toEqual([
      [txid, 1],
      [txid, 2]
    ])
    expect(storage.deleteMetadata.mock.calls).toEqual([[`${txid}_0`]])
  })

  it('routes a canonical Mandala outpoint and exercises both factory storage paths', async () => {
    const row = { txid, outputIndex: 2, tokenId, amount: 1, identityKey: 'k' }
    const storage = mandalaStorage({ getTokenRow: jest.fn(async () => row) })

    await expect(
      serviceOn(storage).lookup({
        service: 'ls_mandala',
        query: { txid: txid.toUpperCase(), outputIndex: 2 }
      })
    ).resolves.toEqual([row])
    expect(storage.getTokenRow).toHaveBeenCalledWith(txid, 2)
    expect(storage.getAuthorityRow).not.toHaveBeenCalled()

    const db = { collection: jest.fn(() => ({})) } as unknown as Db
    expect(createMandalaLookupService({} as never, storage as never)(db)).toBeInstanceOf(
      MandalaLookupService
    )
    expect(createMandalaLookupService({} as never)(db)).toBeInstanceOf(MandalaLookupService)
  })

  it('rejects an invalid KVStore tag mode before storage access', async () => {
    const findWithFilters = jest.fn()
    const service = new KVStoreLookupService({ findWithFilters } as never)

    await expect(
      service.lookup({ service: 'ls_kvstore', query: { key: 'name', tagQueryMode: 'none' } })
    ).rejects.toThrow('tagQueryMode must be all or any')
    expect(findWithFilters).not.toHaveBeenCalled()
  })

  it('exposes a fail-closed KVStore history selector only when requested', async () => {
    const findWithFilters = jest.fn(async () => [
      {
        txid,
        outputIndex: 0,
        key: 'name',
        protocolID: JSON.stringify([1, 'kvstore protocol'])
      }
    ])
    const service = new KVStoreLookupService({ findWithFilters } as never)

    const [result] = (await service.lookup({
      service: 'ls_kvstore',
      query: { key: 'name', history: true }
    })) as Array<{
      history?: (beef: number[], outputIndex: number, depth: number) => Promise<boolean>
    }>
    expect(result.history).toEqual(expect.any(Function))
    await expect(result.history?.([0, 1], 0, 0)).resolves.toBe(false)

    const transaction = new Transaction()
    transaction.addOutput({ satoshis: 1, lockingScript: new LockingScript([]) })
    await expect(result.history?.(transaction.toBEEF(), 1, 0)).resolves.toBe(false)
    await expect(result.history?.(transaction.toBEEF(), 0, 0)).resolves.toBe(false)
  })
})
