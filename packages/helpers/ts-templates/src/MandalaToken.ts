import { ScriptTemplate, LockingScript, UnlockingScript, OP, Transaction } from '@bsv/sdk'
import {
  createMinimallyEncodedScriptChunk, encodeScriptNum, decodeScriptNum,
  encodeAssetId, decodeAssetId, MARKER
} from './mandala-encoding.js'

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

  unlock (): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: () => Promise<number>
  } {
    throw new Error('Unlock is not supported for MandalaToken scripts')
  }

  static decode (script: LockingScript): MandalaTokenDecoded {
    const c = script.chunks
    if (c.length !== 10) throw new Error('not a MandalaToken script: wrong chunk count')
    const marker = c[0].data ?? []
    if (marker.length !== 1 || marker[0] !== MARKER) throw new Error('not a MandalaToken script: missing marker')
    if (c[3].op !== OP.OP_2DROP || c[4].op !== OP.OP_DROP) throw new Error('not a MandalaToken script: bad drops')
    if (c[5].op !== OP.OP_DUP || c[6].op !== OP.OP_HASH160 || c[8].op !== OP.OP_EQUALVERIFY || c[9].op !== OP.OP_CHECKSIG) {
      throw new Error('not a MandalaToken script: bad P2PKH tail')
    }
    const assetId = decodeAssetId(vt(c[1].data))
    const amount = decodeScriptNum(c[2].data ?? [])
    if (!Number.isInteger(amount) || amount < 1) throw new Error('not a MandalaToken script: bad amount')
    const pubKeyHash = vt(c[7].data)
    if (pubKeyHash.length !== 20) throw new Error('not a MandalaToken script: bad pubKeyHash')
    return { assetId, amount, pubKeyHash }
  }
}
