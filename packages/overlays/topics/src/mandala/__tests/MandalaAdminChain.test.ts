import { MandalaTopicManager } from '../MandalaTopicManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload, MandalaLinkagePayload } from '../types.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import { MandalaAdmin, ADMIN_PROTOCOL, MandalaActionDetails } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Hash, Utils, Transaction, P2PKH, UnlockingScript } from '@bsv/sdk'

// Admin authority is the CHAIN OF SPENDS, not key re-derivation.
//
// verifyAdminOutput re-derives the expected lock key from details.counterparty,
// which arrives in the unauthenticated off-chain payload. By BRC-42 that key
// belongs to the named counterparty, who can compute AND spend it from their
// own root key plus the overlay's PUBLIC identity key. So a third party can
// always reproduce the expected pubKeyHash. What they cannot do is spend the
// admin output this topic already admitted — and that is what must be required.

const assetId = `${'a'.repeat(64)}.0`

const overlay = new ProtoWallet(PrivateKey.fromRandom())
const issuer = new ProtoWallet(PrivateKey.fromRandom())
const attacker = new ProtoWallet(PrivateKey.fromRandom())

const makeManager = (recordedAdminOutpoints: string[]): MandalaTopicManager =>
  new MandalaTopicManager({
    verifierWallet: overlay as any,
    screeningProvider: new InMemoryScreeningProvider([]),
    adminWallet: issuer as any,
    adminProtocolID: ADMIN_PROTOCOL,
    stateStore: {
      getAssetState: async (id: string) => ({ ...defaultAssetState(id), isPaused: true }),
      getTokenRow: async () => null,
      isAdminOutpoint: async (a: string, txid: string, vout: number) =>
        recordedAdminOutpoints.includes(`${a}|${txid}.${vout}`)
    }
  })

const fundedTx = (): { tx: Transaction, outpoint: string } => {
  const source = new Transaction()
  source.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(Hash.hash160(Utils.toArray('00', 'hex'))) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  return { tx, outpoint: `${source.id('hex')}.0` }
}

/** The lock an ATTACKER can build, knowing only its own key and the overlay's public key. */
const attackerForgedAdminLock = async (details: MandalaActionDetails): Promise<any> => {
  const { publicKey: issuerKey } = await issuer.getPublicKey({ identityKey: true })
  const { publicKey } = await attacker.getPublicKey({
    protocolID: ADMIN_PROTOCOL,
    keyID: MandalaAdmin.commitment(details),
    counterparty: issuerKey,
    forSelf: true
  })
  return new P2PKH().lock(Hash.hash160(Utils.toArray(publicKey, 'hex')))
}

const run = async (
  manager: MandalaTopicManager,
  tx: Transaction,
  details: MandalaActionDetails,
  previousCoins: number[]
): Promise<{ outputsToAdmit: number[] }> => {
  const payload: MandalaLinkagePayload = {
    inputs: [], outputs: [], admin: [{ index: 0, actionDetails: details }]
  }
  return await manager.identifyAdmissibleOutputs(tx.toBEEF(), previousCoins, encodeLinkagePayload(payload)) as any
}

describe('MandalaTopicManager admin chain anchoring', () => {
  it('a third party can reproduce the expected admin lock, so the key alone proves nothing', async () => {
    const { outpoint } = fundedTx()
    const details: MandalaActionDetails = {
      kind: 'unpause', assetId, priorOutpoint: outpoint,
      counterparty: (await attacker.getPublicKey({ identityKey: true })).publicKey
    }
    // What the topic manager re-derives for this action: the admin wallet
    // deriving AGAINST the named counterparty (forSelf defaults false), i.e.
    // the counterparty's own child key.
    const attackerKey = (await attacker.getPublicKey({ identityKey: true })).publicKey
    const { publicKey: expectedByOverlay } = await issuer.getPublicKey({
      protocolID: ADMIN_PROTOCOL,
      keyID: MandalaAdmin.commitment(details),
      counterparty: attackerKey
    })
    // What the attacker derives knowing only its own key and the issuer's
    // PUBLIC key. BRC-42 symmetry makes these the same point — and the
    // attacker holds its private half.
    const { publicKey: derivedByAttacker } = await attacker.getPublicKey({
      protocolID: ADMIN_PROTOCOL,
      keyID: MandalaAdmin.commitment(details),
      counterparty: (await issuer.getPublicKey({ identityKey: true })).publicKey,
      forSelf: true
    })
    expect(derivedByAttacker).toEqual(expectedByOverlay)
  })

  it('refuses a forged admin action whose prior is not a recorded admin output', async () => {
    const { tx, outpoint } = fundedTx()
    const details: MandalaActionDetails = {
      kind: 'unpause', assetId, priorOutpoint: outpoint,
      counterparty: (await attacker.getPublicKey({ identityKey: true })).publicKey
    }
    tx.addOutput({ satoshis: 1, lockingScript: await attackerForgedAdminLock(details) })
    // Not admitted, so nothing folds into asset state and the pause stands.
    const res = await run(makeManager([]), tx, details, [0])
    expect(res.outputsToAdmit).toEqual([])
  })

  it('refuses an admin action whose prior this topic never admitted as a coin', async () => {
    const { tx, outpoint } = fundedTx()
    const details: MandalaActionDetails = { kind: 'unpause', assetId, priorOutpoint: outpoint }
    tx.addOutput({ satoshis: 1, lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: details }) })
    // Recorded, but previousCoins is empty: the engine did not admit that spend.
    const res = await run(makeManager([`${assetId}|${outpoint}`]), tx, details, [])
    expect(res.outputsToAdmit).toEqual([])
  })

  it('admits an action that spends the recorded admin output', async () => {
    const { tx, outpoint } = fundedTx()
    const details: MandalaActionDetails = { kind: 'unpause', assetId, priorOutpoint: outpoint }
    tx.addOutput({ satoshis: 1, lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: details }) })
    const res = await run(makeManager([`${assetId}|${outpoint}`]), tx, details, [0])
    expect(res.outputsToAdmit).toEqual([0])
  })

  it('lets authority transfer to whoever the next output is locked to', async () => {
    const { tx, outpoint } = fundedTx()
    const details: MandalaActionDetails = {
      kind: 'unpause', assetId, priorOutpoint: outpoint,
      counterparty: (await attacker.getPublicKey({ identityKey: true })).publicKey
    }
    tx.addOutput({ satoshis: 1, lockingScript: await attackerForgedAdminLock(details) })
    // Same shape as the forgery above, but the prior IS the recorded admin
    // output and IS spent — so this is legitimate delegation, not a forgery.
    const res = await run(makeManager([`${assetId}|${outpoint}`]), tx, details, [0])
    expect(res.outputsToAdmit).toEqual([0])
  })

  it('refuses a non-register action that names no prior at all', async () => {
    const { tx } = fundedTx()
    const details: MandalaActionDetails = { kind: 'unpause', assetId }
    tx.addOutput({ satoshis: 1, lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: details }) })
    const res = await run(makeManager([]), tx, details, [0])
    expect(res.outputsToAdmit).toEqual([])
  })

  it('refuses a prior it cannot parse as an outpoint, or one without an assetId to look up', async () => {
    for (const priorOutpoint of ['not-an-outpoint', `${'b'.repeat(64)}.-1`, `${'b'.repeat(64)}.x`]) {
      const { tx } = fundedTx()
      // The spent input's outpoint is what admittedInputs holds; the payload's
      // prior must equal it to pass the first check, so name the input's
      // outpoint here and break only the parse in the assetId-less variant.
      const details: MandalaActionDetails = { kind: 'unpause', assetId, priorOutpoint }
      tx.addOutput({ satoshis: 1, lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: details }) })
      const res = await run(makeManager([`${assetId}|${priorOutpoint}`]), tx, details, [0])
      expect(res.outputsToAdmit).toEqual([])
    }
    const { tx, outpoint } = fundedTx()
    const noAsset = { kind: 'unpause', priorOutpoint: outpoint } as unknown as MandalaActionDetails
    tx.addOutput({ satoshis: 1, lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: noAsset }) })
    const res = await run(makeManager([`${assetId}|${outpoint}`]), tx, noAsset, [0])
    expect(res.outputsToAdmit).toEqual([])
  })

  it('a store without isAdminOutpoint anchors on the spent prior alone', async () => {
    const { tx, outpoint } = fundedTx()
    const details: MandalaActionDetails = { kind: 'unpause', assetId, priorOutpoint: outpoint }
    tx.addOutput({ satoshis: 1, lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: details }) })
    const legacy = new MandalaTopicManager({
      verifierWallet: overlay as any,
      screeningProvider: new InMemoryScreeningProvider([]),
      adminWallet: issuer as any,
      adminProtocolID: ADMIN_PROTOCOL,
      stateStore: {
        getAssetState: async (id: string) => ({ ...defaultAssetState(id), isPaused: true }),
        getTokenRow: async () => null
      }
    })
    const res = await run(legacy, tx, details, [0])
    expect(res.outputsToAdmit).toEqual([0])
  })

  it('needs no prior for a genesis register', async () => {
    const { tx } = fundedTx()
    const details: MandalaActionDetails = { kind: 'register', assetId }
    tx.addOutput({ satoshis: 1, lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: details }) })
    const res = await run(makeManager([]), tx, details, [])
    expect(res.outputsToAdmit).toEqual([0])
  })
})
