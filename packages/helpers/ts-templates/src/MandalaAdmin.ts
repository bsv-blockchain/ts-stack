import {
  WalletInterface, WalletProtocol, WalletCounterparty, Hash, Utils,
  LockingScript, UnlockingScript, OP, ScriptTemplateUnlock, Transaction,
  TransactionSignature, Signature
} from '@bsv/sdk'
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
  pubKeyHash: number[]
}

export interface MandalaAdminLockParams {
  wallet: WalletInterface
  data: MandalaActionDetails
  counterparty?: WalletCounterparty
  originator?: string
}

export interface MandalaAdminUnlockParams extends MandalaAdminLockParams {
  signOutputs?: 'all' | 'none' | 'single'
  anyoneCanPay?: boolean
}

// The admin-auth output is a standard P2PKH. There is no on-chain identifier;
// admin outputs are classified by the off-chain action payload. The locking key
// is wallet-derived: keyID = commitment(data), so the output is bound to a
// specific action. counterparty defaults to 'self' (self-locked, self-spent);
// passing another party's identity key transfers admin rights to them.
export const ADMIN_PROTOCOL: WalletProtocol = [2, 'mandala admin']

const canon = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  const keys = Object.keys(value).sort((a, b) => {
    if (a < b) return -1
    if (a > b) return 1
    return 0
  })
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canon((value as Record<string, unknown>)[k])).join(',') + '}'
}

export class MandalaAdmin {
  static canonicalize (actionDetails: MandalaActionDetails): string {
    return canon(actionDetails)
  }

  static commitment (actionDetails: MandalaActionDetails): string {
    return Utils.toHex(Hash.sha256(Utils.toArray(MandalaAdmin.canonicalize(actionDetails), 'utf8')))
  }

  // Build a P2PKH locking script bound to the action `data`. The locking key is
  // getPublicKey({ counterparty }) with the default forSelf:false (the standard
  // BRC-29 counterparty-child derivation). For counterparty:'self' the derivation
  // is symmetric; for a transfer it is the new admin's child key. The matching
  // private key is recovered by unlock() via createSignature({ counterparty }).
  static async lock (params: MandalaAdminLockParams): Promise<LockingScript> {
    const { wallet, data, counterparty = 'self', originator } = params
    const keyID = MandalaAdmin.commitment(data)
    const { publicKey } = await wallet.getPublicKey({ protocolID: ADMIN_PROTOCOL, keyID, counterparty }, originator)
    const pubKeyHash = Hash.hash160(Utils.toArray(publicKey, 'hex'))
    return new LockingScript([
      { op: OP.OP_DUP },
      { op: OP.OP_HASH160 },
      { op: pubKeyHash.length, data: pubKeyHash },
      { op: OP.OP_EQUALVERIFY },
      { op: OP.OP_CHECKSIG }
    ])
  }

  static decode (script: LockingScript): MandalaAdminDecoded {
    const c = script.chunks
    if (c.length !== 5) throw new Error('not a MandalaAdmin script: wrong chunk count')
    if (c[0].op !== OP.OP_DUP || c[1].op !== OP.OP_HASH160 || c[3].op !== OP.OP_EQUALVERIFY || c[4].op !== OP.OP_CHECKSIG) {
      throw new Error('not a MandalaAdmin script: bad P2PKH shape')
    }
    const pubKeyHash = c[2].data
    if (pubKeyHash?.length !== 20) throw new Error('not a MandalaAdmin script: bad pubKeyHash')
    return { pubKeyHash }
  }

  static unlock (params: MandalaAdminUnlockParams): ScriptTemplateUnlock {
    const { wallet, data, counterparty = 'self', originator, signOutputs = 'all', anyoneCanPay = false } = params
    return {
      sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
        const { preimage, scope } = buildSighashPreimage(tx, inputIndex, signOutputs, anyoneCanPay)

        const keyID = MandalaAdmin.commitment(data)
        const { signature: bareSignature } = await wallet.createSignature({
          hashToDirectlySign: Hash.hash256(preimage),
          protocolID: ADMIN_PROTOCOL,
          keyID,
          counterparty
        }, originator)
        const signature = Signature.fromDER([...bareSignature])
        const txSignature = new TransactionSignature(signature.r, signature.s, scope)
        const sigForScript = txSignature.toChecksigFormat()

        // The signature was made with derivePrivateKey(counterparty); its matching
        // public key is the forSelf:true derivation, which equals the key the lock
        // hashed (BRC-42 symmetry). Push it so OP_HASH160 / OP_CHECKSIG pass.
        const { publicKey } = await wallet.getPublicKey({ protocolID: ADMIN_PROTOCOL, keyID, counterparty, forSelf: true }, originator)
        const pubkey = Utils.toArray(publicKey, 'hex')
        return new UnlockingScript([
          { op: sigForScript.length, data: sigForScript },
          { op: pubkey.length, data: pubkey }
        ])
      },
      estimateLength: async (_tx?: Transaction, _inputIndex?: number) => 108
    }
  }
}
