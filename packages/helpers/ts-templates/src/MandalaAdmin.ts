import { WalletInterface, WalletProtocol, Hash, Utils } from '@bsv/sdk'

export type MandalaActionKind = 'register' | 'issue' | 'redeem' | 'recover'

export interface MandalaActionDetails {
  kind: MandalaActionKind
  assetId?: string
  amount?: number
  priorOutpoint?: string
  [k: string]: unknown
}

const canon = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']'
  const keys = Object.keys(value as Record<string, unknown>).sort()
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
}
