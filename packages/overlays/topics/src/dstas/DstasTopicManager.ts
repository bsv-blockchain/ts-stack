import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, Transaction } from '@bsv/sdk'
import { DstasToken } from '@bsv/templates'
import docs from './DstasTopicDocs.md.js'

interface DstasOutput { index: number, tokenId: string, amount: number }

/**
 * Topic manager for DSTAS (Divisible STAS / STAS 3.0) token transfers.
 *
 * DSTAS has no public third-party indexer, so this overlay is its discovery
 * surface. Admissibility is structural: each output is decoded against the
 * DSTAS template, and the transaction is admitted only when per-tokenId value
 * conservation holds. DSTAS is satoshi-denominated, so the token amount is the
 * output's satoshi value.
 *
 * Deliberate simplifications (matching the STAS overlay): no freeze/confiscation
 * authority verification and no off-chain dependency — a tx with no DSTAS inputs
 * for a tokenId is treated as issuance and admitted; a tx that would inflate a
 * token is rejected in full.
 */
export class DstasTopicManager implements TopicManager {
  private decodeOutputs (tx: Transaction): DstasOutput[] {
    const outputs: DstasOutput[] = []
    for (let i = 0; i < tx.outputs.length; i++) {
      try {
        const { tokenId } = DstasToken.decode(tx.outputs[i].lockingScript)
        outputs.push({ index: i, tokenId, amount: tx.outputs[i].satoshis ?? 0 })
      } catch {
        // not a DSTAS output — ignore
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
        const { tokenId } = DstasToken.decode(src.lockingScript)
        inTotals.set(tokenId, (inTotals.get(tokenId) ?? 0) + (src.satoshis ?? 0))
      } catch { /* non-DSTAS previous coin */ }
    }
    return inTotals
  }

  /** Rejects only on inflation: outputs exceeding inputs for a token with inputs. */
  private conservationHolds (outputs: DstasOutput[], inTotals: Map<string, number>): boolean {
    const outTotals = new Map<string, number>()
    for (const o of outputs) outTotals.set(o.tokenId, (outTotals.get(o.tokenId) ?? 0) + o.amount)
    for (const [tokenId, outAmt] of outTotals) {
      const inAmt = inTotals.get(tokenId) ?? 0
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
      const outputs = this.decodeOutputs(tx)
      if (outputs.length === 0) return { outputsToAdmit: [], coinsToRetain: [] }

      const inTotals = this.inputTotals(tx, previousCoins)
      if (!this.conservationHolds(outputs, inTotals)) {
        return { outputsToAdmit: [], coinsToRetain: [] }
      }

      return {
        outputsToAdmit: outputs.map(o => o.index).sort((a, b) => a - b),
        coinsToRetain: previousCoins
      }
    } catch (error) {
      console.warn(`[DstasTopicManager] identifyAdmissibleOutputs failed: ${String(error)}`)
      return { outputsToAdmit: [], coinsToRetain: [] }
    }
  }

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
