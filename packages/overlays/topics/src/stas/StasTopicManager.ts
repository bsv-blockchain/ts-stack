import { Transaction } from '@bsv/sdk'
import { StasToken } from '@bsv/templates'
import { BaseTokenTopicManager, DecodedTokenOutput } from '../shared/BaseTokenTopicManager.js'
import docs from './StasTopicDocs.md.js'

/**
 * Topic manager for classic STAS (legacy P2STAS) token transfers.
 *
 * Admissibility is purely structural: each output is decoded against the STAS
 * locking-script shape, and the transaction is admitted only when per-asset
 * value conservation holds. Classic STAS is satoshi-denominated, so the token
 * amount is the output's satoshi value.
 *
 * Deliberate simplifications vs. tm_mandala (no off-chain dependency):
 *  - no key-linkage verification, no sanctions screening;
 *  - a tx that would inflate a token (outputs > inputs for an asset that has
 *    inputs) is rejected in full.
 *
 * Mint authority is not verifiable on-chain (minting is permissionless). An
 * output with no input of its assetId is an issuance; the optional
 * TokenIssuerPolicy gates which issuances are indexed. Omitted, the overlay
 * stays permissionless (admits all issuances) — the prior behaviour.
 */
export class StasTopicManager extends BaseTokenTopicManager<number> {
  protected readonly zero = 0
  protected readonly logLabel = 'StasTopicManager'

  protected decodeOutputs (tx: Transaction): Array<DecodedTokenOutput<number>> {
    const outputs: Array<DecodedTokenOutput<number>> = []
    for (let i = 0; i < tx.outputs.length; i++) {
      try {
        const { assetId } = StasToken.decode(tx.outputs[i].lockingScript)
        outputs.push({ index: i, key: assetId, amount: tx.outputs[i].satoshis ?? 0 })
      } catch {
        // not a STAS output — ignore
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
        const { assetId } = StasToken.decode(src.lockingScript)
        inTotals.set(assetId, (inTotals.get(assetId) ?? 0) + (src.satoshis ?? 0))
      } catch { /* non-STAS previous coin */ }
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
      name: 'tm_stas',
      shortDescription: 'Classic STAS (P2STAS) token transfers admitted by script validity and value conservation.'
    }
  }
}
