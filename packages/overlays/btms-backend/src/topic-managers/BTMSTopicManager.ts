import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Beef, LockingScript, PushDrop, Transaction, Utils } from '@bsv/sdk'
import docs from '../docs/BTMSTopicManagerDocs.js'

interface PreviousUTXO {
  txid: string
  outputIndex: number
  lockingScript: LockingScript
  coinIndex: number
}

type AssetAllowances = Record<string, { amount: number; metadata: string | undefined }>

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
    if (!/^[1-9]\d*$/.test(raw)) {
      return undefined
    }
    const amount = Number(raw)
    if (!Number.isSafeInteger(amount)) {
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
      if (!input) continue

      let sourceTransaction = input.sourceTransaction
      const sourceTxid = sourceTransaction?.id('hex') ?? input.sourceTXID
      if (!sourceTransaction && sourceTxid) {
        sourceTransaction = beef.findTxid(sourceTxid)?.tx
      }
      if (!sourceTransaction || !sourceTxid) continue

      const outputIndex = input.sourceOutputIndex
      const lockingScript = sourceTransaction.outputs[outputIndex]?.lockingScript
      if (!lockingScript) continue

      previousUTXOs.push({ coinIndex, lockingScript, outputIndex, txid: sourceTxid })
    }

    return previousUTXOs
  }

  private buildAssetAllowances(previousUTXOs: PreviousUTXO[]): AssetAllowances {
    const allowances: AssetAllowances = {}

    for (const previous of previousUTXOs) {
      try {
        const token = this.decodeToken(previous.lockingScript)
        if (token === undefined) continue

        const assetId = this.canonicalAssetId(
          token.assetIdField,
          previous.txid,
          previous.outputIndex
        )
        const existing = allowances[assetId]
        if (existing) {
          existing.amount += token.amount
        } else {
          allowances[assetId] = { amount: token.amount, metadata: token.metadata }
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

  private collectAdmissibleOutputIndexes(
    transaction: Transaction,
    allowances: AssetAllowances
  ): number[] {
    const outputIndexes: number[] = []
    const assetTotals: Record<string, number> = {}

    for (const [outputIndex, output] of transaction.outputs.entries()) {
      try {
        const token = this.decodeToken(output.lockingScript)
        if (token === undefined) continue
        if (token.assetIdField === 'ISSUE') {
          outputIndexes.push(outputIndex)
          continue
        }

        const assetId = token.assetIdField
        const total = (assetTotals[assetId] ?? 0) + token.amount
        assetTotals[assetId] = total
        const allowance = allowances[assetId]
        if (
          allowance !== undefined &&
          total <= allowance.amount &&
          allowance.metadata === token.metadata
        ) {
          outputIndexes.push(outputIndex)
        }
      } catch (error) {
        console.debug(`[BTMSTopicManager] Skipping output ${outputIndex}: ${error}`)
      }
    }

    return outputIndexes
  }

  private collectAdmittedAssetIds(
    transaction: Transaction,
    outputIndexes: number[],
    txid: string
  ): Set<string> {
    const assetIds = new Set<string>()

    for (const outputIndex of outputIndexes) {
      const output = transaction.outputs[outputIndex]
      if (!output) continue
      try {
        const token = this.decodeToken(output.lockingScript)
        if (token !== undefined) {
          assetIds.add(this.canonicalAssetId(token.assetIdField, txid, outputIndex))
        }
      } catch {
        // An output accepted earlier can only become undecodable through malformed mutable input.
      }
    }

    return assetIds
  }

  private collectRetainedCoinIndexes(
    previousUTXOs: PreviousUTXO[],
    admittedAssetIds: Set<string>
  ): number[] {
    const coinIndexes: number[] = []

    for (const previous of previousUTXOs) {
      try {
        const token = this.decodeToken(previous.lockingScript)
        if (token === undefined) continue
        const assetId = this.canonicalAssetId(
          token.assetIdField,
          previous.txid,
          previous.outputIndex
        )
        if (admittedAssetIds.has(assetId)) {
          coinIndexes.push(previous.coinIndex)
        }
      } catch (error) {
        console.debug(
          `[BTMSTopicManager] Skipping previous coin ${previous.txid}.${previous.outputIndex}: ${error}`
        )
      }
    }

    return coinIndexes
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
      const transaction = Transaction.fromBEEF(beef)

      if (!Array.isArray(transaction.outputs)) {
        throw new TypeError('Missing parameter: outputs')
      }

      const previousUTXOs = this.collectPreviousUTXOs(
        transaction,
        Beef.fromBinary(beef),
        previousCoins
      )
      const allowances = this.buildAssetAllowances(previousUTXOs)
      const outputsToAdmit = this.collectAdmissibleOutputIndexes(transaction, allowances)
      const admittedAssetIds = this.collectAdmittedAssetIds(
        transaction,
        outputsToAdmit,
        transaction.id('hex')
      )
      const coinsToRetain = this.collectRetainedCoinIndexes(previousUTXOs, admittedAssetIds)
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
