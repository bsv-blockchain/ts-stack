import { MandalaTopicManager } from '../MandalaTopicManager.js'
import { InMemoryScreeningProvider, encodeLinkagePayload, MandalaTokenRecord } from '../types.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import { MandalaToken } from '@bsv/templates'
import { ProtoWallet, PrivateKey, Transaction, Hash, Utils, WalletProtocol, Script, P2PKH } from '@bsv/sdk'

// Who is spending a token input is named from the owner this topic bound when
// it admitted the coin. An input linkage, when supplied, is a PROOF: it must
// reconstruct the very key locking the coin and agree with the stored owner.

const protocolID: WalletProtocol = [2, 'mandala token']
const keyID = 'tkn'
const assetId = `${'a'.repeat(64)}.0`

const spender = new ProtoWallet(PrivateKey.fromRandom())
const payer = new ProtoWallet(PrivateKey.fromRandom())
const receiver = new ProtoWallet(PrivateKey.fromRandom())
const overlay = new ProtoWallet(PrivateKey.fromRandom())
const stranger = new ProtoWallet(PrivateKey.fromRandom())

const identity = async (w: ProtoWallet): Promise<string> => (await w.getPublicKey({ identityKey: true })).publicKey
const pkhOf = (key: string): number[] => Hash.hash160(Utils.toArray(key, 'hex'))

interface Built {
  tm: MandalaTopicManager
  beef: number[]
  inputLinkage: any
  outputLinkage: any
  previousCoins: number[]
}

/**
 * A transfer that spends one 100-unit coin locked to the SPENDER's own child
 * key (derived against `payer`) and re-creates 100 units for `receiver`.
 * `coinKey` overrides what the spent coin is locked to; `rows` is what the
 * store remembers about the spent coin; `extraP2pkhInput` adds a plain
 * (non-token) input the engine also names in previousCoins.
 */
async function build (opts: {
  coinKey?: string
  rows?: Record<string, MandalaTokenRecord>
  sanctioned?: string[]
  extraP2pkhInput?: boolean
} = {}): Promise<Built> {
  const [payerKey, receiverKey, verifierKey] = await Promise.all([identity(payer), identity(receiver), identity(overlay)])
  const { publicKey: ownChildKey } = await spender.getPublicKey({ protocolID, keyID, counterparty: payerKey, forSelf: true })
  const { publicKey: receiverChildKey } = await spender.getPublicKey({ protocolID, keyID, counterparty: receiverKey })

  const source = new Transaction()
  source.addOutput({ lockingScript: new MandalaToken().lock(assetId, 100, pkhOf(opts.coinKey ?? ownChildKey)), satoshis: 1 })
  if (opts.extraP2pkhInput === true) {
    source.addOutput({ lockingScript: new P2PKH().lock(pkhOf(payerKey)), satoshis: 500 })
  }

  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() })
  if (opts.extraP2pkhInput === true) {
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 1, sequence: 0xffffffff, unlockingScript: new Script() })
  }
  tx.addOutput({ lockingScript: new MandalaToken().lock(assetId, 100, pkhOf(receiverChildKey)), satoshis: 1 })

  const inputLinkage = await spender.revealSpecificKeyLinkage({ counterparty: payerKey, verifier: verifierKey, protocolID, keyID })
  const outputLinkage = await spender.revealSpecificKeyLinkage({ counterparty: receiverKey, verifier: verifierKey, protocolID, keyID })

  const sourceId = source.id('hex')
  const rows = opts.rows ?? { [`${sourceId}.0`]: { txid: sourceId, outputIndex: 0, assetId, amount: 100, identityKey: await identity(spender), createdAt: new Date() } }
  const tm = new MandalaTopicManager({
    verifierWallet: overlay as any,
    screeningProvider: new InMemoryScreeningProvider(opts.sanctioned ?? []),
    adminWallet: overlay as any,
    adminProtocolID: [2, 'mandala admin'],
    stateStore: {
      getAssetState: async () => defaultAssetState(assetId),
      getTokenRow: async (t: string, i: number) => rows[`${t}.${i}`] ?? null,
      isAdminOutpoint: async () => true
    }
  })
  return { tm, beef: tx.toBEEF(), inputLinkage, outputLinkage, previousCoins: opts.extraP2pkhInput === true ? [0, 1] : [0] }
}

const ownerRow = (identityKey: string, outpoint: string): MandalaTokenRecord =>
  ({ txid: outpoint.split('.')[0], outputIndex: 0, assetId, amount: 100, identityKey, createdAt: new Date() })

const payloadWith = (b: Built, withInputLinkage: boolean): number[] =>
  encodeLinkagePayload({
    inputs: withInputLinkage ? [{ index: 0, linkage: b.inputLinkage }] : [],
    outputs: [{ index: 0, linkage: b.outputLinkage }]
  })

describe('MandalaTopicManager spend identity', () => {
  it('screens the stored spender after optional linkage verification', async () => {
    const spenderKey = await identity(spender)
    const clean = await build()
    expect((await clean.tm.identifyAdmissibleOutputs(clean.beef, clean.previousCoins, payloadWith(clean, true))).outputsToAdmit).toEqual([0])

    // The same transfer, with the spender sanctioned: only a resolved spender
    // identity can make this reject.
    const flagged = await build({ sanctioned: [spenderKey] })
    await expect(flagged.tm.identifyAdmissibleOutputs(flagged.beef, flagged.previousCoins, payloadWith(flagged, true)))
      .rejects.toThrow('sanctioned')
  })

  it('accepts a linkage that agrees with the stored owner, case-insensitively', async () => {
    const spenderKey = await identity(spender)
    // The row key is the spent outpoint; recompute it from a built tx (the
    // source is deterministic across builds).
    const tx = Transaction.fromBEEF((await build()).beef)
    const outpoint = `${tx.inputs[0].sourceTXID ?? tx.inputs[0].sourceTransaction?.id('hex') ?? ''}.0`
    const b2 = await build({ rows: { [outpoint]: ownerRow(spenderKey.toUpperCase(), outpoint) } })
    expect((await b2.tm.identifyAdmissibleOutputs(b2.beef, b2.previousCoins, payloadWith(b2, true))).outputsToAdmit).toEqual([0])
  })

  it('rejects a linkage that does not control the coin being spent', async () => {
    // The coin is locked to a stranger's key; the spender's own reveal cannot reconstruct it.
    const b = await build({ coinKey: await identity(stranger) })
    await expect(b.tm.identifyAdmissibleOutputs(b.beef, b.previousCoins, payloadWith(b, true)))
      .rejects.toThrow('linkage does not control the coin being spent')
  })

  it('rejects a linkage that names a party other than the stored owner', async () => {
    const tx = Transaction.fromBEEF((await build()).beef)
    const outpoint = `${tx.inputs[0].sourceTXID ?? tx.inputs[0].sourceTransaction?.id('hex') ?? ''}.0`
    const b = await build({ rows: { [outpoint]: ownerRow(await identity(stranger), outpoint) } })
    await expect(b.tm.identifyAdmissibleOutputs(b.beef, b.previousCoins, payloadWith(b, true)))
      .rejects.toThrow('but the coin is owned by')
  })

  it('without a linkage, screens the stored owner and rejects missing ownership', async () => {
    const strangerKey = await identity(stranger)
    const tx = Transaction.fromBEEF((await build()).beef)
    const outpoint = `${tx.inputs[0].sourceTXID ?? tx.inputs[0].sourceTransaction?.id('hex') ?? ''}.0`

    // Stored owner is sanctioned: rejected even though no linkage was supplied.
    const owned = await build({ rows: { [outpoint]: ownerRow(strangerKey, outpoint) }, sanctioned: [strangerKey] })
    await expect(owned.tm.identifyAdmissibleOutputs(owned.beef, owned.previousCoins, payloadWith(owned, false)))
      .rejects.toThrow('sanctioned')

    const unknown = await build({ rows: {}, sanctioned: [strangerKey] })
    for (const withLinkage of [false, true]) {
      await expect(unknown.tm.identifyAdmissibleOutputs(unknown.beef, unknown.previousCoins, payloadWith(unknown, withLinkage)))
        .rejects.toThrow('missing verified owner')
    }
  })

  it('ignores a previous coin that is not a token output', async () => {
    const b = await build({ extraP2pkhInput: true })
    expect((await b.tm.identifyAdmissibleOutputs(b.beef, b.previousCoins, payloadWith(b, true))).outputsToAdmit).toEqual([0])
  })
  it('rejects blank owner identities in stored rows', async () => {
    const tx = Transaction.fromBEEF((await build()).beef)
    const outpoint = `${tx.inputs[0].sourceTXID ?? tx.inputs[0].sourceTransaction?.id('hex') ?? ''}.0`
    for (const identityKey of ['', '  ']) {
      const b = await build({ rows: { [outpoint]: ownerRow(identityKey, outpoint) } })
      await expect(b.tm.identifyAdmissibleOutputs(b.beef, b.previousCoins, payloadWith(b, false)))
        .rejects.toThrow('missing verified owner')
    }
  })

  it('rejects inconsistent stored token metadata', async () => {
    const tx = Transaction.fromBEEF((await build()).beef)
    const outpoint = `${tx.inputs[0].sourceTXID ?? tx.inputs[0].sourceTransaction?.id('hex') ?? ''}.0`
    const row = ownerRow(await identity(spender), outpoint)
    for (const changed of [{ txid: 'different' }, { outputIndex: 1 }, { assetId: 'different' }, { amount: 101 }]) {
      const b = await build({ rows: { [outpoint]: { ...row, ...changed } } })
      await expect(b.tm.identifyAdmissibleOutputs(b.beef, b.previousCoins, payloadWith(b, false)))
        .rejects.toThrow('stored token metadata does not match')
    }
  })

})
