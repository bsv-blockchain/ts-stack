import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Beef, LockingScript, PushDrop, Transaction, Utils } from '@bsv/sdk'
import docs from './BTMSTopicManagerDocs.js'

interface PreviousUTXO {
  txid: string
  outputIndex: number
  lockingScript: LockingScript
  coinIndex: number
}

interface AssetAllowance {
  amount: number
  metadata: string | undefined
}

/**
 * Implements a topic manager for BTMS token management
 * @public
 */
export default class BTMSTopicManager implements TopicManager {
  private isLikelySignatureField(field: number[]): boolean {
    if (field.length < 40) {
      return false
    }
    const asText = Utils.toUTF8(field)
    const roundTrip = Utils.toArray(asText, 'utf8')
    if (roundTrip.length !== field.length) {
      return true
    }
    let printable = 0
    for (const code of asText) {
      const codePoint = code.codePointAt(0) ?? 0
      if (
        (codePoint >= 32 && codePoint <= 126) ||
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13
      ) {
        printable += 1
      }
    }
    return printable / Math.max(asText.length, 1) < 0.8
  }

  private decodeToken(
    lockingScript: LockingScript
  ): { assetIdField: string; amount: number; metadata?: string } | undefined {
    const decoded = PushDrop.decode(lockingScript)
    if (decoded.fields.length < 2 || decoded.fields.length > 4) {
      return undefined
    }
    const assetIdField = Utils.toUTF8(decoded.fields[0])
    const amount = this.parseTokenAmount(Utils.toUTF8(decoded.fields[1]))
    if (amount === undefined) {
      return undefined
    }

    let metadata: string | undefined
    if (decoded.fields.length === 3) {
      if (!this.isLikelySignatureField(decoded.fields[2])) {
        metadata = Utils.toUTF8(decoded.fields[2])
      }
    } else if (decoded.fields.length === 4) {
      metadata = Utils.toUTF8(decoded.fields[2])
    }

    return { assetIdField, amount, metadata }
  }

  private canonicalAssetId(assetIdField: string, txid: string, outputIndex: number): string {
    if (assetIdField === 'ISSUE') {
      return `${txid}.${outputIndex}`
    }
    return assetIdField
  }

  private parseTokenAmount(raw: string): number | undefined {
    const amount = Number(raw)
    if (!Number.isInteger(amount) || amount < 1) {
      return undefined
    }
    return amount
  }

  private collectPreviousUTXOs(
    transaction: Transaction,
    beef: Beef,
    previousCoins: number[]
  ): PreviousUTXO[] {
    const previousUTXOs: PreviousUTXO[] = []
    for (const coinIndex of previousCoins) {
      const input = transaction.inputs[coinIndex]
      if (input == null) continue

      let sourceTransaction = input.sourceTransaction
      const sourceTxid = sourceTransaction?.id('hex') ?? input.sourceTXID
      if (sourceTransaction == null && sourceTxid != null) {
        sourceTransaction = beef.findTxid(sourceTxid)?.tx
      }
      if (sourceTransaction == null || sourceTxid == null) continue

      const sourceOutput = sourceTransaction.outputs[input.sourceOutputIndex]
      if (sourceOutput?.lockingScript == null) continue
      previousUTXOs.push({
        txid: sourceTxid,
        outputIndex: input.sourceOutputIndex,
        lockingScript: sourceOutput.lockingScript,
        coinIndex
      })
    }
    return previousUTXOs
  }

  private collectAssetAllowances(previousUTXOs: PreviousUTXO[]): Map<string, AssetAllowance> {
    const allowances = new Map<string, AssetAllowance>()
    for (const previous of previousUTXOs) {
      try {
        const token = this.decodeToken(previous.lockingScript)
        if (token === undefined) continue
        const assetId = this.canonicalAssetId(
          token.assetIdField,
          previous.txid,
          previous.outputIndex
        )
        const existing = allowances.get(assetId)
        if (existing === undefined) {
          allowances.set(assetId, { amount: token.amount, metadata: token.metadata })
        } else {
          existing.amount += token.amount
        }
      } catch (error) {
        console.log(
          `[BTMSTopicManager] Failed to decode previous UTXO ${previous.txid}.${previous.outputIndex}:`,
          error
        )
      }
    }
    return allowances
  }

  private collectAdmissibleOutputs(
    transaction: Transaction,
    allowances: Map<string, AssetAllowance>
  ): number[] {
    const outputsToAdmit: number[] = []
    const assetTotals = new Map<string, number>()
    for (const [index, output] of transaction.outputs.entries()) {
      try {
        const token = this.decodeToken(output.lockingScript)
        if (token === undefined) continue
        if (token.assetIdField === 'ISSUE') {
          outputsToAdmit.push(index)
          continue
        }

        const total = (assetTotals.get(token.assetIdField) ?? 0) + token.amount
        assetTotals.set(token.assetIdField, total)
        const allowance = allowances.get(token.assetIdField)
        if (allowance === undefined) continue
        if (total > allowance.amount) continue
        if (allowance.metadata !== token.metadata) continue
        outputsToAdmit.push(index)
      } catch (error) {
        console.debug(`[BTMSTopicManager] Skipping output ${index}: ${error}`)
      }
    }
    return outputsToAdmit
  }

  private outputContainsAsset(
    transaction: Transaction,
    outputsToAdmit: Set<number>,
    transactionId: string,
    assetId: string
  ): boolean {
    for (const [index, output] of transaction.outputs.entries()) {
      if (!outputsToAdmit.has(index)) continue
      try {
        const token = this.decodeToken(output.lockingScript)
        if (token === undefined) continue
        if (this.canonicalAssetId(token.assetIdField, transactionId, index) === assetId) return true
      } catch {
        // Output script is not a valid BTMS token; exclude from matching.
      }
    }
    return false
  }

  private collectRetainedCoins(
    previousUTXOs: PreviousUTXO[],
    transaction: Transaction,
    outputsToAdmit: number[]
  ): number[] {
    const coinsToRetain: number[] = []
    const admittedOutputIndexes = new Set(outputsToAdmit)
    const transactionId = transaction.id('hex')
    for (const previous of previousUTXOs) {
      try {
        const token = this.decodeToken(previous.lockingScript)
        if (token === undefined) continue
        const assetId = this.canonicalAssetId(
          token.assetIdField,
          previous.txid,
          previous.outputIndex
        )
        if (this.outputContainsAsset(transaction, admittedOutputIndexes, transactionId, assetId)) {
          coinsToRetain.push(previous.coinIndex)
        }
      } catch (error) {
        console.debug(
          `[BTMSTopicManager] Skipping previous coin ${previous.txid}.${previous.outputIndex}: ${error}`
        )
      }
    }
    return coinsToRetain
  }

  /**
   * Returns the outputs from the transaction that are admissible.
   * @param beef - The transaction data in BEEF format
   * @param previousCoins - The previous coins to consider (indices into the BEEF's input transactions)
   * @returns A promise that resolves with the admittance instructions
   */
  async identifyAdmissibleOutputs(
    beef: number[],
    previousCoins: number[]
  ): Promise<AdmittanceInstructions> {
    try {
      const parsedTransaction = Transaction.fromBEEF(beef)
      const beefObj = Beef.fromBinary(beef)
      if (!Array.isArray(parsedTransaction.outputs)) {
        throw new TypeError('Missing parameter: outputs')
      }
      const previousUTXOs = this.collectPreviousUTXOs(parsedTransaction, beefObj, previousCoins)
      const allowances = this.collectAssetAllowances(previousUTXOs)
      const outputsToAdmit = this.collectAdmissibleOutputs(parsedTransaction, allowances)
      const coinsToRetain = this.collectRetainedCoins(
        previousUTXOs,
        parsedTransaction,
        outputsToAdmit
      )
      const coinsRemoved = previousCoins.filter(coinIndex => !coinsToRetain.includes(coinIndex))

      return {
        outputsToAdmit,
        coinsToRetain,
        coinsRemoved
      }
    } catch (error) {
      console.warn(`[BTMSTopicManager] identifyAdmissibleOutputs failed: ${error}`)
      return {
        outputsToAdmit: [],
        coinsToRetain: [],
        coinsRemoved: []
      }
    }
  }

  /**
   * Returns the documentation for the tokenization protocol
   */
  async getDocumentation(): Promise<string> {
    return docs
  }

  /**
   * Get metadata about the topic manager
   * @returns A promise that resolves to an object containing metadata
   */
  async getMetaData(): Promise<{
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }> {
    return {
      name: 'BTMS Topic Manager',
      shortDescription: 'Basic Token Management System for UTXO-based tokens'
    }
  }
}
