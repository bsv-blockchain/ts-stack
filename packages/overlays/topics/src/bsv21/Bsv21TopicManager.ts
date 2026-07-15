import { Transaction } from '@bsv/sdk'
import { Bsv21Token } from '@bsv/templates'
import { BaseTokenTopicManager, DecodedTokenOutput } from '../shared/BaseTokenTopicManager.js'
import docs from './Bsv21TopicDocs.md.js'

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
 * TokenIssuerPolicy gates which mints are indexed — note the gated value is
 * the mint's outpoint-based tokenId. Omitted, all mints are admitted.
 */
export class Bsv21TopicManager extends BaseTokenTopicManager<bigint> {
  protected readonly zero = 0n
  protected readonly logLabel = 'Bsv21TopicManager'

  private outputTokenId (decoded: { id: string, isMint: boolean }, txid: string, index: number): string {
    return decoded.isMint || decoded.id === '' ? `${txid}_${index}` : decoded.id
  }

  protected decodeOutputs (tx: Transaction): Array<DecodedTokenOutput<bigint>> {
    const txid = tx.id('hex')
    const outputs: Array<DecodedTokenOutput<bigint>> = []
    for (let i = 0; i < tx.outputs.length; i++) {
      try {
        const d = Bsv21Token.decode(tx.outputs[i].lockingScript)
        outputs.push({ index: i, key: this.outputTokenId(d, txid, i), amount: BigInt(d.amt) })
      } catch {
        // not a BSV-21 output — ignore
      }
    }
    return outputs
  }

  protected inputTotals (tx: Transaction, previousCoins: number[]): Map<string, bigint> {
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

  protected add (a: bigint, b: bigint): bigint { return a + b }
  protected gt (a: bigint, b: bigint): boolean { return a > b }

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
