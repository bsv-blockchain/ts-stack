import { TopicManager } from '@bsv/overlay'
import { AdmittanceInstructions, Transaction } from '@bsv/sdk'
import { TokenIssuerPolicy } from '../admission/issuerPolicy.js'

export interface DecodedTokenOutput<N extends number | bigint> {
  index: number
  key: string
  amount: N
}

/**
 * Shared admission machinery for structural, value-conservation-gated token
 * topic managers (STAS / BSV-21 / DSTAS). The three token types differ only in
 * how an output is decoded and how amounts are added/compared (number vs.
 * bigint); conservation checking, issuer-policy gating, and the top-level
 * try/catch are identical, so they live here once.
 */
export abstract class BaseTokenTopicManager<N extends number | bigint> implements TopicManager {
  constructor (protected readonly issuerPolicy: TokenIssuerPolicy = {}) {}

  protected abstract readonly zero: N
  protected abstract readonly logLabel: string

  protected abstract decodeOutputs (tx: Transaction): Array<DecodedTokenOutput<N>>
  protected abstract inputTotals (tx: Transaction, previousCoins: number[]): Map<string, N>
  protected abstract add (a: N, b: N): N
  protected abstract gt (a: N, b: N): boolean

  /** Rejects only on inflation: outputs exceeding inputs for a key with inputs. */
  private conservationHolds (outputs: Array<DecodedTokenOutput<N>>, inTotals: Map<string, N>): boolean {
    const outTotals = new Map<string, N>()
    for (const o of outputs) outTotals.set(o.key, this.add(outTotals.get(o.key) ?? this.zero, o.amount))
    for (const [key, outAmt] of outTotals) {
      const inAmt = inTotals.get(key) ?? this.zero
      if (this.gt(inAmt, this.zero) && this.gt(outAmt, inAmt)) return false
    }
    return true
  }

  /**
   * Drop issuance outputs the issuer policy rejects. An output is an issuance
   * when no input carries its key; transfers are untouched. With no policy,
   * every issuance passes (permissionless default).
   */
  private applyIssuerPolicy (outputs: Array<DecodedTokenOutput<N>>, inTotals: Map<string, N>): Array<DecodedTokenOutput<N>> {
    const allow = this.issuerPolicy.allowIssuance
    if (allow === undefined) return outputs
    return outputs.filter(o => {
      const isIssuance = (inTotals.get(o.key) ?? this.zero) === this.zero
      return !isIssuance || allow(o.key)
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
      console.warn(`[${this.logLabel}] identifyAdmissibleOutputs failed: ${String(error)}`)
      return { outputsToAdmit: [], coinsToRetain: [] }
    }
  }

  abstract getDocumentation (): Promise<string>
  abstract getMetaData (): Promise<{ name: string, shortDescription: string }>
}
