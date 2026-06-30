import { MandalaTopicManager } from '../mandala/MandalaTopicManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload } from '../mandala/types.js'
import { AssetAdminState, defaultAssetState } from '../mandala/AssetStateReducer.js'
import { MandalaTokenRecord } from '../mandala/types.js'
import { MandalaToken, MandalaAdmin } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Transaction, Hash, Utils, WalletProtocol, Script } from '@bsv/sdk'
import { MandalaStorageManager } from '../mandala/MandalaStorageManager.js'
import { MandalaLookupService } from '../mandala/MandalaLookupService.js'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'

const protocolID: WalletProtocol = [2, 'mandala token']
const keyID = 'tkn'

// Stub stateStore: getAssetState returns a fixed state; getTokenRow looks up an
// optional fixture map keyed by `${txid}.${outputIndex}`.
const stubStore = (
  state: AssetAdminState,
  rows: Record<string, MandalaTokenRecord> = {}
): { getAssetState: (assetId: string) => Promise<AssetAdminState>, getTokenRow: (txid: string, outputIndex: number) => Promise<MandalaTokenRecord | null> } => ({
  getAssetState: async () => state,
  getTokenRow: async (t: string, i: number) => rows[`${t}.${i}`] ?? null
})

// Default permissive store for the pre-existing admit/conservation/sanctions tests:
// no pause, denylist mode with nothing blocked, no frozen/evicted outpoints.
const defaultStore = (assetId = `${'a'.repeat(64)}.0`): ReturnType<typeof stubStore> =>
  stubStore(defaultAssetState(assetId))

async function buildTransfer (opts: { sanctioned?: boolean } = {}) {
  const sender = new ProtoWallet(PrivateKey.fromRandom())
  const receiver = new ProtoWallet(PrivateKey.fromRandom())
  const overlay = new ProtoWallet(PrivateKey.fromRandom())

  const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
  const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
  const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })

  const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
  const assetId = `${'a'.repeat(64)}.0`

  // Prior coin: an existing MandalaToken of the same assetId + amount that this tx spends.
  const sourceTx = new Transaction()
  sourceTx.addOutput({ lockingScript: new MandalaToken().lock(assetId, 100, pkh), satoshis: 1 })

  // Transfer tx: spends the prior coin, re-creates 100 units to the receiver. Supply conserved.
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() })
  tx.addOutput({ lockingScript: new MandalaToken().lock(assetId, 100, pkh), satoshis: 1 })

  const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
  const offChainValues = encodeLinkagePayload({ inputs: [], outputs: [{ index: 0, linkage: linkage as any }] })

  const screening = new InMemoryScreeningProvider(opts.sanctioned === true ? [receiverKey] : [])
  return {
    tm: new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: screening, adminWallet: overlay as any, adminProtocolID: [2, 'mandala admin'], stateStore: defaultStore() }),
    beef: tx.toBEEF(),
    offChainValues
  }
}

describe('MandalaTopicManager', () => {
  it('admits an FT transfer whose linkage verifies, supply conserved, party clean', async () => {
    const { tm, beef, offChainValues } = await buildTransfer()
    const result = await tm.identifyAdmissibleOutputs(beef, [0], offChainValues)
    expect(result.outputsToAdmit).toEqual([0])
  })

  it('rejects the whole tx when a party is sanctioned', async () => {
    const { tm, beef, offChainValues } = await buildTransfer({ sanctioned: true })
    const result = await tm.identifyAdmissibleOutputs(beef, [0], offChainValues)
    expect(result.outputsToAdmit).toEqual([])
  })

  it('does not admit FT outputs lacking valid linkage', async () => {
    const { tm, beef } = await buildTransfer()
    const result = await tm.identifyAdmissibleOutputs(beef, [0])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects an unbacked mint: FT output with no inputs and no admin authorization', async () => {
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const receiver = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
    const assetId = `${'a'.repeat(64)}.0`
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new MandalaToken().lock(assetId, 100, pkh), satoshis: 1 })
    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({ inputs: [], outputs: [{ index: 0, linkage: linkage as any }] })
    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: overlay as any, adminProtocolID: [2, 'mandala admin'], stateStore: defaultStore() })
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([])
  })
})

describe('MandalaTopicManager admin chain', () => {
  it('admits an issuance whose boundKey re-derives from the declared action details', async () => {
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const adminProto: [number, string] = [2, 'mandala admin']

    const actionDetails = { kind: 'register' as const, assetId: `${'c'.repeat(64)}.0` }

    const tx = new Transaction()
    tx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: actionDetails }), satoshis: 1 })

    const offChainValues = encodeLinkagePayload({
      inputs: [], outputs: [], admin: [{ index: 0, actionDetails }]
    } as any)

    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto, stateStore: defaultStore() } as any)
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([0])
  })

  it('rejects an admin output whose action details do not re-derive the boundKey', async () => {
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const adminProto: [number, string] = [2, 'mandala admin']
    const tx = new Transaction()
    tx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: { kind: 'register', assetId: `${'c'.repeat(64)}.0` } }), satoshis: 1 })
    const offChainValues = encodeLinkagePayload({
      inputs: [], outputs: [], admin: [{ index: 0, actionDetails: { kind: 'register', assetId: 'WRONG.0' } }]
    } as any)
    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto, stateStore: defaultStore() } as any)
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([])
  })

  it('does not let a valid admin output for one asset authorize minting a different asset', async () => {
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const receiver = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const adminProto: [number, string] = [2, 'mandala admin']

    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))

    const assetA = `${'a'.repeat(64)}.0` // minted with no inputs
    const assetC = `${'c'.repeat(64)}.0` // the admin (register) asset

    const registerDetails = { kind: 'register' as const, assetId: assetC }

    const tx = new Transaction()
    tx.addOutput({ lockingScript: new MandalaToken().lock(assetA, 100, pkh), satoshis: 1 }) // index 0: unbacked FT
    tx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: registerDetails }), satoshis: 1 }) // index 1: valid admin for C

    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({
      inputs: [],
      outputs: [{ index: 0, linkage: linkage as any }],
      admin: [{ index: 1, actionDetails: registerDetails }]
    } as any)

    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto as any, stateStore: defaultStore() })
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([]) // asset A is unauthorized -> whole tx rejected
  })

  it('admits an authorized issuance that mints exactly the declared amount', async () => {
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const receiver = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const adminProto: [number, string] = [2, 'mandala admin']

    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
    const assetA = `${'a'.repeat(64)}.0`

    // Prior authorization outpoint (genesis-ish admin output the issue tx will spend).
    const priorDetails = { kind: 'register' as const, assetId: assetA }
    const priorTx = new Transaction()
    priorTx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: priorDetails }), satoshis: 1 })

    const issueDetails = { kind: 'issue' as const, assetId: assetA, amount: 100, priorOutpoint: `${priorTx.id('hex')}.0` }

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: priorTx, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff }) // spends prior auth outpoint
    tx.addOutput({ lockingScript: new MandalaToken().lock(assetA, 100, pkh), satoshis: 1 }) // index 0: minted FT
    tx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: issueDetails }), satoshis: 1 }) // index 1: next auth outpoint

    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({
      inputs: [],
      outputs: [{ index: 0, linkage: linkage as any }],
      admin: [{ index: 1, actionDetails: issueDetails }]
    } as any)

    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto as any, stateStore: defaultStore() })
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([0, 1]) // minted FT + next auth outpoint both admitted
  })

  it('admits a partial redeem: burns part of a holding, keeps change, conservation holds', async () => {
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const receiver = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const adminProto: [number, string] = [2, 'mandala admin']

    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
    const assetA = `${'a'.repeat(64)}.0`

    // Prior admin-auth outpoint the redeem spends.
    const priorDetails = { kind: 'issue' as const, assetId: assetA, amount: 100, priorOutpoint: `${'b'.repeat(64)}.0` }
    const adminPriorTx = new Transaction()
    adminPriorTx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: priorDetails }), satoshis: 1 })

    // Prior FT coin of 100 that gets partially burned.
    const ftPriorTx = new Transaction()
    ftPriorTx.addOutput({ lockingScript: new MandalaToken().lock(assetA, 100, pkh), satoshis: 1 })

    const redeemDetails = { kind: 'redeem' as const, assetId: assetA, amount: 30, priorOutpoint: `${adminPriorTx.id('hex')}.0` }

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: ftPriorTx, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff })   // input 0: FT 100 (previous coin)
    tx.addInput({ sourceTransaction: adminPriorTx, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff }) // input 1: prior admin auth
    tx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: redeemDetails }), satoshis: 1 })            // index 0: redeem admin auth
    tx.addOutput({ lockingScript: new MandalaToken().lock(assetA, 70, pkh), satoshis: 1 }) // index 1: FT change 70

    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({
      inputs: [], outputs: [{ index: 1, linkage: linkage as any }], admin: [{ index: 0, actionDetails: redeemDetails }]
    } as any)

    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto as any, stateStore: defaultStore() })
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [0], offChainValues)
    expect(result.outputsToAdmit).toEqual([0, 1]) // redeem auth + FT change both admitted; 70 === 100 - 30
  })
})

describe('MandalaTopicManager control gate', () => {
  const adminProto: [number, string] = [2, 'mandala admin']

  // Builds a peer transfer of `assetId`: a prior FT coin of `amount` to the
  // sender, re-created to `receiverKey`'s derived pkh. Returns the tx, the BEEF,
  // the offChain linkage payload, the receiver identity key, and the prior
  // outpoint string the tx spends.
  const buildPeerTransfer = async (
    assetId: string,
    amount: number,
    overlay: ProtoWallet
  ): Promise<{ beef: number[], offChainValues: number[], receiverKey: string, inputOutpoint: string }> => {
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const receiver = new ProtoWallet(PrivateKey.fromRandom())
    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))

    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript: new MandalaToken().lock(assetId, amount, pkh), satoshis: 1 })

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() })
    tx.addOutput({ lockingScript: new MandalaToken().lock(assetId, amount, pkh), satoshis: 1 })

    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({ inputs: [], outputs: [{ index: 0, linkage: linkage as any }] })
    return { beef: tx.toBEEF(), offChainValues, receiverKey, inputOutpoint: `${sourceTx.id('hex')}.0` }
  }

  it('rejects a peer transfer of a paused asset but admits an admin action', async () => {
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const assetId = `${'a'.repeat(64)}.0`
    const paused: AssetAdminState = { ...defaultAssetState(assetId), isPaused: true }

    // Peer transfer of a paused asset -> rejected.
    const transfer = await buildPeerTransfer(assetId, 100, overlay)
    const tmTransfer = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: overlay as any, adminProtocolID: adminProto, stateStore: stubStore(paused) })
    const transferResult = await tmTransfer.identifyAdmissibleOutputs(transfer.beef, [0], transfer.offChainValues)
    expect(transferResult.outputsToAdmit).toEqual([])

    // Admin pause action on the same asset -> admitted (admin actions exempt).
    const priorDetails = { kind: 'register' as const, assetId }
    const priorTx = new Transaction()
    priorTx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: priorDetails }), satoshis: 1 })
    const pauseDetails = { kind: 'pause' as const, assetId, priorOutpoint: `${priorTx.id('hex')}.0` }
    const adminTx = new Transaction()
    adminTx.addInput({ sourceTransaction: priorTx, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() })
    adminTx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: pauseDetails }), satoshis: 1 })
    const adminOffChain = encodeLinkagePayload({ inputs: [], outputs: [], admin: [{ index: 0, actionDetails: pauseDetails }] } as any)
    const tmAdmin = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto, stateStore: stubStore(paused) })
    const adminResult = await tmAdmin.identifyAdmissibleOutputs(adminTx.toBEEF(), [], adminOffChain)
    expect(adminResult.outputsToAdmit).toEqual([0])
  })

  it('rejects any tx that spends a frozen outpoint (incl. would-be recover/redeem)', async () => {
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const assetId = `${'a'.repeat(64)}.0`
    const transfer = await buildPeerTransfer(assetId, 100, overlay)
    const frozen: AssetAdminState = {
      ...defaultAssetState(assetId),
      frozenOutpoints: [{ outpoint: transfer.inputOutpoint, amount: 100, owner: 'someone' }]
    }
    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: overlay as any, adminProtocolID: adminProto, stateStore: stubStore(frozen) })
    const result = await tm.identifyAdmissibleOutputs(transfer.beef, [0], transfer.offChainValues)
    expect(result.outputsToAdmit).toEqual([])
  })

  it('denylist rejects a transfer whose recipient is blocked; allowlist rejects a non-listed recipient', async () => {
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const assetId = `${'a'.repeat(64)}.0`

    // Denylist: recipient blocked -> rejected.
    const t1 = await buildPeerTransfer(assetId, 100, overlay)
    const deny: AssetAdminState = { ...defaultAssetState(assetId), accessMode: 'denylist', blockedIdentities: [t1.receiverKey] }
    const tmDeny = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: overlay as any, adminProtocolID: adminProto, stateStore: stubStore(deny) })
    expect((await tmDeny.identifyAdmissibleOutputs(t1.beef, [0], t1.offChainValues)).outputsToAdmit).toEqual([])

    // Allowlist: recipient not on the list -> rejected.
    const t2 = await buildPeerTransfer(assetId, 100, overlay)
    const allow: AssetAdminState = { ...defaultAssetState(assetId), accessMode: 'allowlist', allowedIdentities: ['someone-else'] }
    const tmAllow = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: overlay as any, adminProtocolID: adminProto, stateStore: stubStore(allow) })
    expect((await tmAllow.identifyAdmissibleOutputs(t2.beef, [0], t2.offChainValues)).outputsToAdmit).toEqual([])

    // Allowlist: recipient IS on the list -> admitted.
    const t3 = await buildPeerTransfer(assetId, 100, overlay)
    const allowOk: AssetAdminState = { ...defaultAssetState(assetId), accessMode: 'allowlist', allowedIdentities: [t3.receiverKey] }
    const tmAllowOk = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: overlay as any, adminProtocolID: adminProto, stateStore: stubStore(allowOk) })
    expect((await tmAllowOk.identifyAdmissibleOutputs(t3.beef, [0], t3.offChainValues)).outputsToAdmit).toEqual([0])
  })

  // Builds a reissue tx: spends a prior admin auth outpoint, mints `amount` FT of
  // `assetId` to `receiverKey`, and emits the reissue admin auth. Zero FT inputs.
  const buildReissue = async (
    assetId: string,
    amount: number,
    targetOutpoint: string,
    overlay: ProtoWallet,
    issuer: ProtoWallet
  ): Promise<{ beef: number[], offChainValues: number[], receiverKey: string }> => {
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const receiver = new ProtoWallet(PrivateKey.fromRandom())
    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))

    const priorDetails = { kind: 'register' as const, assetId }
    const priorTx = new Transaction()
    priorTx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: priorDetails }), satoshis: 1 })

    const reissueDetails = { kind: 'reissue' as const, assetId, amount, outpoint: targetOutpoint, priorOutpoint: `${priorTx.id('hex')}.0` }

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: priorTx, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() })
    tx.addOutput({ lockingScript: new MandalaToken().lock(assetId, amount, pkh), satoshis: 1 }) // index 0: reissued FT
    tx.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: reissueDetails }), satoshis: 1 }) // index 1: reissue auth

    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({
      inputs: [], outputs: [{ index: 0, linkage: linkage as any }], admin: [{ index: 1, actionDetails: reissueDetails }]
    } as any)
    return { beef: tx.toBEEF(), offChainValues, receiverKey }
  }

  it('admin reissue is exempt from access-mode and mints to a non-allowlisted recipient', async () => {
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const assetId = `${'a'.repeat(64)}.0`
    const targetOutpoint = `${'d'.repeat(64)}.0`
    const r = await buildReissue(assetId, 50, targetOutpoint, overlay, issuer)
    // Allowlist mode, recipient NOT listed; reissue guards satisfied (frozen, amount matches, zero FT inputs).
    const state: AssetAdminState = {
      ...defaultAssetState(assetId),
      accessMode: 'allowlist',
      allowedIdentities: ['some-other-identity'],
      frozenOutpoints: [{ outpoint: targetOutpoint, amount: 50, owner: 'evictee' }]
    }
    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto, stateStore: stubStore(state) })
    const result = await tm.identifyAdmissibleOutputs(r.beef, [], r.offChainValues)
    expect(result.outputsToAdmit).toEqual([0, 1])
  })

  it('reissue rejected unless target outpoint is frozen, amount matches the frozen row, and the tx has zero FT inputs of the asset', async () => {
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const assetId = `${'a'.repeat(64)}.0`
    const targetOutpoint = `${'d'.repeat(64)}.0`

    // (a) target outpoint NOT frozen -> rejected.
    const rA = await buildReissue(assetId, 50, targetOutpoint, overlay, issuer)
    const stateNotFrozen: AssetAdminState = { ...defaultAssetState(assetId), frozenOutpoints: [] }
    const tmA = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto, stateStore: stubStore(stateNotFrozen) })
    expect((await tmA.identifyAdmissibleOutputs(rA.beef, [], rA.offChainValues)).outputsToAdmit).toEqual([])

    // (b) amount mismatch (frozen row says 99, reissue mints 50) -> rejected.
    const rB = await buildReissue(assetId, 50, targetOutpoint, overlay, issuer)
    const stateWrongAmount: AssetAdminState = { ...defaultAssetState(assetId), frozenOutpoints: [{ outpoint: targetOutpoint, amount: 99, owner: 'evictee' }] }
    const tmB = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto, stateStore: stubStore(stateWrongAmount) })
    expect((await tmB.identifyAdmissibleOutputs(rB.beef, [], rB.offChainValues)).outputsToAdmit).toEqual([])

    // (c) tx has an FT input of the asset -> rejected.
    const sender = new ProtoWallet(PrivateKey.fromRandom())
    const receiver = new ProtoWallet(PrivateKey.fromRandom())
    const { publicKey: receiverKey } = await receiver.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await overlay.getPublicKey({ identityKey: true })
    const { publicKey: derivedKey } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
    const pkh = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
    const priorDetailsC = { kind: 'register' as const, assetId }
    const priorTxC = new Transaction()
    priorTxC.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: priorDetailsC }), satoshis: 1 })
    const ftPriorTx = new Transaction()
    ftPriorTx.addOutput({ lockingScript: new MandalaToken().lock(assetId, 50, pkh), satoshis: 1 })
    const reissueDetailsC = { kind: 'reissue' as const, assetId, amount: 50, outpoint: targetOutpoint, priorOutpoint: `${priorTxC.id('hex')}.0` }
    const txC = new Transaction()
    txC.addInput({ sourceTransaction: ftPriorTx, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() }) // FT input of the asset
    txC.addInput({ sourceTransaction: priorTxC, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() })
    txC.addOutput({ lockingScript: new MandalaToken().lock(assetId, 50, pkh), satoshis: 1 })
    txC.addOutput({ lockingScript: await MandalaAdmin.lock({ wallet: issuer as any, data: reissueDetailsC }), satoshis: 1 })
    const linkageC = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainC = encodeLinkagePayload({ inputs: [], outputs: [{ index: 0, linkage: linkageC as any }], admin: [{ index: 1, actionDetails: reissueDetailsC }] } as any)
    const stateFrozenC: AssetAdminState = { ...defaultAssetState(assetId), frozenOutpoints: [{ outpoint: targetOutpoint, amount: 50, owner: 'evictee' }] }
    const tmC = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto, stateStore: stubStore(stateFrozenC) })
    expect((await tmC.identifyAdmissibleOutputs(txC.toBEEF(), [0], offChainC)).outputsToAdmit).toEqual([])

    // Positive: frozen, amount matches, zero FT inputs -> admitted.
    const rOk = await buildReissue(assetId, 50, targetOutpoint, overlay, issuer)
    const stateOk: AssetAdminState = { ...defaultAssetState(assetId), frozenOutpoints: [{ outpoint: targetOutpoint, amount: 50, owner: 'evictee' }] }
    const tmOk = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto, stateStore: stubStore(stateOk) })
    expect((await tmOk.identifyAdmissibleOutputs(rOk.beef, [], rOk.offChainValues)).outputsToAdmit).toEqual([0, 1])
  })

  it('a sanctioned identity is rejected even for an admin action', async () => {
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const assetId = `${'a'.repeat(64)}.0`
    const targetOutpoint = `${'d'.repeat(64)}.0`
    const r = await buildReissue(assetId, 50, targetOutpoint, overlay, issuer)
    // Reissue guards satisfied, but the minted recipient is sanctioned -> rejected
    // (sanctions is universal and applies even to admin actions).
    const state: AssetAdminState = { ...defaultAssetState(assetId), frozenOutpoints: [{ outpoint: targetOutpoint, amount: 50, owner: 'evictee' }] }
    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([r.receiverKey]), adminWallet: issuer as any, adminProtocolID: adminProto, stateStore: stubStore(state) })
    const result = await tm.identifyAdmissibleOutputs(r.beef, [], r.offChainValues)
    expect(result.outputsToAdmit).toEqual([])
  })
})

describe('MandalaLookupService metadata', () => {
  let mongod: MongoMemoryServer, client: MongoClient, ls: MandalaLookupService, storage: MandalaStorageManager
  const overlay = new ProtoWallet(PrivateKey.fromRandom())

  // In whole-tx admission mode the lookup service decodes the admitted output
  // from the atomic BEEF, so fixtures must be real transactions. txid is derived
  // from the tx rather than supplied, so we capture it from the built fixture.
  const txWithAdminLock = (lock: any): Transaction => {
    const source = new Transaction()
    source.addOutput({ satoshis: 1000, lockingScript: new MandalaToken().lock(`${'f'.repeat(64)}.0`, 1, Hash.hash160(Utils.toArray('00', 'hex'))) })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() })
    tx.addOutput({ satoshis: 1, lockingScript: lock })
    return tx
  }
  let txid: string

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create()
    client = new MongoClient(mongod.getUri()); await client.connect()
    storage = new MandalaStorageManager(client.db('test'))
    ls = new MandalaLookupService({ storage, verifierWallet: overlay as any })
  })
  afterAll(async () => { await client.close(); await mongod.stop() })

  it('indexes an admin output with publicData and serves it by assetId', async () => {
    const lock = await MandalaAdmin.lock({ wallet: overlay as any, data: { kind: 'register' }, publicData: { label: 'Gold' } })
    const tx = txWithAdminLock(lock)
    txid = tx.id('hex')
    await ls.outputAdmittedByTopic({ mode: 'whole-tx', topic: 'tm_mandala', outputIndex: 0, atomicBEEF: tx.toAtomicBEEF() } as any)
    const formula = await ls.lookup({ service: 'ls_mandala', query: { metadataAssetId: `${txid}.0` } } as any)
    expect(formula).toEqual([{ txid, outputIndex: 0 }])
  })

  it('keeps metadata on spend but removes it on evict', async () => {
    await ls.outputSpent({ topic: 'tm_mandala', txid, outputIndex: 0 } as any)
    expect(await ls.lookup({ service: 'ls_mandala', query: { metadataAssetId: `${txid}.0` } } as any)).toEqual([{ txid, outputIndex: 0 }])
    await ls.outputEvicted(txid, 0)
    expect(await ls.lookup({ service: 'ls_mandala', query: { metadataAssetId: `${txid}.0` } } as any)).toEqual([])
  })

  it('does not index an admin output without publicData', async () => {
    const lock = await MandalaAdmin.lock({ wallet: overlay as any, data: { kind: 'register' } })
    const tx = txWithAdminLock(lock)
    const t2 = tx.id('hex')
    await ls.outputAdmittedByTopic({ mode: 'whole-tx', topic: 'tm_mandala', outputIndex: 0, atomicBEEF: tx.toAtomicBEEF() } as any)
    expect(await ls.lookup({ service: 'ls_mandala', query: { metadataAssetId: `${t2}.0` } } as any)).toEqual([])
  })
})
