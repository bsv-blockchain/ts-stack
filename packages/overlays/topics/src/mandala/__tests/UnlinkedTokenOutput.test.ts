import { MandalaTopicManager, unlinkedTokenReason } from '../MandalaTopicManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload, MandalaLinkagePayload } from '../types.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import { MandalaToken } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Hash, Utils, WalletProtocol, Transaction, P2PKH, UnlockingScript } from '@bsv/sdk'

// A token-shaped output the overlay cannot attribute to a verified linkage
// rejects the WHOLE transaction. Skipping it admitted its siblings, signed the
// admission and broadcast — a phantom coin mined inside an attested tx.

const protocolID: WalletProtocol = [2, 'mandala token']
const keyID = 'tkn'
const assetId = `${'a'.repeat(64)}.0`

const sender = new ProtoWallet(PrivateKey.fromRandom())
const receiver = new ProtoWallet(PrivateKey.fromRandom())
const other = new ProtoWallet(PrivateKey.fromRandom())
const overlay = new ProtoWallet(PrivateKey.fromRandom())

const manager = new MandalaTopicManager({
  verifierWallet: overlay as any,
  screeningProvider: new InMemoryScreeningProvider([]),
  adminWallet: overlay as any,
  adminProtocolID: [2, 'mandala admin'],
  stateStore: {
    getAssetState: async () => defaultAssetState(assetId),
    getTokenRow: async () => null,
    isAdminOutpoint: async () => true
  }
})

const identity = async (w: ProtoWallet): Promise<string> => (await w.getPublicKey({ identityKey: true })).publicKey

/** A conserved 100-unit transfer: one token input, `outputs` token outputs summing to 100. */
async function transfer (amounts: number[]): Promise<{ tx: Transaction, linkageFor: (counterparty: ProtoWallet) => Promise<any> }> {
  const [receiverKey, verifierKey] = await Promise.all([identity(receiver), identity(overlay)])
  const { publicKey: derived } = await sender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })
  const pkh = Hash.hash160(Utils.toArray(derived, 'hex'))
  const source = new Transaction()
  source.addOutput({ lockingScript: new MandalaToken().lock(assetId, 100, pkh), satoshis: 1 })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  for (const amount of amounts) tx.addOutput({ lockingScript: new MandalaToken().lock(assetId, amount, pkh), satoshis: 1 })
  tx.addOutput({ lockingScript: new P2PKH().lock(Hash.hash160(Utils.toArray('01', 'hex'))), satoshis: 500 })
  const linkageFor = async (counterparty: ProtoWallet): Promise<any> =>
    await sender.revealSpecificKeyLinkage({ counterparty: await identity(counterparty), verifier: verifierKey, protocolID, keyID })
  return { tx, linkageFor }
}

const run = async (tx: Transaction, payload: MandalaLinkagePayload): Promise<{ outputsToAdmit: number[] }> =>
  await manager.identifyAdmissibleOutputs(tx.toBEEF(), [0], encodeLinkagePayload(payload)) as any

describe('MandalaTopicManager rejects any token output without a verified linkage', () => {
  it('names the reason exactly as the wire contract does', () => {
    expect(unlinkedTokenReason(3)).toBe('output 3: MandalaToken-decodable output with no verified linkage')
  })

  it('admits a transfer whose every token output is linked', async () => {
    const { tx, linkageFor } = await transfer([60, 40])
    const linkage = await linkageFor(receiver)
    const res = await run(tx, { inputs: [], outputs: [{ index: 0, linkage }, { index: 1, linkage }] })
    expect(res.outputsToAdmit).toEqual([0, 1])
  })

  it('rejects when one token output has no linkage, even though its siblings verify', async () => {
    const { tx, linkageFor } = await transfer([60, 40])
    const linkage = await linkageFor(receiver)
    await expect(run(tx, { inputs: [], outputs: [{ index: 0, linkage }] }))
      .rejects.toThrow(unlinkedTokenReason(1))
  })

  it('rejects a linkage that verifies to a key other than the one the output is locked to', async () => {
    const { tx, linkageFor } = await transfer([100])
    const wrongParty = await linkageFor(other)
    await expect(run(tx, { inputs: [], outputs: [{ index: 0, linkage: wrongParty }] }))
      .rejects.toThrow(unlinkedTokenReason(0))
  })

  it('rejects a malformed linkage the verifier cannot open', async () => {
    const { tx, linkageFor } = await transfer([100])
    const linkage = await linkageFor(receiver)
    const garbled = { ...linkage, encryptedLinkage: [1, 2, 3] }
    await expect(run(tx, { inputs: [], outputs: [{ index: 0, linkage: garbled }] }))
      .rejects.toThrow(unlinkedTokenReason(0))
  })

  it('leaves plain, non-token outputs out of the rule', async () => {
    const { tx, linkageFor } = await transfer([100])
    const linkage = await linkageFor(receiver)
    // Output 1 is ordinary P2PKH change with no linkage: not this rule's business.
    const res = await run(tx, { inputs: [], outputs: [{ index: 0, linkage }] })
    expect(res.outputsToAdmit).toEqual([0])
  })
})
