import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, Transaction } from '@bsv/sdk'
import { Bsv21Token } from '@bsv/templates'
import { TokenIssuerPolicy } from '../admission/issuerPolicy.js'
import docs from './Bsv21TopicDocs.md.js'

interface Bsv21Output { index: number, tokenId: string, amount: bigint }

/**
 * Topic manager for BSV-21 (1Sat ordinals-style) fungible tokens.
 *
 * Admissibility is structural: each output is decoded against the BSV-21
 * ord-envelope shape, and the transaction is admitted only when per-tokenId
 * value conservation holds on the divisible bigint amounts. A transaction that
 * would inflate a token is rejected in full.
 *
 * tokenId resolution: a transfer output names its id in the JSON; a mint
 * output's id IS its own outpoint (`<txid>_<vout>`). A mint is therefore an
 * issuance (its tokenId never appears as an input); the optional
 * {@link TokenIssuerPolicy} gates which mints are indexed — note the gated
 * value is the mint's outpoint-based tokenId. Omitted, all mints are admitted.
 */
export class Bsv21TopicManager implements TopicManager {
  constructor (private readonly issuerPolicy: TokenIssuerPolicy = {}) {}

  private outputTokenId (decoded: { id: string, isMint: boolean }, txid: string, index: number): string {
    return decoded.isMint || decoded.id === '' ? `${txid}_${index}` : decoded.id
  }

  private decodeOutputs (tx: Transaction): Bsv21Output[] {
    const txid = tx.id('hex')
    const outputs: Bsv21Output[] = []
    for (let i = 0; i < tx.outputs.length; i++) {
      try {
        const d = Bsv21Token.decode(tx.outputs[i].lockingScript)
        outputs.push({ index: i, tokenId: this.outputTokenId(d, txid, i), amount: BigInt(d.amt) })
      } catch {
        // not a BSV-21 output — ignore
      }
    }
    return outputs
  }

  private inputTotals (tx: Transaction, previousCoins: number[]): Map<string, bigint> {
    const inTotals = new Map<string, bigint>()
    for (const ci of previousCoins) {
      const input = tx.inputs[ci]
      const src = input?.sourceTransaction?.outputs[input.sourceOutputIndex]
      if (src == null) continue
      try {
        const d = Bsv21Token.decode(src.lockingScript)
        const srcTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? ''
        const tokenId = this.outputTokenId(d, srcTxid, input.sourceOutputIndex)
        inTotals.set(tokenId, (inTotals.get(tokenId) ?? 0n) + BigInt(d.amt))
      } catch { /* non-BSV-21 previous coin */ }
    }
    return inTotals
  }

  /** Rejects only on inflation: outputs exceeding inputs for a token with inputs. */
  private conservationHolds (outputs: Bsv21Output[], inTotals: Map<string, bigint>): boolean {
    const outTotals = new Map<string, bigint>()
    for (const o of outputs) outTotals.set(o.tokenId, (outTotals.get(o.tokenId) ?? 0n) + o.amount)
    for (const [tokenId, outAmt] of outTotals) {
      const inAmt = inTotals.get(tokenId) ?? 0n
      if (inAmt > 0n && outAmt > inAmt) return false
    }
    return true
  }

  /**
   * Drop mint (issuance) outputs the issuer policy rejects. A BSV-21 output is a
   * mint when no input carries its tokenId; transfers are untouched. With no
   * policy, every mint passes (permissionless default).
   */
  private applyIssuerPolicy (outputs: Bsv21Output[], inTotals: Map<string, bigint>): Bsv21Output[] {
    const allow = this.issuerPolicy.allowIssuance
    if (allow === undefined) return outputs
    return outputs.filter(o => {
      const isIssuance = (inTotals.get(o.tokenId) ?? 0n) === 0n
      return !isIssuance || allow(o.tokenId)
    })
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

      const admissible = this.applyIssuerPolicy(outputs, inTotals)
      return {
        outputsToAdmit: admissible.map(o => o.index).sort((a, b) => a - b),
        coinsToRetain: previousCoins
      }
    } catch (error) {
      console.warn(`[Bsv21TopicManager] identifyAdmissibleOutputs failed: ${String(error)}`)
      return { outputsToAdmit: [], coinsToRetain: [] }
    }
  }

  async getDocumentation (): Promise<string> {
    return docs
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string }> {
    return {
      name: 'tm_bsv21',
      shortDescription: 'BSV-21 (1Sat) fungible-token transfers admitted by inscription validity and value conservation.'
    }
  }
}
