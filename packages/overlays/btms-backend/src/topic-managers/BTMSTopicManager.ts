import { AdmittanceInstructions, TopicManager } from '@bsv/overlay'
import { Beef, LockingScript, PushDrop, Transaction, Utils } from '@bsv/sdk'
import docs from '../docs/BTMSTopicManagerDocs.js'

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
      const codePoint = code.charCodeAt(0)
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

  private decodeToken(lockingScript: LockingScript): { assetIdField: string, amount: number, metadata?: string } | undefined {
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

  /**
   * Returns the outputs from the transaction that are admissible.
   * @param beef - The transaction data in BEEF format
   * @param previousCoins - The previous coins to consider (indices into the BEEF's input transactions)
   * @returns A promise that resolves with the admittance instructions
   */
  async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []
    const coinsToRetain: number[] = []
    const coinsRemoved: number[] = []

    try {
      const parsedTransaction = Transaction.fromBEEF(beef)
      const beefObj = Beef.fromBinary(beef)

      // Validate params
      if (!Array.isArray(parsedTransaction.outputs)) {
        throw new Error('Missing parameter: outputs')
      }

      // Build previous UTXOs from BEEF data for coins we're spending
      interface PreviousUTXO {
        txid: string
        outputIndex: number
        lockingScript: LockingScript
        coinIndex: number
      }
      const previousUTXOs: PreviousUTXO[] = []

      // Parse BEEF to get source transactions for previous coins
      for (const coinIndex of previousCoins) {
        const input = parsedTransaction.inputs[coinIndex]
        if (!input) continue

        // Get source transaction from input (primary path)
        let sourceTx = input.sourceTransaction
        const sourceTxid = sourceTx?.id('hex') ?? input.sourceTXID

        // Fallback: look up source transaction in the BEEF by txid
        if (!sourceTx && sourceTxid) {
          sourceTx = beefObj.findTxid(sourceTxid)?.tx
        }

        if (!sourceTx || !sourceTxid) continue

        const sourceOutputIndex = input.sourceOutputIndex
        const sourceOutput = sourceTx.outputs[sourceOutputIndex]

        if (sourceOutput?.lockingScript) {
          previousUTXOs.push({
            txid: sourceTxid,
            outputIndex: sourceOutputIndex,
            lockingScript: sourceOutput.lockingScript,
            coinIndex
          })
        }
      }

      // First, we build an object with the assets we are allowed to spend.
      // For each asset, we track the amount we are allowed to spend.
      // It is valid to spend any asset issuance output, with the full amount of the issuance.
      // It is also valid to spend any output with an asset ID, and we add those together across all the previous UTXOs to get the total amount for that asset.
      const maxNumberOfEachAsset: Record<string, { amount: number, metadata: string | undefined }> = {}

      for (const p of previousUTXOs) {
        try {
          const decodedToken = this.decodeToken(p.lockingScript)
          if (decodedToken === undefined) {
            continue
          }
          const assetId = this.canonicalAssetId(decodedToken.assetIdField, p.txid, p.outputIndex)
          const amount = decodedToken.amount
          const metadata = decodedToken.metadata

          // Track the amounts for previous UTXOs
          if (!maxNumberOfEachAsset[assetId]) {
            maxNumberOfEachAsset[assetId] = {
              amount,
              metadata
            }
          } else {
            maxNumberOfEachAsset[assetId].amount += amount
          }
        } catch (e) {
          console.log(`[BTMSTopicManager] Failed to decode previous UTXO ${p.txid}.${p.outputIndex}:`, e)
          continue
        }
      }

      // For each output, it is valid as long as either:
      // 1. It is an issuance of a new asset, or
      // 2. The total for that asset does not exceed what's allowed
      // We need an object to track totals for each asset
      const assetTotals: Record<string, number> = {}
      const txid = parsedTransaction.id('hex')

      for (const [i, output] of parsedTransaction.outputs.entries()) {
        try {
          const decodedToken = this.decodeToken(output.lockingScript)
          if (decodedToken === undefined) {
            continue
          }
          const assetId = decodedToken.assetIdField
          const amount = decodedToken.amount

          // Issuance outputs are always valid
          if (assetId === 'ISSUE') {
            outputsToAdmit.push(i)
            continue
          }

          // Initialize the asset at 0 if necessary
          if (!assetTotals[assetId]) {
            assetTotals[assetId] = 0
          }

          // Add the amount for this asset
          assetTotals[assetId] += amount

          // Validate the amount and metadata
          const metadata = decodedToken.metadata
          if (!maxNumberOfEachAsset[assetId]) {
            continue
          }
          if (assetTotals[assetId] > maxNumberOfEachAsset[assetId].amount) {
            continue
          }
          if (maxNumberOfEachAsset[assetId].metadata !== metadata) {
            continue
          }
          outputsToAdmit.push(i)
        } catch (e) {
          continue
        }
      }

      // Determine which previous coins to retain
      for (const p of previousUTXOs) {
        try {
          const decodedPrevious = this.decodeToken(p.lockingScript)
          if (decodedPrevious === undefined) {
            continue
          }
          const assetId = this.canonicalAssetId(decodedPrevious.assetIdField, p.txid, p.outputIndex)

          // Assets included in the inputs but not the admitted outputs are not retained, otherwise they are.
          const assetInOutputs = parsedTransaction.outputs.some((x, i) => {
            if (!outputsToAdmit.includes(i)) {
              return false
            }
            try {
              const decodedCurrent = this.decodeToken(x.lockingScript)
              if (decodedCurrent === undefined) {
                return false
              }
              const outputAssetId = this.canonicalAssetId(decodedCurrent.assetIdField, txid, i)
              return outputAssetId === assetId
            } catch {
              return false
            }
          })

          if (assetInOutputs) {
            coinsToRetain.push(p.coinIndex)
          }
        } catch {
          continue
        }
      }
      coinsRemoved.push(...previousCoins.filter((coinIndex) => !coinsToRetain.includes(coinIndex)))

      return {
        outputsToAdmit,
        coinsToRetain,
        coinsRemoved
      }
    } catch (error) {
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
