import {
  WalletInterface, WalletProtocol, Hash, Utils,
  LockingScript, UnlockingScript, OP, ScriptTemplateUnlock, Transaction,
  TransactionSignature, Signature
} from '@bsv/sdk'
import { createMinimallyEncodedScriptChunk, MARKER } from './mandala-encoding.js'
import { buildSighashPreimage } from './mandala-signing.js'

export type MandalaActionKind = 'register' | 'issue' | 'redeem' | 'recover'

export interface MandalaActionDetails {
  kind: MandalaActionKind
  assetId?: string
  amount?: number
  priorOutpoint?: string
  [k: string]: unknown
}

export interface MandalaAdminDecoded {
  boundKey: string
}

const canon = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon((value as Record<string, unknown>)[k])).join(',') + '}'
}

export class MandalaAdmin {
  wallet: WalletInterface
  originator?: string

  constructor (wallet: WalletInterface, originator?: string) {
    this.wallet = wallet
    this.originator = originator
  }

  static canonicalize (actionDetails: MandalaActionDetails): string {
    return canon(actionDetails)
  }

  static commitment (actionDetails: MandalaActionDetails): string {
    return Utils.toHex(Hash.sha256(Utils.toArray(MandalaAdmin.canonicalize(actionDetails), 'utf8')))
  }

  async deriveBoundKey (
    protocolID: WalletProtocol,
    actionDetails: MandalaActionDetails
  ): Promise<{ boundKey: string, keyID: string }> {
    const keyID = MandalaAdmin.commitment(actionDetails)
    const { publicKey } = await this.wallet.getPublicKey({ protocolID, keyID, counterparty: 'anyone' }, this.originator)
    return { boundKey: publicKey, keyID }
  }

  lock (boundKey: string): LockingScript {
    const keyBytes = Utils.toArray(boundKey, 'hex')
    if (keyBytes.length !== 33) throw new Error('boundKey must be a 33-byte compressed public key')
    return new LockingScript([
      createMinimallyEncodedScriptChunk([MARKER]),
      { op: OP.OP_DROP },
      { op: keyBytes.length, data: keyBytes },
      { op: OP.OP_CHECKSIG }
    ])
  }

  static decode (script: LockingScript): MandalaAdminDecoded {
    const c = script.chunks
    if (c.length !== 4) throw new Error('not a MandalaAdmin script: wrong chunk count')
    const marker = c[0].data ?? []
    if (c[0].op !== 1 || marker.length !== 1 || marker[0] !== MARKER) throw new Error('not a MandalaAdmin script: missing marker')
    if (c[1].op !== OP.OP_DROP || c[3].op !== OP.OP_CHECKSIG) throw new Error('not a MandalaAdmin script: bad shape')
    const keyData = c[2].data
    if (keyData?.length !== 33) throw new Error('not a MandalaAdmin script: bad boundKey')
    return { boundKey: Utils.toHex(keyData) }
  }

  unlock (
    protocolID: WalletProtocol,
    actionDetails: MandalaActionDetails,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay = false
  ): ScriptTemplateUnlock {
    return {
      sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
        const { preimage, scope } = buildSighashPreimage(tx, inputIndex, signOutputs, anyoneCanPay)

        const keyID = MandalaAdmin.commitment(actionDetails)
        const { signature: bareSignature } = await this.wallet.createSignature({
          hashToDirectlySign: Hash.hash256(preimage),
          protocolID,
          keyID,
          counterparty: 'anyone'
        }, this.originator)
        const signature = Signature.fromDER([...bareSignature])
        const txSignature = new TransactionSignature(signature.r, signature.s, scope)
        const sigForScript = txSignature.toChecksigFormat()
        return new UnlockingScript([{ op: sigForScript.length, data: sigForScript }])
      },
      estimateLength: async (_tx?: Transaction, _inputIndex?: number) => 74
    }
  }
}
