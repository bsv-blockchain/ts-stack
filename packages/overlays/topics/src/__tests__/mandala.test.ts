import { MandalaTopicManager } from '../mandala/MandalaTopicManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload } from '../mandala/types.js'
import { MandalaToken, MandalaAdmin } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Transaction, Hash, Utils, WalletProtocol, Script } from '@bsv/sdk'

const protocolID: WalletProtocol = [2, 'mandala token']
const keyID = 'tkn'

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
    tm: new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: screening, adminWallet: overlay as any, adminProtocolID: [2, 'mandala admin'] }),
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
    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: overlay as any, adminProtocolID: [2, 'mandala admin'] })
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([])
  })
})

describe('MandalaTopicManager admin chain', () => {
  it('admits an issuance whose boundKey re-derives from the declared action details', async () => {
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const adminProto: [number, string] = [2, 'mandala admin']

    const admin = new MandalaAdmin(issuer as any)
    const actionDetails = { kind: 'register' as const, assetId: `${'c'.repeat(64)}.0` }
    const { boundKey } = await admin.deriveBoundKey(adminProto as any, actionDetails)

    const tx = new Transaction()
    tx.addOutput({ lockingScript: admin.lock(boundKey), satoshis: 1 })

    const offChainValues = encodeLinkagePayload({
      inputs: [], outputs: [], admin: [{ index: 0, actionDetails }]
    } as any)

    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto } as any)
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([0])
  })

  it('rejects an admin output whose action details do not re-derive the boundKey', async () => {
    const issuer = new ProtoWallet(PrivateKey.fromRandom())
    const overlay = new ProtoWallet(PrivateKey.fromRandom())
    const adminProto: [number, string] = [2, 'mandala admin']
    const admin = new MandalaAdmin(issuer as any)
    const { boundKey } = await admin.deriveBoundKey(adminProto as any, { kind: 'register', assetId: `${'c'.repeat(64)}.0` })
    const tx = new Transaction()
    tx.addOutput({ lockingScript: admin.lock(boundKey), satoshis: 1 })
    const offChainValues = encodeLinkagePayload({
      inputs: [], outputs: [], admin: [{ index: 0, actionDetails: { kind: 'register', assetId: 'WRONG.0' } }]
    } as any)
    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto } as any)
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

    const admin = new MandalaAdmin(issuer as any)
    const registerDetails = { kind: 'register' as const, assetId: assetC }
    const { boundKey } = await admin.deriveBoundKey(adminProto as any, registerDetails)

    const tx = new Transaction()
    tx.addOutput({ lockingScript: new MandalaToken().lock(assetA, 100, pkh), satoshis: 1 }) // index 0: unbacked FT
    tx.addOutput({ lockingScript: admin.lock(boundKey), satoshis: 1 })                       // index 1: valid admin for C

    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({
      inputs: [],
      outputs: [{ index: 0, linkage: linkage as any }],
      admin: [{ index: 1, actionDetails: registerDetails }]
    } as any)

    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto as any })
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

    const admin = new MandalaAdmin(issuer as any)
    // Prior authorization outpoint (genesis-ish admin output the issue tx will spend).
    const priorDetails = { kind: 'register' as const, assetId: assetA }
    const { boundKey: priorBoundKey } = await admin.deriveBoundKey(adminProto as any, priorDetails)
    const priorTx = new Transaction()
    priorTx.addOutput({ lockingScript: admin.lock(priorBoundKey), satoshis: 1 })

    const issueDetails = { kind: 'issue' as const, assetId: assetA, amount: 100, priorOutpoint: `${priorTx.id('hex')}.0` }
    const { boundKey: issueBoundKey } = await admin.deriveBoundKey(adminProto as any, issueDetails)

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: priorTx, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff }) // spends prior auth outpoint
    tx.addOutput({ lockingScript: new MandalaToken().lock(assetA, 100, pkh), satoshis: 1 }) // index 0: minted FT
    tx.addOutput({ lockingScript: admin.lock(issueBoundKey), satoshis: 1 })                  // index 1: next auth outpoint

    const linkage = await sender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })
    const offChainValues = encodeLinkagePayload({
      inputs: [],
      outputs: [{ index: 0, linkage: linkage as any }],
      admin: [{ index: 1, actionDetails: issueDetails }]
    } as any)

    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]), adminWallet: issuer as any, adminProtocolID: adminProto as any })
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([0, 1]) // minted FT + next auth outpoint both admitted
  })
})
