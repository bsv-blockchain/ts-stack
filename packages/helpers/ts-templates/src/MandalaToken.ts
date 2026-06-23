import {
  ScriptTemplate, ScriptTemplateUnlock, LockingScript, UnlockingScript, OP, Utils,
  WalletInterface, WalletProtocol, WalletCounterparty, Transaction, Hash,
  TransactionSignature, PrivateKey
} from '@bsv/sdk'
import {
  createMinimallyEncodedScriptChunk, encodeScriptNum, decodeScriptNumChunk,
  encodeAssetId, decodeAssetId, MARKER
} from './mandala-encoding.js'
import { buildSighashPreimage } from './mandala-signing.js'

// Local helper since Utils.verifyTruthy is not available in @bsv/sdk
const vt = <T>(v: T | undefined | null): T => {
  if (v == null) throw new Error('missing chunk data')
  return v
}

export interface MandalaTokenDecoded {
  assetId: string
  amount: number
  pubKeyHash: number[]
}

export class MandalaToken implements ScriptTemplate {
  wallet?: WalletInterface
  originator?: string

  constructor (wallet?: WalletInterface, originator?: string) {
    this.wallet = wallet
    this.originator = originator
  }

  async lockBRC29 (
    assetId: string,
    amount: number,
    protocolID: WalletProtocol,
    keyID: string,
    counterparty: WalletCounterparty
  ): Promise<LockingScript> {
    if (this.wallet == null) throw new Error('lockBRC29 requires a wallet')
    const { publicKey } = await this.wallet.getPublicKey({ protocolID, keyID, counterparty }, this.originator)
    const pubKeyHash = Hash.hash160(Utils.toArray(publicKey, 'hex'))
    return this.lock(assetId, amount, pubKeyHash)
  }

  lock (assetId: string, amount: number, pubKeyHash: number[]): LockingScript {
    if (pubKeyHash.length !== 20) throw new Error('pubKeyHash must be 20 bytes')
    if (!Number.isInteger(amount) || amount < 1) throw new Error('amount must be a positive integer')
    const assetIdBytes = encodeAssetId(assetId)
    return new LockingScript([
      createMinimallyEncodedScriptChunk([MARKER]),
      createMinimallyEncodedScriptChunk(assetIdBytes),
      createMinimallyEncodedScriptChunk(encodeScriptNum(amount)),
      { op: OP.OP_2DROP },
      { op: OP.OP_DROP },
      { op: OP.OP_DUP },
      { op: OP.OP_HASH160 },
      { op: pubKeyHash.length, data: pubKeyHash },
      { op: OP.OP_EQUALVERIFY },
      { op: OP.OP_CHECKSIG }
    ])
  }

  unlock (
    privateKey: PrivateKey,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay = false
  ): ScriptTemplateUnlock {
    return {
      sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
        const { preimage, scope } = buildSighashPreimage(tx, inputIndex, signOutputs, anyoneCanPay)

        const rawSignature = privateKey.sign(Hash.sha256(preimage))
        const sig = new TransactionSignature(rawSignature.r, rawSignature.s, scope)
        const sigForScript = sig.toChecksigFormat()
        const pubkeyForScript = privateKey.toPublicKey().encode(true) as number[]
        return new UnlockingScript([
          { op: sigForScript.length, data: sigForScript },
          { op: pubkeyForScript.length, data: pubkeyForScript }
        ])
      },
      estimateLength: async (tx?: Transaction, inputIndex?: number) => 108
    }
  }

  static decode (script: LockingScript): MandalaTokenDecoded {
    const c = script.chunks
    if (c.length !== 10) throw new Error('not a MandalaToken script: wrong chunk count')
    const marker = c[0].data ?? []
    if (c[0].op !== 1 || marker.length !== 1 || marker[0] !== MARKER) throw new Error('not a MandalaToken script: missing marker')
    if (c[3].op !== OP.OP_2DROP || c[4].op !== OP.OP_DROP) throw new Error('not a MandalaToken script: bad drops')
    if (c[5].op !== OP.OP_DUP || c[6].op !== OP.OP_HASH160 || c[8].op !== OP.OP_EQUALVERIFY || c[9].op !== OP.OP_CHECKSIG) {
      throw new Error('not a MandalaToken script: bad P2PKH tail')
    }
    const assetId = decodeAssetId(vt(c[1].data))
    const amount = decodeScriptNumChunk(c[2])
    if (!Number.isInteger(amount) || amount < 1) throw new Error('not a MandalaToken script: bad amount')
    const pubKeyHash = vt(c[7].data)
    if (pubKeyHash.length !== 20) throw new Error('not a MandalaToken script: bad pubKeyHash')
    return { assetId, amount, pubKeyHash }
  }
}
