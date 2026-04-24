// import { BTMS } from './BTMS.js'
// import { BTMSToken } from './BTMSToken.js'
// import { parseCustomInstructions } from './utils.js'
// import {
//   BTMS_TOPIC,
//   BTMS_LABEL,
//   getAssetBasket
// } from './constants.js'
// import type {
//   PubKeyHex,
//   TXIDHexString,
//   HexString,
//   OutpointString,
//   LabelStringUnder300Bytes,
//   OutputTagStringUnder300Bytes,
//   PositiveIntegerOrZero,
//   CreateActionArgs,
//   CreateActionOutput
// } from '@bsv/sdk'
// import { Transaction, Utils, Random, Beef, TopicBroadcaster } from '@bsv/sdk'
// import type {
//   TransferSplitOptions,
//   TransferTransaction,
//   MultiTransactionTransfer,
//   AcceptResult,
//   BTMSTokenOutput
// } from './types.js'

// /**
//  * NOTE: THIS IS NOT COMPLETE! Send and receive need to use proper BEEF handling, and not use AtomicBEEF.
//  * BTMSAdvanced extends BTMS with advanced privacy features.
//  * 
//  * Provides multi-transaction token transfers that split payments across
//  * multiple independent transactions for enhanced privacy.
//  */
// export class BTMSAdvanced extends BTMS {
//   /**
//    * Send tokens to a recipient split across multiple transactions for privacy.
//    * 
//    * Creates multiple independent transactions, each containing a portion of the
//    * total amount. All transactions share the same derivation prefix but have
//    * unique suffixes, allowing the recipient to receive them as a single logical
//    * transfer.
//    * 
//    * @param assetId - The asset to send
//    * @param recipient - Recipient's identity public key
//    * @param amount - Total amount to send
//    * @param options - Split options including transaction count and distribution
//    * @returns Result with all transaction details and merged BEEF for recipient
//    */
//   async sendSplit(
//     assetId: string,
//     recipient: PubKeyHex,
//     amount: number,
//     options: TransferSplitOptions = {}
//   ): Promise<{ success: boolean; transfer?: MultiTransactionTransfer; error?: string }> {
//     try {
//       const {
//         transactionCount = 2,
//         distribution = 'equal',
//         minAmountPerTx = 1
//       } = options

//       // Validate inputs
//       if (!BTMSToken.isValidAssetId(assetId)) {
//         throw new Error(`Invalid assetId: ${assetId}`)
//       }
//       if (amount < 1 || !Number.isInteger(amount)) {
//         throw new Error('Amount must be a positive integer')
//       }
//       if (transactionCount < 1) {
//         throw new Error('Transaction count must be at least 1')
//       }
//       if (amount < transactionCount * minAmountPerTx) {
//         throw new Error(`Cannot split ${amount} into ${transactionCount} transactions with minimum ${minAmountPerTx} each`)
//       }

//       // Calculate amounts for each transaction
//       const txAmounts = this.computeSplitAmounts(amount, transactionCount, distribution, minAmountPerTx)

//       // Get sender identity
//       const senderKey = await this.getIdentityKey()
//       const isSendingToSelf = senderKey === recipient

//       // Fetch spendable UTXOs for this asset
//       const { tokens: utxos } = await this.getSpendableTokens(assetId)
//       if (utxos.length === 0) {
//         throw new Error(`No spendable tokens found for asset ${assetId}`)
//       }

//       // Select and verify UTXOs on the overlay for total amount
//       const { selected, totalInput, inputBeef } = await this.selectAndVerifyUTXOs(utxos, amount)
//       if (totalInput < amount) {
//         throw new Error(`Insufficient balance on overlay. Have ${totalInput}, need ${amount}`)
//       }

//       // Get metadata from first selected UTXO
//       const metadata = selected[0].token.metadata

//       // Shared derivation prefix for all outputs in this transfer
//       const sharedDerivationPrefix = Utils.toBase64(Random(32))

//       // Track transactions and merged BEEF
//       const transactions: TransferTransaction[] = []
//       const mergedBeef = new Beef()
//       mergedBeef.mergeBeef(inputBeef)

//       // Track remaining UTXOs and change for chaining
//       let remainingUtxos = [...selected]
//       let remainingInput = totalInput

//       const basket = getAssetBasket(assetId)

//       // Create each transaction
//       for (let txIndex = 0; txIndex < txAmounts.length; txIndex++) {
//         const txAmount = txAmounts[txIndex]
//         const isLastTx = txIndex === txAmounts.length - 1

//         // Generate unique suffix for this transaction's recipient output
//         const recipientDerivationSuffix = Utils.toBase64(Random(32))
//         const recipientKeyID = `${sharedDerivationPrefix} ${recipientDerivationSuffix}`

//         // Build outputs for this transaction
//         const outputs: CreateActionOutput[] = []

//         // Recipient output
//         const recipientScript = await this['tokenTemplate'].createTransfer(
//           assetId,
//           txAmount,
//           recipientKeyID,
//           isSendingToSelf ? 'self' : recipient,
//           metadata
//         )
//         const recipientScriptHex = recipientScript.toHex() as HexString

//         outputs.push({
//           satoshis: this['config'].tokenSatoshis,
//           lockingScript: recipientScriptHex,
//           customInstructions: JSON.stringify({
//             derivationPrefix: sharedDerivationPrefix,
//             derivationSuffix: recipientDerivationSuffix
//           }),
//           outputDescription: `Send ${txAmount} tokens (${txIndex + 1}/${txAmounts.length})`,
//           tags: ['btms_transfer', 'btms_split'] as OutputTagStringUnder300Bytes[],
//           ...(isSendingToSelf ? { basket } : {})
//         })

//         // Calculate change for this transaction
//         const changeAmount = remainingInput - txAmount

//         if (changeAmount > 0 && !isLastTx) {
//           // Create change output that will be used as input for next transaction
//           const changeDerivationSuffix = Utils.toBase64(Random(32))
//           const changeKeyID = `${sharedDerivationPrefix} ${changeDerivationSuffix}`

//           const changeScript = await this['tokenTemplate'].createTransfer(
//             assetId,
//             changeAmount,
//             changeKeyID,
//             'self',
//             metadata
//           )

//           outputs.push({
//             satoshis: this['config'].tokenSatoshis,
//             lockingScript: changeScript.toHex(),
//             customInstructions: JSON.stringify({
//               derivationPrefix: sharedDerivationPrefix,
//               derivationSuffix: changeDerivationSuffix
//             }),
//             basket,
//             outputDescription: `Split change: ${changeAmount} tokens`,
//             tags: ['btms_change', 'btms_split'] as OutputTagStringUnder300Bytes[]
//           })
//         } else if (changeAmount > 0 && isLastTx) {
//           // Final change goes back to sender normally
//           const changeDerivationSuffix = Utils.toBase64(Random(32))
//           const changeKeyID = `${sharedDerivationPrefix} ${changeDerivationSuffix}`

//           const changeScript = await this['tokenTemplate'].createTransfer(
//             assetId,
//             changeAmount,
//             changeKeyID,
//             'self',
//             metadata
//           )

//           outputs.push({
//             satoshis: this['config'].tokenSatoshis,
//             lockingScript: changeScript.toHex(),
//             customInstructions: JSON.stringify({
//               derivationPrefix: sharedDerivationPrefix,
//               derivationSuffix: changeDerivationSuffix
//             }),
//             basket,
//             outputDescription: `Final change: ${changeAmount} tokens`,
//             tags: ['btms_change'] as OutputTagStringUnder300Bytes[]
//           })
//         }

//         // Build inputs from remaining UTXOs
//         const inputs = remainingUtxos.map(u => ({
//           outpoint: u.outpoint as OutpointString,
//           unlockingScriptLength: 74,
//           inputDescription: `Spend ${u.token.amount} tokens`
//         }))

//         // Create the action
//         const createArgs: CreateActionArgs = {
//           description: `Split send ${txAmount} tokens (${txIndex + 1}/${txAmounts.length})`,
//           labels: [BTMS_LABEL as LabelStringUnder300Bytes],
//           inputBEEF: inputBeef.toBinary(),
//           inputs,
//           outputs,
//           options: {
//             acceptDelayedBroadcast: false,
//             randomizeOutputs: false
//           }
//         }

//         const { signableTransaction } = await this['config'].wallet.createAction(createArgs, this['originator'])
//         if (!signableTransaction) {
//           throw new Error(`Failed to create transaction ${txIndex + 1}`)
//         }

//         // Sign all inputs
//         const txForSigning = Transaction.fromAtomicBEEF(signableTransaction.tx)
//         const spends: Record<number, { unlockingScript: string }> = {}

//         for (let i = 0; i < remainingUtxos.length; i++) {
//           const utxo = remainingUtxos[i]
//           const { keyID, senderIdentityKey } = parseCustomInstructions(utxo.customInstructions, utxo.txid, utxo.outputIndex)
//           const counterparty = senderIdentityKey ?? 'self'
//           const unlocker = this['tokenTemplate'].createUnlocker(counterparty, keyID)
//           const unlockingScript = await unlocker.sign(txForSigning, i)
//           spends[i] = { unlockingScript: unlockingScript.toHex() }
//         }

//         // Sign the action
//         const signResult = await this['config'].wallet.signAction({
//           reference: signableTransaction.reference,
//           spends
//         }, this['originator'])

//         if (!signResult.tx) {
//           throw new Error(`Failed to sign transaction ${txIndex + 1}`)
//         }

//         const finalTx = Transaction.fromAtomicBEEF(signResult.tx)
//         const txid = finalTx.id('hex') as TXIDHexString

//         // Broadcast to overlay
//         const broadcaster = new TopicBroadcaster([BTMS_TOPIC], {
//           networkPreset: this['config'].networkPreset
//         })
//         const broadcastResult = await broadcaster.broadcast(finalTx)

//         if (broadcastResult.status !== 'success') {
//           throw new Error(`Broadcast failed for transaction ${txIndex + 1}`)
//         }

//         // Merge this transaction's BEEF
//         mergedBeef.mergeBeef(Beef.fromBinary(signResult.tx))

//         // Record this transaction
//         transactions.push({
//           txid,
//           outputIndex: 0,
//           amount: txAmount,
//           lockingScript: recipientScriptHex,
//           derivationSuffix: recipientDerivationSuffix
//         })

//         // Update remaining for next iteration
//         remainingInput = changeAmount
//         // For simplicity, we're creating independent transactions
//         // In a more sophisticated version, we could chain them
//       }

//       // Build the multi-transaction transfer for recipient
//       const transfer: MultiTransactionTransfer = {
//         derivationPrefix: sharedDerivationPrefix,
//         assetId,
//         totalAmount: amount,
//         metadata,
//         transactions,
//         beef: mergedBeef.toBinary()
//       }

//       // Send to recipient via comms layer (if configured and not sending to self)
//       if (this['config'].comms && !isSendingToSelf) {
//         await this['config'].comms.sendMessage({
//           recipient,
//           messageBox: this['config'].messageBox,
//           body: JSON.stringify(transfer)
//         })
//       }

//       return { success: true, transfer }
//     } catch (error) {
//       return {
//         success: false,
//         error: error instanceof Error ? error.message : 'Unknown error'
//       }
//     }
//   }

//   /**
//    * Accept a multi-transaction token transfer.
//    * 
//    * Handles transfers that were split across multiple transactions for privacy.
//    * Verifies and internalizes all transactions, using the shared derivation
//    * prefix and individual suffixes to reconstruct the keys.
//    * 
//    * @param transfer - The multi-transaction transfer to accept
//    * @returns Accept result with total amount received
//    */
//   async acceptMulti(transfer: MultiTransactionTransfer): Promise<AcceptResult> {
//     try {
//       const { derivationPrefix, assetId, transactions, beef } = transfer

//       if (transactions.length === 0) {
//         throw new Error('No transactions in transfer')
//       }

//       const basket = getAssetBasket(assetId)
//       let totalAccepted = 0

//       // Process each transaction in the transfer
//       for (const tx of transactions) {
//         // Verify the token exists on the overlay
//         const { found: isOnOverlay } = await this.lookupTokenOnOverlay(tx.txid, tx.outputIndex)

//         // Re-broadcast if not on overlay
//         if (!isOnOverlay && beef) {
//           const transaction = Transaction.fromBEEF(beef)
//           const broadcaster = new TopicBroadcaster([BTMS_TOPIC], {
//             networkPreset: this['config'].networkPreset
//           })
//           const response = await broadcaster.broadcast(transaction)
//           if (response.status !== 'success') {
//             throw new Error(`Token ${tx.txid}.${tx.outputIndex} not found on overlay and broadcast failed!`)
//           }
//         }

//         // Build customInstructions for this specific output
//         const customInstructions = JSON.stringify({
//           derivationPrefix,
//           derivationSuffix: tx.derivationSuffix
//         })

//         // Internalize this transaction's output
//         await this['config'].wallet.internalizeAction({
//           tx: beef,
//           labels: [BTMS_LABEL],
//           outputs: [
//             {
//               outputIndex: tx.outputIndex as PositiveIntegerOrZero,
//               protocol: 'basket insertion',
//               insertionRemittance: {
//                 basket,
//                 customInstructions,
//                 tags: ['btms_received', 'btms_split'] as OutputTagStringUnder300Bytes[]
//               }
//             }
//           ],
//           description: `Receive ${tx.amount} tokens (split transfer)`,
//           seekPermission: true
//         }, this['originator'])

//         totalAccepted += tx.amount
//       }

//       return {
//         success: true,
//         assetId,
//         amount: totalAccepted
//       }
//     } catch (error) {
//       return {
//         success: false,
//         assetId: transfer.assetId,
//         amount: transfer.totalAmount,
//         error: error instanceof Error ? error.message : 'Unknown error'
//       }
//     }
//   }

//   /**
//    * Compute how to split an amount across multiple transactions.
//    */
//   private computeSplitAmounts(
//     totalAmount: number,
//     count: number,
//     distribution: 'equal' | 'random',
//     minAmount: number
//   ): number[] {
//     if (distribution === 'equal') {
//       const perTx = Math.floor(totalAmount / count)
//       const remainder = totalAmount - (perTx * count)
//       const amounts = Array(count).fill(perTx)
//       // Add remainder to last transaction
//       amounts[count - 1] += remainder
//       return amounts
//     }

//     // Random distribution using logarithmic distribution
//     const amounts: number[] = []
//     let remaining = totalAmount - (count * minAmount)

//     for (let i = 0; i < count - 1; i++) {
//       const portion = this.benfordNumber(0, remaining)
//       amounts.push(minAmount + portion)
//       remaining -= portion
//     }
//     amounts.push(minAmount + remaining)

//     // Shuffle for unpredictability
//     for (let i = amounts.length - 1; i > 0; i--) {
//       const j = Math.floor(Math.random() * (i + 1))
//         ;[amounts[i], amounts[j]] = [amounts[j], amounts[i]]
//     }

//     return amounts
//   }

//   /**
//    * Generate a logarithmically-distributed random number.
//    */
//   private benfordNumber(min: number, max: number): number {
//     if (max <= min) return min
//     const d = Math.floor(Math.random() * 9) + 1
//     return Math.floor(min + ((max - min) * Math.log10(1 + 1 / d)) / Math.log10(10))
//   }
// }
