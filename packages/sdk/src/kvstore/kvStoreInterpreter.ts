import Transaction from '../transaction/Transaction.js'
import { InterpreterFunction } from '../overlay-tools/Historian.js'
import { WalletProtocol } from '../wallet/Wallet.interfaces.js'
import { decodeAndVerifyKVStoreToken } from './kvStoreTokenValidation.js'

export interface KVContext {
  key: string
  protocolID: WalletProtocol
  controller: string
}

/**
 * KVStore interpreter used by Historian.
 *
 * Validates the KVStore PushDrop tokens: [protocolID, key, value, controller, signature] (old format)
 * or [protocolID, key, value, controller, tags, signature] (new format).
 * Filters outputs by the provided key in the interpreter context.
 * Produces the plaintext value for matching outputs; returns undefined otherwise.
 *
 * @param transaction - The transaction to inspect.
 * @param outputIndex - The index of the output within transaction.outputs.
 * @param ctx - { key: string, protocolID: WalletProtocol } — per-call context specifying which key to match.
 *
 * @returns string | undefined — the decoded KV value if the output is a valid KVStore token for the
 *   given key; otherwise undefined.
 */
export const kvStoreInterpreter: InterpreterFunction<string, KVContext> = async (
  transaction: Transaction,
  outputIndex: number,
  ctx?: KVContext
): Promise<string | undefined> => {
  try {
    const output = transaction.outputs[outputIndex]
    if (output?.lockingScript == null) return undefined
    if (ctx?.key == null || ctx.controller == null) return undefined

    const decoded = await decodeAndVerifyKVStoreToken(output.lockingScript)

    // Only return values for the given key and protocolID
    if (
      decoded.key !== ctx.key ||
      decoded.protocolIDText !== JSON.stringify(ctx.protocolID) ||
      decoded.controller.toLowerCase() !== ctx.controller.toLowerCase()
    ) {
      return undefined
    }
    return decoded.value
  } catch {
    // Skip non-KVStore outputs or malformed tokens
    return undefined
  }
}
