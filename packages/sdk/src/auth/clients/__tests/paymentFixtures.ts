import Transaction from '../../../transaction/Transaction.js'
import Script from '../../../script/Script.js'
import { toBase64 } from '../../../primitives/utils.js'
import type { CreateActionArgs, CreateActionResult } from '../../../wallet/Wallet.interfaces.js'

/** Real Atomic BEEF keeps retry tests sensitive to the wire validation boundary. */
export function paymentActionResult(args: CreateActionArgs): Promise<CreateActionResult> {
  // Execute immediately but turn construction errors into wallet-style Promise rejections.
  return new Promise(resolve => {
    if (args.options?.sendWith !== undefined) {
      resolve({
        sendWithResults: args.options.sendWith.map(txid => ({ txid, status: 'unproven' as const }))
      })
      return
    }
    const source = new Transaction()
    source.addOutput({ satoshis: 1000, lockingScript: Script.fromASM('OP_TRUE') })
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    tx.addOutput({
      satoshis: args.outputs![0].satoshis,
      lockingScript: Script.fromHex(args.outputs![0].lockingScript)
    })
    resolve({ txid: tx.id('hex'), tx: tx.toAtomicBEEF() })
  })
}

const legacy = new Transaction()
legacy.addOutput({ satoshis: 5, lockingScript: Script.fromASM('OP_TRUE') })
export const legacyPaymentBase64 = toBase64(legacy.toAtomicBEEF())
