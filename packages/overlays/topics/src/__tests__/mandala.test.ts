import { MandalaTopicManager } from '../mandala/MandalaTopicManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload } from '../mandala/types.js'
import { MandalaToken } from '@bsv/templates'
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
    tm: new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: screening }),
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
    const result = await tm.identifyAdmissibleOutputs(beef, [0], undefined)
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
    const tm = new MandalaTopicManager({ verifierWallet: overlay as any, screeningProvider: new InMemoryScreeningProvider([]) })
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [], offChainValues)
    expect(result.outputsToAdmit).toEqual([])
  })
})
