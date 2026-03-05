import { Beef } from '@bsv/sdk'
import { WalletStorageManager } from '../WalletStorageManager'

describe('verifyAndRepairBeef', () => {
  test('returns early when beef is structurally invalid', async () => {
    const sm = new WalletStorageManager('identity-key')
    const chaintracker = {
      isValidRootForHeight: jest.fn()
    }
    sm.setServices({
      getChainTracker: jest.fn(async () => chaintracker)
    } as any)

    const beef = {
      txs: [],
      bumps: [],
      verifyValid: jest.fn(() => ({ valid: false, roots: {} }))
    } as unknown as Beef

    const reproveSpy = jest.spyOn(sm, 'reproveHeader')
    const r = await sm.verifyAndRepairBeef(beef)

    expect(r.isStructurallyValid).toBe(false)
    expect(r.invalidRoots).toEqual({})
    expect(r.verifiedBeef).toBeUndefined()
    expect(chaintracker.isValidRootForHeight).not.toHaveBeenCalled()
    expect(reproveSpy).not.toHaveBeenCalled()
  })

  test('returns original beef when all roots are valid', async () => {
    const sm = new WalletStorageManager('identity-key')
    const chaintracker = {
      isValidRootForHeight: jest.fn(async () => true)
    }
    sm.setServices({
      getChainTracker: jest.fn(async () => chaintracker)
    } as any)

    const beef = {
      txs: [],
      bumps: [],
      verifyValid: jest.fn(() => ({ valid: true, roots: { 123: 'good-root' } }))
    } as unknown as Beef

    const r = await sm.verifyAndRepairBeef(beef)

    expect(r.isStructurallyValid).toBe(true)
    expect(r.invalidRoots).toEqual({})
    expect(r.verifiedBeef).toBe(beef)
    expect(chaintracker.isValidRootForHeight).toHaveBeenCalledWith('good-root', 123)
  })

  test('attempts repair when a root is invalid and returns repaired beef when verification succeeds', async () => {
    const sm = new WalletStorageManager('identity-key')
    let calls = 0
    const chaintracker = {
      isValidRootForHeight: jest.fn(async () => {
        calls++
        return calls !== 1
      })
    }
    const getBeefForTxid = jest.fn(async () => ({
      findTxid: jest.fn(() => undefined)
    }))
    sm.setServices({
      getChainTracker: jest.fn(async () => chaintracker),
      getBeefForTxid
    } as any)

    const reproveSpy = jest.spyOn(sm, 'reproveHeader').mockResolvedValue({
      log: '',
      updated: [],
      unchanged: [],
      unavailable: []
    })

    const txid = 'a'.repeat(64)
    const beef = {
      txs: [{ txid, isTxidOnly: true, bumpIndex: 0 }],
      bumps: [{ blockHeight: 123 }],
      verifyValid: jest.fn(() => ({ valid: true, roots: { 123: 'bad-root' } }))
    } as unknown as Beef

    const r = await sm.verifyAndRepairBeef(beef, true)

    expect(r.isStructurallyValid).toBe(true)
    expect(r.invalidRoots[123]).toBeDefined()
    expect(reproveSpy).toHaveBeenCalledWith('bad-root')
    expect(getBeefForTxid).toHaveBeenCalledWith(txid)
    expect(r.verifiedBeef).toBeDefined()
    expect(r.verifiedBeef!.txs[0].txid).toBe(txid)
  })
})
