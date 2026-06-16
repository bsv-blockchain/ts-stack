import type { Output } from '../Output.js'
import type {
  AdmittedTxRef,
  RawTransactionRecord,
  TopicAnchorTip,
  TopicBlockAnchor
} from '../BASM.js'

/**
 * Represents a transaction that has been applied to a topic.
 */
export interface AppliedTransaction {
  /** TXID of the applied transaction */
  txid: string
  /** Output index of the applied transaction */
  topic: string
  /** Block height of the transaction proof, when known */
  blockHeight?: number
  /** Block hash for the proven transaction's block, when known */
  blockHash?: string
  /** Transaction's canonical in-block index, when known */
  blockIndex?: number
  /** Merkle root computed from the direct proof, when known */
  merkleRoot?: string
  /** Chain height when this transaction was first seen by this overlay */
  firstSeenHeight?: number
  /** Whether this applied transaction has a direct proof of inclusion */
  proven?: boolean
}

export interface StoredTransactionRecord {
  txid: string
  beef?: number[]
  rawTx?: number[]
  merklePath?: number[]
  blockHeight?: number
  blockHash?: string
  blockIndex?: number
  merkleRoot?: string
}

export interface AppliedTransactionProofUpdate {
  txid: string
  topic: string
  blockHeight: number
  blockHash?: string
  blockIndex?: number
  merkleRoot?: string
}

export interface UnprovenAppliedTransactionCandidate {
  txid: string
  topic: string
  firstSeenHeight?: number
  outputs: Array<{ txid: string, outputIndex: number }>
}

/**
 * Defines the Storage Engine interface used internally by the Overlay Services Engine.
 */
export interface Storage {
  /**
   * Adds a new output to storage
   * @param utxo — The output to add
   */
  insertOutput: (utxo: Output) => Promise<void>

  /**
   * Finds an output from storage
   * @param txid — TXID of hte output to find
   * @param outputIndex — Output index for the output to find
   * @param topic — The topic in which the output is stored (optional)
   * @param spent — Whether the output must be spent to be returned (optional)
   * @param includeBEEF — Whether to include the BEEF data for the output (optional)
   */
  findOutput: (txid: string, outputIndex: number, topic?: string, spent?: boolean, includeBEEF?: boolean) => Promise<Output | null>

  /**
   * Finds multiple outputs from storage by txid/output index pairs.
   * Implementations can use this to collapse many point lookups into a single query.
   * @param outpoints — txid/output index pairs to find
   * @param includeBEEF — Whether to include the BEEF data for the outputs (optional)
   */
  findOutputsByOutpoints?: (
    outpoints: Array<{ txid: string, outputIndex: number }>,
    includeBEEF?: boolean
  ) => Promise<Output[]>

  /**
   * Finds outputs with a matching transaction ID from storage
   * @param txid — TXID of the outputs to find
   * @param includeBEEF — Whether to include the BEEF data for the outputs (optional)
   */
  findOutputsForTransaction: (txid: string, includeBEEF?: boolean) => Promise<Output[]>

  /**
   * Finds current UTXOs that have been admitted into a given topic
   * @param topic - The topic for which we want to find Unspent Transaction Outputs (UTXOs).
   * @param since - Optional parameter indicating the minimum score value to retrieve matching UTXOs from. This is used for score-based filtering.
   * @param limit - Optional parameter to limit the number of results returned
   * @param includeBEEF — Whether to include the BEEF data for the outputs (optional)
   * @returns A promise that resolves to an array of matching UTXOs.
   */
  findUTXOsForTopic: (topic: string, since?: number, limit?: number, includeBEEF?: boolean) => Promise<Output[]>

  /**
   * Deletes an output from storage
   * @param txid — The TXID of the output to delete
   * @param outputIndex — The index of the output to delete
   * @param topic — The topic where the output should be deleted
   */
  deleteOutput: (txid: string, outputIndex: number, topic: string) => Promise<void>

  /**
  * Updates a UTXO as spent
  * @param txid — TXID of the output to update
  * @param outputIndex — Index of the output to update
  * @param topic — Topic in which the output should be updated
  */
  markUTXOAsSpent: (txid: string, outputIndex: number, topic: string) => Promise<void>

  /**
  * Updates which outputs are consumed by this output
  * @param txid — TXID of the output to update
  * @param outputIndex — Index of the output to update
  * @param topic — Topic in which the output should be updated
  * @param consumedBy — The new set of outputs consumed by this output
  */
  updateConsumedBy: (txid: string, outputIndex: number, topic: string, consumedBy: Array<{
    txid: string
    outputIndex: number
  }>) => Promise<void>

  /**
   * Updates the beef data for a transaction
   * @param txid — TXID of the transaction to update
   * @param beef - BEEF data to update
   */
  updateTransactionBEEF: (txid: string, beef: number[]) => Promise<void>

  /**
   * Updates the block height on an output
   * @param txid — TXID of the output to update
   * @param outputIndex — Index of the output to update
   * @param topic— Topic in which the output should be updated
   * @param blockHeight - height of the block the transaction associated with this output was included in
   */
  updateOutputBlockHeight?: (txid: string, outputIndex: number, topic: string, blockHeight: number) => Promise<void>

  /**
   * Upserts transaction-level data used for compact BEEF, raw-tx BASM fetches,
   * and direct proof retrieval.
   */
  upsertTransactionRecord?: (record: StoredTransactionRecord) => Promise<void>

  /**
   * Updates direct proof metadata for an applied topic transaction.
   */
  updateAppliedTransactionProof?: (record: AppliedTransactionProofUpdate) => Promise<void>

  /**
   * Inserts record of the applied transaction
   * @param tx — The transaction to insert
   */
  insertAppliedTransaction: (tx: AppliedTransaction) => Promise<void>

  /**
   * Checks if a duplicate transaction exists
   * @param tx — Transaction to check
   * @returns Whether the transaction is already applied
   */
  doesAppliedTransactionExist: (tx: AppliedTransaction) => Promise<boolean>

  /**
   * Returns proven topic transactions admitted in one block, in canonical block order.
   */
  findAdmittedTransactionsForBlock?: (topic: string, blockHeight: number, blockHash?: string) => Promise<AdmittedTxRef[]>

  /**
   * Persists or replaces a topic block anchor for one height.
   */
  upsertTopicBlockAnchor?: (anchor: TopicBlockAnchor) => Promise<void>

  /**
   * Returns one topic block anchor.
   */
  findTopicBlockAnchor?: (topic: string, blockHeight: number, blockHash?: string) => Promise<TopicBlockAnchor | undefined>

  /**
   * Returns topic block anchors across a closed height range.
   */
  findTopicBlockAnchors?: (topic: string, fromHeight: number, toHeight: number) => Promise<TopicBlockAnchor[]>

  /**
   * Returns the latest known topic anchor tip.
   */
  findTopicAnchorTip?: (topic: string) => Promise<TopicAnchorTip | undefined>

  /**
   * Returns raw transactions for the requested txids.
   */
  findRawTransactions?: (txids: string[]) => Promise<RawTransactionRecord[]>

  /**
   * Returns direct Merkle paths for the requested txids.
   */
  findTransactionMerklePaths?: (txids: string[]) => Promise<Array<{
    txid: string
    merklePath: string
    blockHeight?: number
    blockHash?: string
    blockIndex?: number
    merkleRoot?: string
  }>>

  /**
   * Finds topic-applied transactions with no direct proof old enough to evict.
   */
  findUnprovenAppliedTransactions?: (cutoffHeight: number, topic?: string) => Promise<UnprovenAppliedTransactionCandidate[]>

  /**
   * Deletes a topic-applied transaction record.
   */
  deleteAppliedTransaction?: (txid: string, topic: string) => Promise<void>

  /**
   * Returns proven topic-applied transactions whose proof anchors to the given
   * block hash. Used to demote admissions when that block is reorged out.
   */
  findProvenAppliedTransactionsByBlockHash?: (blockHash: string) => Promise<Array<{ txid: string, topic: string, blockHeight: number }>>

  /**
   * Returns proven topic-applied transactions in a closed block-height range,
   * including the proof's block hash and merkle root for revalidation sweeps.
   */
  findProvenAppliedTransactionsInRange?: (fromHeight: number, toHeight: number, topic?: string) => Promise<Array<{ txid: string, topic: string, blockHeight: number, blockHash?: string, merkleRoot?: string }>>

  /**
   * Demotes a proven applied transaction back to unproven: clears the block
   * proof metadata and `proven` flag while retaining `firstSeenHeight`, so the
   * "received" record survives until re-proof or unproven eviction.
   */
  demoteAppliedTransactionToUnproven?: (txid: string, topic: string) => Promise<void>

  /**
   * Updates the last interaction score for a given host and topic
   * @param host — The host identifier
   * @param topic — The topic for which to update the interaction score
   * @param since — The score value to store
   */
  updateLastInteraction: (host: string, topic: string, since: number) => Promise<void>

  /**
   * Retrieves the last interaction score for a given host and topic
   * @param host — The host identifier
   * @param topic — The topic to query
   * @returns The last interaction score, or 0 if not found
   */
  getLastInteraction: (host: string, topic: string) => Promise<number>
}
