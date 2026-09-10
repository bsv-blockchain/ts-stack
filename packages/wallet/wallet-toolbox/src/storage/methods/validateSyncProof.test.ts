import { MerklePath, Script, Transaction } from '@bsv/sdk'
import { validateSyncProof, assertSyncProofReplacementAuthorized } from './validateSyncProof'
import { validateSyncProofs } from '../remoting/validateRpcSyncProofs'
import { Services, toBinaryBaseBlockHeader } from '../../services/Services'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { ServiceCollection } from '../../services/ServiceCollection'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'

function fixture() {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
  const txid = tx.id('hex')
  const oldPath = new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]])
  const currentPath = new MerklePath(101, [[{ offset: 0, hash: txid, txid: true },
    { offset: 1, hash: 'ab'.repeat(32) }]])
  const header = (root: string) => toBinaryBaseBlockHeader({ version: 1,
    previousHash: '0'.repeat(64), merkleRoot: root, time: 1, bits: 0, nonce: 0 })
  const currentRoot = currentPath.computeRoot(txid)
  const currentHeader = header(currentRoot)
  const candidate = { provenTxId: 7, created_at: new Date(0), updated_at: new Date(1), txid,
    rawTx: tx.toBinary(), merklePath: oldPath.toBinary(), merkleRoot: txid,
    blockHash: asString(doubleSha256BE(header(txid))), height: 100, index: 0 }
  const getMerklePath = jest.fn(async () => ({ merklePath: currentPath }))
  const isValidRootForHeight = jest.fn(async (root: string, height: number) => root === currentRoot && height === 101)
  const getHeaderForHeight = jest.fn(async () => [...currentHeader])
  const services = { getMerklePath, getHeaderForHeight,
    getChainTracker: async () => ({ isValidRootForHeight }) } as unknown as WalletServices
  return { candidate, currentPath, currentRoot, currentHeader, getMerklePath,
    isValidRootForHeight, getHeaderForHeight, storage: { getServices: () => services } }
}

test('refreshes stale RPC proof metadata only after fully validating the current proof', async () => {
  const f = fixture()
  const original = { ...f.candidate }
  const page = [f.candidate]
  await validateSyncProofs(f.storage, page)
  expect(page[0]).toEqual({ ...original, height: 101, merklePath: f.currentPath.toBinary(),
    merkleRoot: f.currentRoot, blockHash: asString(doubleSha256BE(f.currentHeader)) })
  expect(page[0].rawTx).toBe(original.rawTx)
  expect(f.candidate).toEqual(original)
  expect(f.getMerklePath).toHaveBeenCalledWith(original.txid)
  expect(f.isValidRootForHeight.mock.calls).toEqual([[original.merkleRoot, 100], [f.currentRoot, 101]])
  expect(() => assertSyncProofReplacementAuthorized(page[0])).not.toThrow()
})

test.each(['missing proof', 'orphaned replacement', 'wrong header', 'lookup failure'])(
  'preserves the original record and rejects a stale proof after %s', async failure => {
    const f = fixture()
    const before = structuredClone(f.candidate)
    if (failure === 'missing proof') f.getMerklePath.mockResolvedValue({ merklePath: undefined! })
    if (failure === 'orphaned replacement') f.isValidRootForHeight.mockResolvedValue(false)
    if (failure === 'wrong header') f.getHeaderForHeight.mockResolvedValue(Array(80).fill(0))
    if (failure === 'lookup failure') f.getMerklePath.mockRejectedValue(new Error('synthetic outage'))
    await expect(validateSyncProofs(f.storage, [f.candidate])).rejects.toThrow('Ask the source provider to reconcile')
    expect(f.candidate).toEqual(before)
    expect(f.getMerklePath).toHaveBeenCalledTimes(1)
    expect(() => assertSyncProofReplacementAuthorized(f.candidate)).toThrow()
  }
)

test('does not refresh a forged transaction or change direct-call proof validation', async () => {
  const f = fixture()
  await expect(validateSyncProof(f.storage, f.candidate)).rejects.toThrow('Merkle root is not active')
  expect(f.getMerklePath).not.toHaveBeenCalled()
  f.candidate.rawTx = [1]
  await expect(validateSyncProofs(f.storage, [f.candidate])).rejects.toThrow('server-verified proof')
  expect(f.getMerklePath).not.toHaveBeenCalled()
})


test('retries an orphan proof on another provider independently for concurrent lookups', async () => {
  const f = fixture()
  const services = new Services('test')
  services.getChainTracker = f.storage.getServices().getChainTracker
  services.getHeaderForHeight = f.getHeaderForHeight
  const stale = jest.fn(async () => ({ merklePath: MerklePath.fromBinary(f.candidate.merklePath) }))
  const active = jest.fn(async () => ({ merklePath: f.currentPath }))
  services.getMerklePathServices = new ServiceCollection('getMerklePath', [
    { name: 'stale', service: stale }, { name: 'active', service: active }
  ])
  const page = Array.from({ length: 3 }, () => structuredClone(f.candidate))
  await validateSyncProofs({ getServices: () => services }, page)
  expect(stale).toHaveBeenCalledTimes(3)
  expect(active).toHaveBeenCalledTimes(3)
  for (const proof of page) {
    expect(proof.height).toBe(101)
    expect(() => assertSyncProofReplacementAuthorized(proof)).not.toThrow()
  }
})

test('exhausts providers once without accepting an invalid proof or partially changing the page', async () => {
  const f = fixture()
  const services = new Services('test')
  services.getChainTracker = f.storage.getServices().getChainTracker
  services.getHeaderForHeight = f.getHeaderForHeight
  const stale = jest.fn(async () => ({ merklePath: MerklePath.fromBinary(f.candidate.merklePath) }))
  const unavailable = jest.fn(async () => { throw new Error('synthetic outage') })
  services.getMerklePathServices = new ServiceCollection('getMerklePath', [
    { name: 'stale', service: stale }, { name: 'unavailable', service: unavailable }
  ])
  const page = [f.candidate]
  const before = structuredClone(page)
  await expect(validateSyncProofs({ getServices: () => services }, page)).rejects.toThrow('Ask the source provider')
  expect(stale).toHaveBeenCalledTimes(1)
  expect(unavailable).toHaveBeenCalledTimes(1)
  const history = services.getMerklePathServices.getServiceCallHistory(false).historyByProvider
  expect(history.stale.totalCounts.failure).toBe(1)
  expect(history.unavailable.totalCounts.failure).toBe(1)
  expect(page).toEqual(before)
  expect(() => assertSyncProofReplacementAuthorized(page[0])).toThrow()
})
