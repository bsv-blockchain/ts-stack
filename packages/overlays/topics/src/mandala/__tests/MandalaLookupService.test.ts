import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { MandalaLookupService } from '../MandalaLookupService.js'
import { MandalaStorageManager } from '../MandalaStorageManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload } from '../types.js'
import { MandalaToken } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Transaction, Hash, Utils, LockingScript, WalletProtocol } from '@bsv/sdk'

const protocolID: WalletProtocol = [2, 'mandala token']
const keyID = 'tkn'

describe('MandalaLookupService', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('mandala_ls_test')
  })
  afterAll(async () => { await client.close(); await mongo.stop() })
  beforeEach(async () => { await db.dropDatabase() })

  it('persists an admitted token and answers assetId/outpoint queries; rejects other queries', async () => {
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const receiver = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
    const assetId = `${'a'.repeat(64)}.0`
    const lockingScript = new MandalaToken().lock(assetId, 100, pkh)
    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({ inputs: [], outputs: [{ index: 0, linkage: linkage as any }] })

    const storage = new MandalaStorageManager(db)
    const ls = new MandalaLookupService({ storage, verifierWallet: overlay as any })

    await ls.outputAdmittedByTopic({
      mode: 'locking-script', topic: 'tm_mandala',
      txid: 'aa', outputIndex: 0, satoshis: 1, lockingScript, offChainValues
    } as any)

    expect(await ls.lookup({ service: 'ls_mandala', query: { assetId } } as any))
      .toEqual([{ txid: 'aa', outputIndex: 0 }])
    expect(await ls.lookup({ service: 'ls_mandala', query: { txid: 'aa', outputIndex: 0 } } as any))
      .toEqual([{ txid: 'aa', outputIndex: 0 }])
    await expect(ls.lookup({ service: 'ls_mandala', query: { identityKey: receiverKey } } as any))
      .rejects.toThrow('Unsupported query')
    expect(await storage.getBalance(receiverKey)).toBe(100)
  })
})
