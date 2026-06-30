import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { MandalaLookupService } from '../MandalaLookupService.js'
import { MandalaStorageManager } from '../MandalaStorageManager.js'
import { encodeLinkagePayload } from '../types.js'
import { MandalaToken, MandalaAdmin } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Hash, Utils, WalletProtocol, Transaction, P2PKH, UnlockingScript } from '@bsv/sdk'

const protocolID: WalletProtocol = [2, 'mandala token']
const keyID = 'tkn'

// Build a real one-output Transaction carrying `lockingScript` at index 0.
// In whole-tx admission mode the lookup service decodes the output script from
// the atomic BEEF, so fixtures must be real transactions rather than bare scripts.
const txWithOutput = (lockingScript: { toHex: () => string } | any): Transaction => {
  const tx = new Transaction()
  // A funding input so the tx serialises to BEEF; its source is a throwaway tx.
  const source = new Transaction()
  source.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(Hash.hash160(Utils.toArray('00', 'hex'))) })
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: 1, lockingScript })
  return tx
}

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

    const tx = txWithOutput(lockingScript)
    const txid = tx.id('hex')

    const storage = new MandalaStorageManager(db)
    const ls = new MandalaLookupService({ storage, verifierWallet: overlay as any })

    await ls.outputAdmittedByTopic({
      mode: 'whole-tx', topic: 'tm_mandala',
      outputIndex: 0, atomicBEEF: tx.toAtomicBEEF(), offChainValues
    } as any)

    expect(await ls.lookup({ service: 'ls_mandala', query: { assetId } } as any))
      .toEqual([{ txid, outputIndex: 0 }])
    expect(await ls.lookup({ service: 'ls_mandala', query: { txid, outputIndex: 0 } } as any))
      .toEqual([{ txid, outputIndex: 0 }])
    await expect(ls.lookup({ service: 'ls_mandala', query: { identityKey: receiverKey } } as any))
      .rejects.toThrow('Unsupported query')
    expect(await storage.getBalance(receiverKey)).toBe(100)
  })

  it('folds a pause admin action into AssetAdminState on admit and serves it via lookup', async () => {
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const adminWallet = new ProtoWallet(PrivateKey.fromRandom())
    const verifierWallet = overlay
    const assetId = `${'b'.repeat(64)}.0`
    const adminLockingScript = await MandalaAdmin.lock({
      wallet: adminWallet as any,
      data: { kind: 'pause', assetId, priorOutpoint: 'p.0' }
    })
    const ADMIN_TX = txWithOutput(adminLockingScript)
    const ADMIN_TXID = ADMIN_TX.id('hex')

    const storage = new MandalaStorageManager(db)
    const svc = new MandalaLookupService({ storage, verifierWallet: verifierWallet as any })
    const payload = encodeLinkagePayload({ inputs: [], outputs: [], admin: [{ index: 0, actionDetails: { kind: 'pause', assetId, priorOutpoint: 'p.0' } }] })
    await svc.outputAdmittedByTopic({
      mode: 'whole-tx', topic: 'tm_mandala', txid: ADMIN_TXID, outputIndex: 0,
      atomicBEEF: ADMIN_TX.toAtomicBEEF(), offChainValues: payload
    } as any)
    const state = (await svc.lookup({ service: 'ls_mandala', query: { assetStateAssetId: assetId } } as any)) as any
    expect(state[0].isPaused).toBe(true)
    const hist = (await svc.lookup({ service: 'ls_mandala', query: { adminHistoryAssetId: assetId } } as any)) as any
    expect(hist).toHaveLength(1)
    expect(hist[0].actionDetails.kind).toBe('pause')
  })

  it('folds register issuer from actionDetails on admit and rebuildState yields the same issuer', async () => {
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const adminWallet = new ProtoWallet(PrivateKey.fromRandom())
    const issuer = '02issuer' + 'a'.repeat(58)
    // The issuer lives ONLY in the register actionDetails (the persisted source).
    // publicData carries metadata but deliberately NOT the issuer, so a path that
    // sources issuer from publicData would produce '' (the bug Fix 1 closes).
    const registerDetails = { kind: 'register', label: 'USD Coin', ticker: 'USDC', decimals: 2, issuer }
    const adminLockingScript = await MandalaAdmin.lock({
      wallet: adminWallet as any,
      data: registerDetails as any,
      publicData: { label: 'USD Coin', ticker: 'USDC', decimals: 2 }
    })
    const REG_TX = txWithOutput(adminLockingScript)
    const REG_TXID = REG_TX.id('hex')
    const assetId = `${REG_TXID}.0`

    const storage = new MandalaStorageManager(db)
    const svc = new MandalaLookupService({ storage, verifierWallet: overlay as any })
    const payload = encodeLinkagePayload({ inputs: [], outputs: [], admin: [{ index: 0, actionDetails: registerDetails as any }] })
    await svc.outputAdmittedByTopic({
      mode: 'whole-tx', topic: 'tm_mandala', txid: REG_TXID, outputIndex: 0,
      atomicBEEF: REG_TX.toAtomicBEEF(), offChainValues: payload
    } as any)

    // Live admit captured the issuer (sourced from persisted actionDetails).
    const liveState = await storage.findStateByAssetId(assetId)
    expect(liveState[0].issuerIdentityKey).toBe(issuer)

    // Rebuild from persisted history must yield the SAME issuer.
    const rebuilt = await svc.rebuildState(assetId)
    expect(rebuilt.issuerIdentityKey).toBe(issuer)
  })

  it('rebuildState folds history deterministically regardless of insert order', async () => {
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const storage = new MandalaStorageManager(db)
    const svc = new MandalaLookupService({ storage, verifierWallet: overlay as any })
    const assetId = 'r.0'
    const mk = (txid: string, h: number, off: number, kind: any, extra = {}): any => ({ assetId, txid, outputIndex: 0, height: h, offset: off, admitSeq: 0, actionDetails: { kind, assetId, ...extra }, createdAt: new Date() })
    await storage.appendAdminHistory(mk('t2', 101, 0, 'unpause'))
    await storage.appendAdminHistory(mk('t1', 100, 0, 'pause'))
    const state = await svc.rebuildState(assetId)
    expect(state.isPaused).toBe(false) // pause@100 then unpause@101
  })
})
