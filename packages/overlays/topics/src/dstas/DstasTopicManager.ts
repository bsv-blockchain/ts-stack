import { Transaction } from '@bsv/sdk'
import { DstasToken } from '@bsv/templates'
import { BaseTokenTopicManager, DecodedTokenOutput } from '../shared/BaseTokenTopicManager.js'
import docs from './DstasTopicDocs.md.js'

/**
 * Topic manager for DSTAS (Divisible STAS / STAS 3.0) token transfers.
 *
 * DSTAS has no public third-party indexer, so this overlay is its discovery
 * surface. Admissibility is structural: each output is decoded against the
 * DSTAS template, and the transaction is admitted only when per-tokenId value
 * conservation holds. DSTAS is satoshi-denominated, so the token amount is the
 * output's satoshi value.
 *
 * Trust model. Transfer correctness (owner signature, conservation, and the
 * freeze rule that a frozen input cannot be spent under a normal transfer) is
 * enforced by Bitcoin Script and verified by miners — the overlay only ever
 * sees SPV-valid transactions, so it does not re-enforce it (protocol study §6).
 * Frozen UTXOs are real on-chain state and stay indexed (discoverable); the
 * lookup service surfaces the frozen flag. The one thing Script does NOT
 * constrain is issuance: minting is permissionless, so any output can claim any
 * protoID. The optional TokenIssuerPolicy gates which issuances are indexed;
 * omitted, the overlay stays permissionless (admits all issuances).
 */
export class DstasTopicManager extends BaseTokenTopicManager<number> {
  protected readonly zero = 0
  protected readonly logLabel = 'DstasTopicManager'

  protected decodeOutputs (tx: Transaction): Array<DecodedTokenOutput<number>> {
    const outputs: Array<DecodedTokenOutput<number>> = []
    for (let i = 0; i < tx.outputs.length; i++) {
      try {
        const { tokenId } = DstasToken.decode(tx.outputs[i].lockingScript)
        outputs.push({ index: i, key: tokenId, amount: tx.outputs[i].satoshis ?? 0 })
      } catch {
        // not a DSTAS output — ignore
      }
    }
    return outputs
  }

  protected inputTotals (tx: Transaction, previousCoins: number[]): Map<string, number> {
    const inTotals = new Map<string, number>()
    for (const ci of previousCoins) {
      const input = tx.inputs[ci]
      const src = input?.sourceTransaction?.outputs[input.sourceOutputIndex]
      if (src == null) continue
      try {
        const { tokenId } = DstasToken.decode(src.lockingScript)
        inTotals.set(tokenId, (inTotals.get(tokenId) ?? 0) + (src.satoshis ?? 0))
      } catch { /* non-DSTAS previous coin */ }
    }
    return inTotals
  }

  protected add (a: number, b: number): number { return a + b }
  protected gt (a: number, b: number): boolean { return a > b }

  async getDocumentation (): Promise<string> {
    return docs
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return {
      name: 'tm_dstas',
      shortDescription: 'DSTAS (Divisible STAS / STAS 3.0) token transfers admitted by script validity and value conservation.'
    }
  }
}
