import { once } from 'node:events'
import { MerklePath, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { StorageServer } from '../remoting/StorageServer'
import { StorageClient } from '../remoting/StorageClient'
import { Services, toBinaryBaseBlockHeader } from '../../services/Services'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { ServiceCollection } from '../../services/ServiceCollection'
import type { GetMerklePathResult } from '../../sdk/WalletServices.interfaces'
import type { TableProvenTx } from '../schema/tables/TableProvenTx'
import type { RequestSyncChunkArgs } from '../../sdk/WalletStorage.interfaces'

// Synthetic headers and transactions are never broadcast. Delayed chain services
// exercise the authenticated write boundary without an external provider dependency.
test.each([false, true])('commits authenticated proof pages and reconciles stale metadata (existing row: %s)', async existing => {
  const remote = await _tu.createSQLiteTestWallet({ databaseName: 'proofPageHttp', dropAll: true })
  const services = remote.activeStorage.getServices()
  const headers = new Map<number, number[]>()
  const proofs: TableProvenTx[] = Array.from({ length: 250 }, (_, index) => {
    const transaction = new Transaction()
    transaction.lockTime = index
    transaction.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
    const txid = transaction.id('hex')
    const height = index + 1
    const path = new MerklePath(height, [[{ offset: 0, hash: txid, txid: true }]])
    const header = toBinaryBaseBlockHeader({ version: 1, previousHash: '0'.repeat(64),
      merkleRoot: txid, time: height, bits: 0, nonce: 0 })
    headers.set(height, header)
    return { provenTxId: height, created_at: new Date(0), updated_at: new Date(0), txid, height,
      index: 0, merklePath: path.toBinary(), rawTx: transaction.toBinary(),
      blockHash: asString(doubleSha256BE(header)), merkleRoot: txid }
  })
  let active = 0
  let maximum = 0
  const rootCheck = jest.fn(async (root: string, height: number) => {
    active++
    maximum = Math.max(maximum, active)
    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      const header = headers.get(height)
      return header != null && asString(header.slice(36, 68).reverse()) === root
    } finally { active-- }
  })
  const tracker = jest.spyOn(services, 'getChainTracker').mockResolvedValue({
    isValidRootForHeight: rootCheck, currentHeight: async () => 250
  })
  const headerCheck = jest.spyOn(services, 'getHeaderForHeight').mockImplementation(async height => {
    await new Promise(resolve => setTimeout(resolve, 10))
    return headers.get(height)!
  })
  const proofLookup = jest.fn<Promise<GetMerklePathResult>, []>()
  const staleProofLookup = jest.fn<Promise<GetMerklePathResult>, []>()
  const originalProofServices = (services as Services).getMerklePathServices
  ;(services as Services).getMerklePathServices = new ServiceCollection('getMerklePath', [
    { name: 'stale', service: staleProofLookup }, { name: 'active', service: proofLookup }
  ])
  const server = new StorageServer(remote.activeStorage, { port: 0, wallet: remote.wallet,
    monetize: false, logRpcRequests: false, calculateRequestPrice: async () => 0 })
  let client: StorageClient | undefined
  try {
    server.start()
    if (!server.server.listening) await once(server.server, 'listening')
    const address = server.server.address()
    if (address == null || typeof address === 'string') throw new Error('fixture did not bind')
    client = new StorageClient(remote.wallet, `http://localhost:${address.port}`, { binaryRequests: true })
    const settings = await client.makeAvailable()
    const fromStorageIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
    const checkpoint = await client.getSyncCheckpoint({ identityKey: remote.identityKey }, fromStorageIdentityKey, 'synthetic source')
    const args: RequestSyncChunkArgs = { identityKey: remote.identityKey, fromStorageIdentityKey,
      toStorageIdentityKey: settings.storageIdentityKey, maxItems: 250, maxRoughSize: 2 * 1024 * 1024,
      offsets: checkpoint!.offsets, syncStateId: checkpoint!.syncStateId }
    const chunk = { userIdentityKey: remote.identityKey, fromStorageIdentityKey,
      toStorageIdentityKey: settings.storageIdentityKey, provenTxs: proofs }
    const result = await client.processSyncChunk(args, chunk)
    expect(result.inserts).toBe(250)
    expect(rootCheck).toHaveBeenCalledTimes(250)
    expect(headerCheck).toHaveBeenCalledTimes(250)
    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(8)
    const committed = await client.getSyncCheckpoint({ identityKey: remote.identityKey }, fromStorageIdentityKey, 'synthetic source')
    expect(committed!.offsets.find(row => row.name === 'provenTx')?.offset).toBe(250)
    const invalid = { ...proofs[0], provenTxId: 251, blockHash: '0'.repeat(64) }
    await expect(client.processSyncChunk({ ...args, offsets: committed!.offsets }, { ...chunk, provenTxs: [invalid] }))
      .rejects.toThrow('block metadata does not match')
    expect(await client.getSyncCheckpoint({ identityKey: remote.identityKey }, fromStorageIdentityKey, 'synthetic source')).toEqual(committed)
    expect(await remote.activeStorage.countProvenTxs({ partial: {} })).toBe(250)

    const transaction = new Transaction()
    transaction.lockTime = 1000
    transaction.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
    const txid = transaction.id('hex')
    const oldPath = new MerklePath(251, [[{ offset: 0, hash: txid, txid: true }]])
    const currentPath = new MerklePath(252, [[{ offset: 0, hash: txid, txid: true },
      { offset: 1, hash: 'ab'.repeat(32) }]])
    const currentRoot = currentPath.computeRoot(txid)
    const currentHeader = toBinaryBaseBlockHeader({ version: 1, previousHash: '0'.repeat(64),
      merkleRoot: currentRoot, time: 252, bits: 0, nonce: 0 })
    headers.set(252, currentHeader)
    staleProofLookup.mockResolvedValue({ merklePath: oldPath })
    proofLookup.mockResolvedValue({ merklePath: currentPath })
    const stale = { ...proofs[0], provenTxId: 251, txid, height: 251, merkleRoot: txid,
      merklePath: oldPath.toBinary(), rawTx: transaction.toBinary() }
    const existingId = existing
      ? await remote.activeStorage.insertProvenTx({ ...stale, provenTxId: 0, updated_at: new Date(1) })
      : undefined
    const repaired = await client.processSyncChunk({ ...args, offsets: committed!.offsets }, { ...chunk, provenTxs: [stale] })
    expect(repaired.inserts).toBe(existing ? 0 : 1)
    expect(repaired.updates).toBe(existing ? 1 : 0)
    expect(staleProofLookup).toHaveBeenCalledTimes(1)
    expect(proofLookup).toHaveBeenCalledTimes(1)
    const [saved] = await remote.activeStorage.findProvenTxs({ partial: { txid } })
    expect(saved).toMatchObject({ height: 252, merkleRoot: currentRoot, rawTx: stale.rawTx,
      merklePath: currentPath.toBinary(), blockHash: asString(doubleSha256BE(currentHeader)) })
    if (existing) expect(saved.provenTxId).toBe(existingId)
    expect(saved.updated_at.getTime()).toBeGreaterThan(stale.updated_at.getTime())
    const changed = await remote.activeStorage.findProvenTxs({ partial: {}, since: new Date(2) })
    expect(changed.map(proof => proof.txid)).toEqual([txid])
    expect(new Date(repaired.maxUpdated_at!).getTime()).toBe(stale.updated_at.getTime())
    const resumed = await client.getSyncCheckpoint({ identityKey: remote.identityKey }, fromStorageIdentityKey, 'synthetic source')
    expect(resumed!.offsets.find(row => row.name === 'provenTx')?.offset).toBe(251)
  } finally {
    if (client != null) await client.destroy()
    await server.close()
    ;(services as Services).getMerklePathServices = originalProofServices
    tracker.mockRestore()
    headerCheck.mockRestore()
    await remote.activeStorage.destroy()
  }
})
