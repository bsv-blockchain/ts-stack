import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, Transaction } from '@bsv/sdk'
import { StasToken } from '@bsv/templates'
import docs from './StasTopicDocs.md.js'

interface StasOutput { index: number, assetId: string, amount: number, ownerHash160: string }

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
 *  - a tx with no STAS inputs for an asset is treated as issuance and admitted
 *    (mint authority is not verified on-chain in this version);
 *  - a tx that would inflate a token (outputs > inputs for an asset that has
 *    inputs) is rejected in full.
 */
export class StasTopicManager implements TopicManager {
  private decodeStasOutputs (tx: Transaction): StasOutput[] {
    const outputs: StasOutput[] = []
    for (let i = 0; i < tx.outputs.length; i++) {
      try {
        const { assetId, ownerHash160 } = StasToken.decode(tx.outputs[i].lockingScript)
        outputs.push({ index: i, assetId, amount: tx.outputs[i].satoshis ?? 0, ownerHash160 })
      } catch {
        // not a STAS output — ignore
      }
    }
    return outputs
  }

  private inputTotals (tx: Transaction, previousCoins: number[]): Map<string, number> {
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

  /** Rejects only on inflation: outputs exceeding inputs for an asset with inputs. */
  private conservationHolds (stasOutputs: StasOutput[], inTotals: Map<string, number>): boolean {
    const outTotals = new Map<string, number>()
    for (const o of stasOutputs) outTotals.set(o.assetId, (outTotals.get(o.assetId) ?? 0) + o.amount)
    for (const [assetId, outAmt] of outTotals) {
      const inAmt = inTotals.get(assetId) ?? 0
      if (inAmt > 0 && outAmt > inAmt) return false
    }
    return true
  }

  async identifyAdmissibleOutputs (
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    try {
      const tx = Transaction.fromBEEF(beef)
      const stasOutputs = this.decodeStasOutputs(tx)
      if (stasOutputs.length === 0) return { outputsToAdmit: [], coinsToRetain: [] }

      const inTotals = this.inputTotals(tx, previousCoins)
      if (!this.conservationHolds(stasOutputs, inTotals)) {
        return { outputsToAdmit: [], coinsToRetain: [] }
      }

      return {
        outputsToAdmit: stasOutputs.map(o => o.index).sort((a, b) => a - b),
        coinsToRetain: previousCoins
      }
    } catch (error) {
      console.warn(`[StasTopicManager] identifyAdmissibleOutputs failed: ${String(error)}`)
      return { outputsToAdmit: [], coinsToRetain: [] }
    }
  }

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
