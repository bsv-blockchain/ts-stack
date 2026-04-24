import { PushDrop } from '../script/index.js'
import Transaction from '../transaction/Transaction.js'
import * as Utils from '../primitives/utils.js'
import { kvProtocol } from './types.js'
import { InterpreterFunction } from '../overlay-tools/Historian.js'
import { WalletProtocol } from '../wallet/Wallet.interfaces.js'

export interface KVContext { key: string, protocolID: WalletProtocol }

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
export const kvStoreInterpreter: InterpreterFunction<string, KVContext> = async (transaction: Transaction, outputIndex: number, ctx?: KVContext): Promise<string | undefined> => {
  try {
    const output = transaction.outputs[outputIndex]
    if (output == null || output.lockingScript == null) return undefined
    if (ctx == null || ctx.key == null) return undefined

    // Decode the KVStore token
    const decoded = PushDrop.decode(output.lockingScript)

    // Support backwards compatibility: old format without tags, new format with tags
    const expectedFieldCount = Object.keys(kvProtocol).length
    const hasTagsField = decoded.fields.length === expectedFieldCount
    const isOldFormat = decoded.fields.length === expectedFieldCount - 1

    if (!isOldFormat && !hasTagsField) return undefined

    // Only return values for the given key and protocolID
    const key = Utils.toUTF8(decoded.fields[kvProtocol.key])
    const protocolID = Utils.toUTF8(decoded.fields[kvProtocol.protocolID])
    if (key !== ctx.key || protocolID !== JSON.stringify(ctx.protocolID)) return undefined
    try {
      return Utils.toUTF8(decoded.fields[kvProtocol.value])
    } catch {
      return undefined
    }
  } catch {
    // Skip non-KVStore outputs or malformed tokens
    return undefined
  }
}
