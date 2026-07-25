import { TopicManager } from './TopicManager.js'
import { LookupService } from './LookupService.js'
import { Storage } from './storage/Storage.js'
import type { Output } from './Output.js'
import {
  Transaction,
  ChainTracker,
  MerklePath,
  Broadcaster,
  isBroadcastFailure,
  TaggedBEEF, STEAK,
  LookupQuestion,
  LookupAnswer,
  AdmittanceInstructions,
  SHIPBroadcaster,
  HTTPSOverlayBroadcastFacilitator,
  LookupResolver,
  LookupResolverConfig,
  OverlayBroadcastFacilitator,
  BroadcastResponse,
  BroadcastFailure
} from '@bsv/sdk'
import { AdvertisementData, Advertiser } from './Advertiser.js'
import { GASP, GASPInitialRequest, GASPInitialResponse, GASPNode } from '@bsv/gasp'
import { SyncConfiguration } from './SyncConfiguration.js'
import { OverlayGASPRemote } from './GASP/OverlayGASPRemote.js'
import { OverlayGASPStorage } from './GASP/OverlayGASPStorage.js'
import {
  BASM_ZERO_HASH,
  type AdmittedListResponse,
  type BASMPeerSyncReport,
  type CompoundMerklePathResponse,
  type RawTransactionResponse,
  type ReorgReport,
  type TopicAnchorHeaderResolver,
  type TopicAnchorRangeResponse,
  type TopicAnchorTip,
  type TopicBlockAnchor,
  computeBasmRoot,
  computeTac,
  extractMerkleProofMetadata
} from './BASM.js'
import { BASMRemote } from './BASMRemote.js'
import { serializeErrorForLog, serializeLogValue } from './SafeLog.js'

const DEFAULT_GASP_SYNC_LIMIT = 10000
const DEFAULT_BASM_RANGE_LIMIT = 1024

type UTXOHistoryHydrationContext = {
  outputCache: Map<string, Promise<Output | null>>
}

type HydratedUTXOHistoryNode = {
  output: Output
  transaction: Transaction
}

/**
 * An engine for running BSV Overlay Services (topic managers and lookup services).
 */
export class Engine {
  /**
   * Creates a new Overlay Services Engine
   * @param {[key: string]: TopicManager} managers - manages topic admittance
   * @param {[key: string]: LookupService} lookupServices - manages UTXO lookups
   * @param {Storage} storage - for interacting with internally-managed persistent data
   * @param {ChainTracker | 'scripts only'} chainTracker - Verifies SPV data associated with transactions
   * @param {string} [hostingURL] - The URL this engine is hosted at. Required if going to support peer-discovery with an advertiser.
   * @param {Broadcaster} [Broadcaster] - broadcaster used for broadcasting the incoming transaction
   * @param {Advertiser} [Advertiser] - handles SHIP and SLAP advertisements for peer-discovery
   * @param {string[]} shipTrackers - SHIP domains we know to bootstrap the system
   * @param {string[]} slapTrackers - SLAP domains we know to bootstrap the system
   * @param {SyncConfiguration} syncConfiguration — Configuration object describing historical synchronization of topics.
   * @param {boolean} logTime - Enables / disables the timing logs for various operations in the Overlay submit route.
   * @param {string} logPrefix - Supports overriding the log prefix with a custom string.
   * @param {boolean} throwOnBroadcastFailure - Enables / disables throwing an error when a transaction broadcast failure is detected.
   * @param {OverlayBroadcastFacilitator} overlayBroadcastFacilitator - Facilitator for propagation to other Overlay Services.
   * @param {typeof console} logger - The place where log entries are written.
   * @param {boolean} suppressDefaultSyncAdvertisements - Whether to suppress the default (SHIP/SLAP) sync advertisements.
   * @param {TopicAnchorHeaderResolver} topicAnchorHeaderResolver - Resolves block hashes for BASM anchors.
   * @param {boolean} basmSyncEnabled - Whether BASM sync should run automatically.
   * @param {number} unprovenEvictionBlocks - Default block age for opt-in unproven state eviction.
   */
  constructor(
    public managers: { [key: string]: TopicManager },
    public lookupServices: { [key: string]: LookupService },
    public storage: Storage,
    public chainTracker: ChainTracker | 'scripts only',
    public hostingURL?: string,
    public shipTrackers?: string[],
    public slapTrackers?: string[],
    public broadcaster?: Broadcaster,
    public advertiser?: Advertiser,
    public syncConfiguration?: SyncConfiguration,
    public logTime = false,
    public logPrefix = '[OVERLAY_ENGINE] ',
    public throwOnBroadcastFailure = false,
    public overlayBroadcastFacilitator: OverlayBroadcastFacilitator = new HTTPSOverlayBroadcastFacilitator(),
    public logger: typeof console = console,
    public suppressDefaultSyncAdvertisements = true,
    public topicAnchorHeaderResolver?: TopicAnchorHeaderResolver,
    public basmSyncEnabled = false,
    public unprovenEvictionBlocks = 144
  ) {
    // To encourage synchronization of overlay services, the SHIP sync strategy is used by default for all overlay topics, except for 'tm_ship' and 'tm_slap'.
    // For these two topics, any existing trackers are combined with the provided shipTrackers and slapTrackers omitting any duplicates.
    if (syncConfiguration === undefined) {
      this.syncConfiguration = {}
    } else {
      this.syncConfiguration = syncConfiguration
    }

    for (const managerName of Object.keys(managers)) {
      if (managerName === 'tm_ship' && this.shipTrackers !== undefined && this.syncConfiguration[managerName] !== false) {
        // Combine tm_ship trackers with preexisting entries if any
        const combinedSet = new Set([
          ...(Array.isArray(this.syncConfiguration[managerName]) ? this.syncConfiguration[managerName] : []),
          ...this.shipTrackers
        ])
        this.syncConfiguration[managerName] = Array.from(combinedSet)
      } else if (managerName === 'tm_slap' && this.slapTrackers !== undefined && this.syncConfiguration[managerName] !== false) {
        // Combine tm_slap trackers with preexisting entries if any
        const combinedSet = new Set([
          ...(Array.isArray(this.syncConfiguration[managerName]) ? this.syncConfiguration[managerName] : []),
          ...this.slapTrackers
        ])
        this.syncConfiguration[managerName] = Array.from(combinedSet)
      } else {
        // Set undefined managers to 'SHIP' by default
        this.syncConfiguration[managerName] ??= 'SHIP'
      }
    }
  }

  // Helper functions for logging timings
  private startTime(label: string): void {
    if (this.logTime) {
      this.logger.time(`${this.logPrefix} ${label}`)
    }
  }

  private endTime(label: string): void {
    if (this.logTime) {
      this.logger.timeEnd(`${this.logPrefix} ${label}`)
    }
  }

  private async currentHeightOrUndefined(): Promise<number | undefined> {
    if (this.chainTracker === 'scripts only') {
      return undefined
    }
    try {
      return await this.chainTracker.currentHeight()
    } catch (error) {
      this.logger.warn(`Unable to resolve current chain height for overlay metadata: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async resolveBlockHash(blockHeight: number, merkleRoot?: string): Promise<string | undefined> {
    try {
      const header = await this.topicAnchorHeaderResolver?.(blockHeight)
      if (header === undefined) {
        return undefined
      }
      if (header.merkleRoot !== undefined && merkleRoot !== undefined && header.merkleRoot !== merkleRoot) {
        throw new Error(`Header merkle root ${header.merkleRoot} does not match proof root ${merkleRoot} at height ${blockHeight}`)
      }
      return header.blockHash
    } catch (error) {
      this.logger.warn(`Unable to resolve BASM block hash: height=${serializeLogValue(blockHeight)} error=${serializeErrorForLog(error)}`)
      return undefined
    }
  }

  private compactBEEFForStorage(tx: Transaction, originalBEEF: number[]): number[] {
    return tx.merklePath === undefined ? originalBEEF : tx.toAtomicBEEF()
  }

  private async recordTransactionData(tx: Transaction, beef: number[], blockHash?: string): Promise<void> {
    if (typeof this.storage.upsertTransactionRecord !== 'function') {
      return
    }

    const txid = tx.id('hex')
    const metadata = extractMerkleProofMetadata(txid, tx.merklePath)
    await this.storage.upsertTransactionRecord({
      txid,
      beef: this.compactBEEFForStorage(tx, beef),
      rawTx: Array.from(tx.toBinary()),
      merklePath: tx.merklePath?.toBinary(),
      blockHeight: metadata?.blockHeight,
      blockHash,
      blockIndex: metadata?.blockIndex,
      merkleRoot: metadata?.merkleRoot
    })
  }

  private async buildAppliedTransactionRecord(tx: Transaction): Promise<{
    blockHeight?: number
    blockHash?: string
    blockIndex?: number
    merkleRoot?: string
    firstSeenHeight?: number
    proven: boolean
  }> {
    const txid = tx.id('hex')
    const metadata = extractMerkleProofMetadata(txid, tx.merklePath)
    const [firstSeenHeight, blockHash] = await Promise.all([
      this.currentHeightOrUndefined(),
      metadata === undefined ? undefined : this.resolveBlockHash(metadata.blockHeight, metadata.merkleRoot)
    ])

    return {
      blockHeight: metadata?.blockHeight,
      blockHash,
      blockIndex: metadata?.blockIndex,
      merkleRoot: metadata?.merkleRoot,
      firstSeenHeight: firstSeenHeight ?? metadata?.blockHeight,
      proven: metadata !== undefined
    }
  }

  private async recomputeTopicBlockAnchor(topic: string, blockHeight: number, blockHash?: string): Promise<TopicBlockAnchor | undefined> {
    if (
      typeof this.storage.findAdmittedTransactionsForBlock !== 'function' ||
      typeof this.storage.upsertTopicBlockAnchor !== 'function' ||
      typeof this.storage.findTopicBlockAnchor !== 'function'
    ) {
      return undefined
    }

    const anchorBlockHash = blockHash ?? (await this.storage.findTopicBlockAnchor(topic, blockHeight))?.blockHash
    if (anchorBlockHash === undefined) {
      return undefined
    }

    // BRC-136 per-block completeness: establish the chain's genesis at the first
    // admitted height, then keep every height from there to the tip contiguous so
    // the cumulative TAC never resets across blocks with no admitted transactions.
    // We rebuild [fromHeight, toHeight] rather than only the touched height so that
    // an out-of-order proof (older height arriving after a newer one) can never
    // leave a gap that silently breaks the chain.
    const tip = await this.storage.findTopicAnchorTip?.(topic)
    const tipHeight = tip !== undefined && tip.blockHeight >= 0 ? tip.blockHeight : undefined
    const fromHeight = tipHeight === undefined ? blockHeight : Math.min(blockHeight, tipHeight + 1)
    const toHeight = tipHeight === undefined ? blockHeight : Math.max(blockHeight, tipHeight)

    await this.rebuildTopicAnchorChain(topic, fromHeight, toHeight, new Map([[blockHeight, anchorBlockHash]]))
    return await this.storage.findTopicBlockAnchor(topic, blockHeight)
  }

  /**
   * Extends every configured topic's anchor chain forward with empty Topic Block
   * Anchors (basmRoot = zero hash, admittedCount = 0) up to `toHeight`, so the
   * cumulative TAC advances on every block even when a topic admits nothing —
   * this is what lets a peer authoritatively confirm "this block contained no
   * transactions for this topic". Chains with no first admission yet are left
   * unstarted (genesis is the topic's first admitted height).
   */
  async advanceTopicAnchorChains(toHeight?: number): Promise<void> {
    if (
      typeof this.storage.findTopicAnchorTip !== 'function' ||
      typeof this.storage.upsertTopicBlockAnchor !== 'function'
    ) {
      return
    }
    const targetHeight = toHeight ?? await this.currentHeightOrUndefined()
    if (targetHeight === undefined) {
      return
    }
    for (const topic of Object.keys(this.managers)) {
      const tip = await this.storage.findTopicAnchorTip(topic)
      if (tip === undefined || tip.blockHeight < 0 || tip.blockHeight >= targetHeight) {
        continue
      }
      await this.rebuildTopicAnchorChain(topic, tip.blockHeight + 1, targetHeight)
    }
  }

  /**
   * Rebuilds a contiguous slice of a topic's anchor chain over [fromHeight,
   * toHeight]. Each height uses its admitted transactions (empty -> zero basmRoot)
   * and chains the cumulative TAC from the prior height. Missing heights are
   * filled rather than skipped, so the chain stays gap-free. If a block hash
   * cannot be resolved for some height the extension halts there to preserve
   * contiguity instead of leaving a hole.
   */
  private async rebuildTopicAnchorChain(
    topic: string,
    fromHeight: number,
    toHeight: number,
    blockHashHints: Map<number, string> = new Map(),
    forceResolve = false
  ): Promise<void> {
    if (
      typeof this.storage.findAdmittedTransactionsForBlock !== 'function' ||
      typeof this.storage.upsertTopicBlockAnchor !== 'function' ||
      typeof this.storage.findTopicBlockAnchor !== 'function' ||
      toHeight < fromHeight
    ) {
      return
    }

    if (toHeight - fromHeight + 1 > DEFAULT_BASM_RANGE_LIMIT) {
      // Bound the work per pass; the next trigger resumes from the new tip.
      this.logger.warn(`[BASM] capping anchor chain extension: topic=${serializeLogValue(topic)} limit=${serializeLogValue(DEFAULT_BASM_RANGE_LIMIT)} requestedFrom=${serializeLogValue(fromHeight)} requestedTo=${serializeLogValue(toHeight)}; will continue on the next pass`)
      toHeight = fromHeight + DEFAULT_BASM_RANGE_LIMIT - 1
    }

    const previousAnchor = fromHeight > 0
      ? await this.storage.findTopicBlockAnchor(topic, fromHeight - 1)
      : undefined
    let prevTac = previousAnchor?.tac ?? BASM_ZERO_HASH

    for (let height = fromHeight; height <= toHeight; height++) {
      const admitted = await this.storage.findAdmittedTransactionsForBlock(topic, height)
      const existing = await this.storage.findTopicBlockAnchor(topic, height)
      // On a reorg rebuild the existing anchor's block hash is stale, so force
      // canonical re-resolution from the header resolver instead of reusing it.
      const blockHash = blockHashHints.get(height) ?? (forceResolve ? undefined : existing?.blockHash) ?? await this.resolveBlockHash(height)
      if (blockHash === undefined) {
        this.logger.warn(`[BASM] unable to resolve block hash: topic=${serializeLogValue(topic)} height=${serializeLogValue(height)}; halting chain extension`)
        return
      }

      const basmRoot = computeBasmRoot(admitted)
      const tac = computeTac(prevTac, blockHash, basmRoot)
      await this.storage.upsertTopicBlockAnchor({
        topic,
        blockHeight: height,
        blockHash,
        basmRoot,
        admittedCount: admitted.length,
        tac
      })
      prevTac = tac
    }
  }

  /**
   * Reconciles BASM anchors with a blockchain reorganization reported by the
   * chain tracker (e.g. go-chaintracks `/v2/reorg/stream`). Proven topic
   * transactions whose block was orphaned are demoted to unproven so they leave
   * the admitted set, then every topic anchor chain intersecting the affected
   * height range is rebuilt over the canonical block hashes. A reorg changes the
   * canonical block hash for the affected heights, so topics with no demoted
   * transaction are rebuilt too. Idempotent: a clean window demotes nothing and
   * reproduces an identical TAC, so this is safe to invoke on every reorg event,
   * SSE reconnect, and poll.
   */
  async handleReorg(input: {
    orphanedBlockHashes: string[]
    rebuildFromHeight: number
    newTipHeight: number
  }): Promise<ReorgReport> {
    const report: ReorgReport = { perTopic: [] }
    if (
      typeof this.storage.findProvenAppliedTransactionsByBlockHash !== 'function' ||
      typeof this.storage.demoteAppliedTransactionToUnproven !== 'function' ||
      typeof this.storage.findTopicBlockAnchors !== 'function' ||
      typeof this.storage.upsertTopicBlockAnchor !== 'function'
    ) {
      return report
    }

    // 1) Demote proven admissions whose block was orphaned. Hashes are
    //    normalized to lower-case display hex to match stored block hashes
    //    (go-sdk chainhash.Hash marshals as reversed display hex).
    const demotedByTopic = new Map<string, string[]>()
    for (const rawHash of input.orphanedBlockHashes) {
      const blockHash = rawHash.toLowerCase()
      const rows = await this.storage.findProvenAppliedTransactionsByBlockHash(blockHash)
      for (const row of rows) {
        await this.storage.demoteAppliedTransactionToUnproven(row.txid, row.topic)
        const list = demotedByTopic.get(row.topic) ?? []
        list.push(row.txid)
        demotedByTopic.set(row.topic, list)
      }
    }

    // 2) Rebuild every topic anchor chain that intersects the reorged range,
    //    forcing canonical block-hash re-resolution so stale hashes are replaced.
    for (const topic of Object.keys(this.managers)) {
      const existing = await this.storage.findTopicBlockAnchors(topic, input.rebuildFromHeight, input.newTipHeight)
      if (existing.length === 0) {
        continue
      }
      const startHeight = Math.min(...existing.map(anchor => anchor.blockHeight))
      await this.rebuildTopicAnchorChain(topic, startHeight, input.newTipHeight, new Map(), true)
      report.perTopic.push({
        topic,
        demotedTxids: demotedByTopic.get(topic) ?? [],
        rebuiltFrom: startHeight,
        rebuiltTo: input.newTipHeight
      })
    }

    return report
  }

  /**
   * Revalidation sweep: the reorg fallback for chain trackers without a reorg
   * event stream, and the catch-up step on every reorg-SSE (re)connect (the
   * go-chaintracks reorg stream carries no event ids, so a reconnect cannot
   * replay events missed while disconnected). Scans proven applied transactions
   * in `[tip - depth + 1, tip]`; any whose proof root no longer validates against
   * the chain tracker, or whose block hash diverges from the canonical header, is
   * treated as orphaned and reconciled via {@link handleReorg}.
   */
  private async isProvenAnchorStale(
    row: { txid: string, blockHeight: number, blockHash?: string, merkleRoot?: string },
    chainTracker: ChainTracker
  ): Promise<boolean | undefined> {
    if (row.merkleRoot !== undefined) {
      try {
        if (!(await chainTracker.isValidRootForHeight(row.merkleRoot, row.blockHeight))) {
          return true
        }
      } catch (error) {
        this.logger.warn(`[BASM] root validation failed for ${row.txid} at height ${row.blockHeight}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }

    const canonical = await this.resolveBlockHash(row.blockHeight)
    return canonical !== undefined && canonical.toLowerCase() !== row.blockHash?.toLowerCase()
  }

  async revalidateRecentAnchors(depth = 3): Promise<ReorgReport | undefined> {
    const chainTracker = this.chainTracker
    if (chainTracker === 'scripts only') {
      this.logger.warn('[BASM] revalidation sweep requires a ChainTracker; skipping')
      return undefined
    }
    if (typeof this.storage.findProvenAppliedTransactionsInRange !== 'function') {
      return undefined
    }
    const tip = await this.currentHeightOrUndefined()
    if (tip === undefined) {
      return undefined
    }

    const fromHeight = Math.max(0, tip - depth + 1)
    const rows = await this.storage.findProvenAppliedTransactionsInRange(fromHeight, tip)
    const orphaned = new Set<string>()
    let minAffected = Number.POSITIVE_INFINITY

    for (const row of rows) {
      if (row.blockHash === undefined) {
        continue
      }
      const stale = await this.isProvenAnchorStale(row, chainTracker)
      if (stale === true) {
        orphaned.add(row.blockHash.toLowerCase())
        minAffected = Math.min(minAffected, row.blockHeight)
      }
    }

    if (orphaned.size === 0) {
      return { perTopic: [] }
    }

    return await this.handleReorg({
      orphanedBlockHashes: Array.from(orphaned),
      rebuildFromHeight: minAffected,
      newTipHeight: tip
    })
  }

  /**
   * Submits a transaction for processing by Overlay Services.
   * @param {TaggedBEEF} taggedBEEF - The transaction to process
   * @param {function(STEAK): void} [onSTEAKReady] - Optional callback function invoked when the STEAK is ready.
   * @param {string} mode — Indicates the submission behavior, whether historical or current. Historical transactions are not broadcast or propagated.
   * @param {number[]} offChainValues — Values necessary to evaluate topical admittance that are not stored on-chain.
   *
   * The optional callback function should be used to get STEAK when ready, and avoid waiting for broadcast and transaction propagation to complete.
   *
   * @returns {Promise<STEAK>} The submitted transaction execution acknowledgement
   */
  async submit(taggedBEEF: TaggedBEEF, onSteakReady?: (steak: STEAK) => void, mode: 'historical-tx' | 'current-tx' | 'historical-tx-no-spv' = 'current-tx', offChainValues?: number[]): Promise<STEAK> {
    for (const t of taggedBEEF.topics) {
      if (this.managers[t] === undefined || this.managers[t] === null) {
        throw new Error(`This server does not support this topic: ${t}`)
      }
    }

    // Validate the transaction SPV information
    const tx = Transaction.fromBEEF(taggedBEEF.beef)
    const txid = tx.id('hex')

    this.startTime(`submit_${txid}`)
    if (mode !== 'historical-tx-no-spv') {
      this.startTime(`chainTracker_${txid.substring(0, 10)}`)
      const txValid = await tx.verify(this.chainTracker)
      if (!txValid) throw new Error('Unable to verify SPV information.')
      this.endTime(`chainTracker_${txid.substring(0, 10)}`)
    }

    const steak: STEAK = {}
    const dupeTopics = new Set<string>()
    const failedTopics = new Set<string>()

    // ===================================================================
    // PHASE 1: VALIDATE (read-only, no mutations)
    // ===================================================================
    type TopicValidation = {
      topic: string
      isDupe: boolean
      previousCoins: number[]
      previousOutputs: Array<Output | null>
      admissibleOutputs: AdmittanceInstructions
    }

    const topicValidations = taggedBEEF.topics.map(async (topic): Promise<TopicValidation> => {
      try {
        if (this.managers[topic] === undefined || this.managers[topic] === null) {
          throw new Error(`This server does not support this topic: ${topic}`)
        }

        // Check for duplicate transactions
        this.startTime(`dupCheck_${txid.substring(0, 10)}`)
        const dupeCheck = await this.storage.doesAppliedTransactionExist({ txid, topic })
        this.endTime(`dupCheck_${txid.substring(0, 10)}`)

        if (dupeCheck) {
          dupeTopics.add(topic)
          return {
            topic,
            isDupe: true,
            previousCoins: [],
            previousOutputs: [],
            admissibleOutputs: { outputsToAdmit: [], coinsToRetain: [] }
          }
        }

        // Identify previous coins admitted to this specific topic
        const previousCoins: number[] = []
        const outputPromises = tx.inputs.map(async (input, i) => {
          const previousTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
          if (previousTXID !== undefined) {
            // Check if the previous output was admitted to this specific topic
            const output = await this.storage.findOutput(previousTXID, input.sourceOutputIndex, topic)
            if (output !== undefined && output !== null) {
              previousCoins.push(i)
              return output
            }
          }
          return null
        })

        this.startTime(`previousOutputQuery_${txid.substring(0, 10)}`)
        const previousOutputs = await Promise.all(outputPromises)
        this.endTime(`previousOutputQuery_${txid.substring(0, 10)}`)

        // Determine which outputs are admissible for this topic (validation only)
        this.startTime(`identifyAdmissibleOutputs_${txid.substring(0, 10)}`)
        const admissibleOutputs = await this.managers[topic].identifyAdmissibleOutputs(
          taggedBEEF.beef,
          previousCoins,
          offChainValues,
          mode
        )
        this.endTime(`identifyAdmissibleOutputs_${txid.substring(0, 10)}`)

        return {
          topic,
          isDupe: false,
          previousCoins,
          previousOutputs,
          admissibleOutputs
        }
      } catch (error) {
        this.logger.error(`Error validating topic during submit: topic=${serializeLogValue(topic)} error=${serializeErrorForLog(error)}`)
        failedTopics.add(topic)
        return {
          topic,
          isDupe: false,
          previousCoins: [],
          previousOutputs: [],
          admissibleOutputs: { outputsToAdmit: [], coinsToRetain: [] }
        }
      }
    })

    const validations = await Promise.all(topicValidations)

    // Build preliminary STEAK from validation results
    for (const validation of validations) {
      steak[validation.topic] = validation.admissibleOutputs
    }

    // ===================================================================
    // PHASE 2: BROADCAST (before any mutations)
    // ===================================================================
    // Only broadcast when at least one topic actually accepted the
    // transaction. For a non-failed topic, acceptance means: previously
    // accepted (dupe / client retry), outputs admitted, coins retained, or
    // previously-admitted coins consumed (e.g. a consume-only deletion such
    // as a KVStore remove, even one that retains nothing). A topic manager
    // REJECTS by throwing from identifyAdmissibleOutputs (tracked in
    // failedTopics). A transaction every topic rejected must never reach the
    // network: submitters treat an empty STEAK as a rejection and
    // abort/release their held inputs, so broadcasting it anyway would
    // desync their wallets from the chain.
    const anyTopicAccepted = validations.some(v =>
      !failedTopics.has(v.topic) && (
        v.isDupe ||
        v.admissibleOutputs.outputsToAdmit.length > 0 ||
        v.admissibleOutputs.coinsToRetain.length > 0 ||
        v.previousCoins.length > 0
      )
    )
    this.startTime(`broadcast_${txid.substring(0, 10)}`)
    if (mode !== 'historical-tx' && this.broadcaster !== undefined && anyTopicAccepted) {
      try {
        let response: BroadcastResponse | BroadcastFailure
        if (tx.merklePath !== undefined) {
          // tx has been verified, thus if there is a merklePath, the transaction is already on-chain...skip broadcast.
          const txid = tx.id('hex')
          const mp = tx.merklePath
          const leaf = mp.path[0].find(leaf => leaf.hash === txid)
          const r: BroadcastResponse = {
            status: 'success',
            txid: tx.id('hex'),
            message: `In block at height ${mp.blockHeight} index ${leaf?.offset}`,
          }
          response = r
        } else {
          response = await this.broadcaster.broadcast(tx)
        }
        if (isBroadcastFailure(response) && this.throwOnBroadcastFailure) {
          const e = new Error(`Failed to broadcast transaction! Error: ${response.description}`)
            ; (e as any).more = response.more
          throw e
        }
      } catch (error) {
        if (this.throwOnBroadcastFailure) {
          throw error
        }
        this.logger.error('Error broadcasting transaction:', error)
      }
    }
    this.endTime(`broadcast_${txid.substring(0, 10)}`)

    // Call the callback function with STEAK if it is provided (before storage mutations)
    if (onSteakReady !== undefined) {
      onSteakReady(steak)
    }

    // ===================================================================
    // PHASE 3: MUTATE STORAGE (only after broadcast succeeded)
    // ===================================================================
    // Mark previous outputs as spent and notify lookup services
    await Promise.all(validations.map(async (validation) => {
      if (validation.isDupe || failedTopics.has(validation.topic)) {
        return
      }

      const topic = validation.topic
      const previousOutputs = validation.previousOutputs

      // Mark all previous outputs as spent
      const markSpentPromises = previousOutputs.map(async (output) => {
        if (output !== undefined && output !== null) {
          try {
            await this.storage.markUTXOAsSpent(output.txid, output.outputIndex, topic)
            await Promise.all(Object.values(this.lookupServices).map(async l => {
              try {
                if (typeof l.outputSpent === 'function') {
                  if (l.spendNotificationMode === 'txid') {
                    await l.outputSpent({
                      mode: 'txid',
                      spendingTxid: txid,
                      txid: output.txid,
                      outputIndex: output.outputIndex,
                      topic
                    })
                  } else if (l.spendNotificationMode === 'script') {
                    const inputIndex = tx.inputs.findIndex(i => {
                      let realSource = i.sourceTXID
                      if (!realSource) {
                        realSource = i.sourceTransaction?.id('hex')
                      }
                      return realSource === output.txid && i.sourceOutputIndex === output.outputIndex
                    })
                    if (inputIndex === -1) {
                      throw new Error('Could not find input index')
                    }
                    await l.outputSpent({
                      mode: 'script',
                      spendingTxid: txid,
                      inputIndex,
                      sequenceNumber: tx.inputs[inputIndex].sequence ?? 0xffffffff,
                      unlockingScript: tx.inputs[inputIndex].unlockingScript!,
                      txid: output.txid,
                      outputIndex: output.outputIndex,
                      topic,
                      offChainValues
                    })
                  } else if (l.spendNotificationMode === 'whole-tx') {
                    await l.outputSpent({
                      mode: 'whole-tx',
                      spendingAtomicBEEF: tx.toAtomicBEEF(),
                      txid: output.txid,
                      outputIndex: output.outputIndex,
                      topic,
                      offChainValues
                    })
                  } else { // none
                    await l.outputSpent({
                      mode: 'none',
                      txid: output.txid,
                      outputIndex: output.outputIndex,
                      topic
                    })
                  }
                }
              } catch (error) {
                this.logger.error('Error in lookup service for outputSpent:', error)
              }
            }))
          } catch (error) {
            this.logger.error('Error marking UTXO as spent:', error)
          }
        }
      })

      await Promise.all(markSpentPromises)
    }))

    // Continue with storage updates and lookup service notifications
    for (const validation of validations) {
      const topic = validation.topic
      if (dupeTopics.has(topic)) {
        continue
      }
      if (failedTopics.has(topic)) {
        continue
      }
      try {
        const admissibleOutputs = steak[topic]
        const outputsToAdmit: number[] = admissibleOutputs.outputsToAdmit
        const outputsConsumed: Array<{
          txid: string
          outputIndex: number
        }> = []

        const outputsToMarkStale: Array<{
          txid: string
          previousOutputIndex: number
          inputIndex: number
        }> = []

        // Use previousCoins from validation
        const previousCoins = validation.previousCoins

        // For each of the previous UTXOs for this topic, if the UTXO was not included in the list of UTXOs identified for retention, then it will be marked as stale.
        for (const inputIndex of previousCoins) {
          const previousTXID = tx.inputs[inputIndex].sourceTXID ?? tx.inputs[inputIndex].sourceTransaction?.id('hex')
          if (typeof previousTXID !== 'string') continue
          const previousOutputIndex = tx.inputs[inputIndex].sourceOutputIndex
          if (admissibleOutputs.coinsToRetain.includes(inputIndex)) {
            outputsConsumed.push({
              txid: previousTXID,
              outputIndex: previousOutputIndex
            })
          } else {
            outputsToMarkStale.push({
              txid: previousTXID,
              previousOutputIndex,
              inputIndex
            })
          }
        }

        // Remove stale outputs recursively
        this.startTime(`lookForStaleOutputs_${txid.substring(0, 10)}`)
        await Promise.all(outputsToMarkStale.map(async coin => {
          const output = await this.storage.findOutput(coin.txid, coin.previousOutputIndex, topic)
          if (output !== undefined && output !== null) {
            await this.deleteUTXODeep(output)
          }
        }))
        this.endTime(`lookForStaleOutputs_${txid.substring(0, 10)}`)

        // Update the STEAK to indicate which coins were removed
        steak[topic].coinsRemoved = outputsToMarkStale.map(x => x.inputIndex)

        // Handle admittance and notification of incoming UTXOs
        const newUTXOs: Array<{ txid: string, outputIndex: number }> = []
        await Promise.all(outputsToAdmit.map(async outputIndex => {
          if (typeof tx.outputs[outputIndex].satoshis !== 'number') return
          this.startTime(`insertNewOutput_${txid.substring(0, 10)}`)
          await this.storage.insertOutput({
            txid,
            outputIndex,
            outputScript: tx.outputs[outputIndex].lockingScript.toBinary(),
            satoshis: tx.outputs[outputIndex].satoshis,
            topic,
            spent: false,
            beef: this.compactBEEFForStorage(tx, taggedBEEF.beef),
            consumedBy: [],
            outputsConsumed,
            score: Date.now(),
            blockHeight: extractMerkleProofMetadata(txid, tx.merklePath)?.blockHeight
          })
          this.endTime(`insertNewOutput_${txid.substring(0, 10)}`)
          newUTXOs.push({ txid, outputIndex })

          this.startTime(`notifyLookupService${txid.substring(0, 10)}`)
          await Promise.all(Object.values(this.lookupServices).map(async l => {
            try {
              if (l.admissionMode === 'locking-script') {
                if (
                  typeof tx.outputs[outputIndex].lockingScript !== 'object' ||
                  typeof tx.outputs[outputIndex].satoshis !== 'number'
                ) {
                  return
                }
                await l.outputAdmittedByTopic({
                  mode: 'locking-script',
                  txid,
                  outputIndex,
                  lockingScript: tx.outputs[outputIndex].lockingScript,
                  satoshis: tx.outputs[outputIndex].satoshis,
                  topic,
                  offChainValues
                })
              } else {
                await l.outputAdmittedByTopic({
                  mode: 'whole-tx',
                  atomicBEEF: tx.toAtomicBEEF(),
                  outputIndex,
                  topic,
                  offChainValues
                })
              }
            } catch (error) {
              this.logger.error('Error in lookup service for outputAdmittedByTopic:', error)
            }
          }))
          this.endTime(`notifyLookupService${txid.substring(0, 10)}`)
        }))

        this.startTime(`outputConsumed_${txid.substring(0, 10)}`)
        // Update each output consumed to know who consumed it and insert applied transaction in parallel
        const appliedRecord = await this.buildAppliedTransactionRecord(tx)
        await this.recordTransactionData(tx, taggedBEEF.beef, appliedRecord.blockHash)

        await Promise.all([
          ...outputsConsumed.map(async output => {
            const outputToUpdate = await this.storage.findOutput(output.txid, output.outputIndex, topic)
            if (outputToUpdate !== undefined && outputToUpdate !== null) {
              const newConsumedBy = [...new Set([...newUTXOs, ...outputToUpdate.consumedBy])]
              await this.storage.updateConsumedBy(output.txid, output.outputIndex, topic, newConsumedBy)
            }
          }),
          this.storage.insertAppliedTransaction({
            txid,
            topic,
            ...appliedRecord
          })
        ])

        if (appliedRecord.blockHeight !== undefined && appliedRecord.blockHash !== undefined) {
          await this.recomputeTopicBlockAnchor(topic, appliedRecord.blockHeight, appliedRecord.blockHash)
        }
        this.endTime(`outputConsumed_${txid.substring(0, 10)}`)
      } catch (error) {
        this.logger.error('Error updating storage and notifying lookup services for topic', topic, error)
      }
    }

    // If we don't have an advertiser or we are dealing with historical transactions, just return the steak
    if (this.advertiser === undefined || mode === 'historical-tx' || mode === 'historical-tx-no-spv') {
      return steak
    }

    this.startTime(`transactionPropagation_${txid.substring(0, 10)}`)
    const relevantTopics = taggedBEEF.topics.filter(topic =>
      steak[topic] !== undefined && !dupeTopics.has(topic) && (steak[topic].outputsToAdmit.length !== 0 || steak[topic].coinsRemoved?.length !== 0)
    )

    if (relevantTopics.length === 0) {
      this.endTime(`transactionPropagation_${txid.substring(0, 10)}`)
      return steak
    }

    // Create a SHIPBroadcaster instance
    let customBroadcasterConfig
    if (Array.isArray(this.slapTrackers)) {
      // Custom SLAP trackers warrant a custom broadcaster config
      const resolverConfig: LookupResolverConfig = {
        slapTrackers: this.slapTrackers
      }
      customBroadcasterConfig = {
        resolver: new LookupResolver(resolverConfig)
      }
    }
    const shipBroadcaster = new SHIPBroadcaster(relevantTopics, customBroadcasterConfig)

    try {
      await shipBroadcaster.broadcast(tx)
    } catch (error) {
      this.logger.error('Error during propagation to other nodes:', error)
    }
    this.endTime(`transactionPropagation_${txid.substring(0, 10)}`)

    // Immediately return from the function without waiting for the promises to resolve.
    return steak
  }

  /**
   * Submit a lookup question to the Overlay Services Engine, and receive back a Lookup Answer
   * @param LookupQuestion — The question to ask the Overlay Services Engine
   * @returns The answer to the question
   */
  async lookup(lookupQuestion: LookupQuestion): Promise<LookupAnswer> {
    // Validate a lookup service for the provider is found
    const lookupService = this.lookupServices[lookupQuestion.service]
    if (lookupService === undefined || lookupService === null) throw new Error(`Lookup service not found for provider: ${lookupQuestion.service}`)

    const lookupResult = await lookupService.lookup(lookupQuestion)
    const hydrationContext = this.createUTXOHistoryHydrationContext()
    await this.preloadOutputsWithBEEF(
      lookupResult.map(({ txid, outputIndex }) => ({ txid, outputIndex })),
      hydrationContext
    )
    const hydratedOutputs = (await Promise.all(
      lookupResult.map(async ({ txid, outputIndex, history, context }) => {
        const UTXO = await this.loadOutputWithBEEF(txid, outputIndex, hydrationContext)
        if (UTXO === null) {
          return null
        }

        // Get the history for this utxo and construct a BEEF
        const output = await this.getUTXOHistory(UTXO, history, 0, hydrationContext)
        if (output?.beef === undefined) {
          return null
        }

        return {
          beef: output.beef,
          outputIndex: output.outputIndex,
          context
        }
      })
    ))
      .filter((output): output is { beef: number[], outputIndex: number, context: number[] | undefined } => output !== null)
      .map(({ beef, outputIndex, context }) => (
        context === undefined
          ? { beef, outputIndex }
          : { beef, outputIndex, context }
      ))
    return {
      type: 'output-list',
      outputs: hydratedOutputs
    }
  }

  private createUTXOHistoryHydrationContext(): UTXOHistoryHydrationContext {
    return {
      outputCache: new Map<string, Promise<Output | null>>()
    }
  }

  private toOutputCacheKey(txid: string, outputIndex: number): string {
    return `${txid}:${outputIndex}`
  }

  private async preloadOutputsWithBEEF(
    outpoints: Array<{ txid: string, outputIndex: number }>,
    context: UTXOHistoryHydrationContext
  ): Promise<void> {
    if (outpoints.length === 0) {
      return
    }

    const deduped: Array<{ txid: string, outputIndex: number }> = []
    const seen = new Set<string>()

    for (const outpoint of outpoints) {
      const cacheKey = this.toOutputCacheKey(outpoint.txid, outpoint.outputIndex)
      if (seen.has(cacheKey)) {
        continue
      }
      seen.add(cacheKey)
      if (!context.outputCache.has(cacheKey)) {
        deduped.push(outpoint)
      }
    }

    if (deduped.length === 0) {
      return
    }

    const findOutputsByOutpoints = this.storage.findOutputsByOutpoints
    if (typeof findOutputsByOutpoints === 'function') {
      const outputs = await findOutputsByOutpoints.call(this.storage, deduped, true)
      const outputsByKey = new Map<string, Output>()
      for (const output of outputs) {
        outputsByKey.set(this.toOutputCacheKey(output.txid, output.outputIndex), output)
      }

      for (const outpoint of deduped) {
        const cacheKey = this.toOutputCacheKey(outpoint.txid, outpoint.outputIndex)
        context.outputCache.set(cacheKey, Promise.resolve(outputsByKey.get(cacheKey) ?? null))
      }
      return
    }

    for (const outpoint of deduped) {
      const cacheKey = this.toOutputCacheKey(outpoint.txid, outpoint.outputIndex)
      context.outputCache.set(
        cacheKey,
        this.storage.findOutput(outpoint.txid, outpoint.outputIndex, undefined, undefined, true)
      )
    }
  }

  private async loadOutputWithBEEF(
    txid: string,
    outputIndex: number,
    context: UTXOHistoryHydrationContext
  ): Promise<Output | null> {
    const cacheKey = this.toOutputCacheKey(txid, outputIndex)
    let cached = context.outputCache.get(cacheKey)
    if (cached === undefined) {
      cached = this.storage.findOutput(txid, outputIndex, undefined, undefined, true)
      context.outputCache.set(cacheKey, cached)
    }
    const output = await cached
    return output ?? null
  }

  private async hydrateUTXOHistoryNode(
    output: Output,
    historySelector: ((beef: number[], outputIndex: number, currentDepth: number) => Promise<boolean>) | number,
    currentDepth: number,
    context: UTXOHistoryHydrationContext
  ): Promise<HydratedUTXOHistoryNode | undefined> {
    if (output.beef === undefined) {
      throw new Error('Output must have associated transaction BEEF!')
    }

    let shouldTraverseHistory: boolean
    if (typeof historySelector === 'number') {
      shouldTraverseHistory = currentDepth <= historySelector
    } else {
      shouldTraverseHistory = await historySelector(output.beef, output.outputIndex, currentDepth)
    }

    if (shouldTraverseHistory === false) {
      return undefined
    }

    await this.preloadOutputsWithBEEF(output.outputsConsumed, context)

    const childNodes = (await Promise.all(
      output.outputsConsumed.map(async (outputIdentifier) => {
        const childOutput = await this.loadOutputWithBEEF(outputIdentifier.txid, outputIdentifier.outputIndex, context)
        if (childOutput === null) {
          return undefined
        }

        return await this.hydrateUTXOHistoryNode(childOutput, historySelector, currentDepth + 1, context)
      })
    )).filter((node): node is HydratedUTXOHistoryNode => node !== undefined)

    const tx = Transaction.fromBEEF(output.beef)
    const inputIndexBySource = new Map<string, number>()
    tx.inputs.forEach((candidateInput, index) => {
      const sourceTXID = candidateInput.sourceTXID !== undefined && candidateInput.sourceTXID !== ''
        ? candidateInput.sourceTXID
        : candidateInput.sourceTransaction?.id('hex')

      if (sourceTXID === undefined) {
        return
      }

      inputIndexBySource.set(`${sourceTXID}:${candidateInput.sourceOutputIndex}`, index)
    })

    for (const child of childNodes) {
      const inputIndex = inputIndexBySource.get(`${child.output.txid}:${child.output.outputIndex}`)

      if (inputIndex === -1 || inputIndex == null) {
        continue
      }

      const targetInput = tx.inputs[inputIndex]
      if (!targetInput) {
        this.logger.error(`Input at index ${inputIndex} is undefined, but findIndex found it. Possible sparse array from BEEF parsing.`)
        continue
      }

      targetInput.sourceTransaction = child.transaction
    }

    return { output, transaction: tx }
  }

  /**
   * Ensures alignment between the current SHIP/SLAP advertisements and the
   * configured Topic Managers and Lookup Services in the engine.
   *
   * This method performs the following actions:
   * 1. Retrieves the current configuration of topics and services.
   * 2. Fetches the existing SHIP advertisements for each configured topic.
   * 3. Fetches the existing SLAP advertisements for each configured service.
   * 4. Compares the current configuration with the fetched advertisements to determine which advertisements
   *    need to be created or revoked.
   * 5. Creates new SHIP/SLAP advertisements if they do not exist for the configured topics/services.
   * 6. Revokes existing SHIP/SLAP advertisements if they are no longer required based on the current configuration.
   *
   * The function uses the `Advertiser` methods to create or revoke advertisements and ensures the updates are
   * submitted to the SHIP/SLAP overlay networks using the engine's `submit()` method.
   *
   * @throws Will throw an error if there are issues during the advertisement synchronization process.
   * @returns {Promise<void>} A promise that resolves when the synchronization process is complete.
   */
  async syncAdvertisements(): Promise<void> {
    if (
      this.advertiser === undefined ||
      typeof this.hostingURL !== 'string' ||
      this.hostingURL.length < 1 ||
      !this.isValidUrl(this.hostingURL)
    ) {
      return
    }
    const advertiser = this.advertiser

    // Step 1: Retrieve Current Configuration
    let configuredTopics = Object.keys(this.managers)
    let configuredServices = Object.keys(this.lookupServices)

    // Filter out default SHIP/SLAP topics/services if suppressDefaultSyncAdvertisements is true
    if (this.suppressDefaultSyncAdvertisements === true) {
      configuredTopics = configuredTopics.filter(topic => topic !== 'tm_ship' && topic !== 'tm_slap')
      configuredServices = configuredServices.filter(service => service !== 'ls_ship' && service !== 'ls_slap')
    }

    // Step 2: Fetch Existing Advertisements
    const currentSHIPAdvertisements = await advertiser.findAllAdvertisements('SHIP')
    const currentSLAPAdvertisements = await advertiser.findAllAdvertisements('SLAP')

    // Step 3: Compare and Determine Actions
    const requiredSHIPAdvertisements = new Set(configuredTopics)
    const requiredSLAPAdvertisements = new Set(configuredServices)

    const shipsToCreate = Array.from(requiredSHIPAdvertisements).filter(topicOrService => !currentSHIPAdvertisements.some(x => x.topicOrService === topicOrService && x.domain === this.hostingURL))
    const slapsToCreate = Array.from(requiredSLAPAdvertisements).filter(topicOrService => !currentSLAPAdvertisements.some(x => x.topicOrService === topicOrService && x.domain === this.hostingURL))
    const shipsToRevoke = currentSHIPAdvertisements.filter(ad => !requiredSHIPAdvertisements.has(ad.topicOrService))
    const slapsToRevoke = currentSLAPAdvertisements.filter(ad => !requiredSLAPAdvertisements.has(ad.topicOrService))

    // Create needed SHIP/SLAP advertisements
    try {
      if (shipsToCreate.length > 0 || slapsToCreate.length > 0) {
        const advertisementData: AdvertisementData[] = [
          ...shipsToCreate.map(topic => ({
            protocol: 'SHIP' as const,
            topicOrServiceName: topic
          })),
          ...slapsToCreate.map(service => ({
            protocol: 'SLAP' as const,
            topicOrServiceName: service
          }))
        ]
        const taggedBEEF = await advertiser.createAdvertisements(advertisementData)
        await this.submit(taggedBEEF)
      }
    } catch (error) {
      this.logger.error('Failed to create SHIP advertisement:', error)
    }

    // Revoke all advertisements to revoke
    try {
      if (shipsToRevoke.length > 0 || slapsToRevoke.length > 0) {
        const taggedBEEF = await advertiser.revokeAdvertisements([...shipsToRevoke, ...slapsToRevoke])
        await this.submit(taggedBEEF)
      }
    } catch (error) {
      this.logger.error('Failed to revoke SHIP/SLAP advertisements:', error)
    }
  }

  /**
   * This method goes through each topic that we support syncing and attempts to sync with each endpoint
   * associated with that topic. If the sync configuration is 'SHIP', it will sync to all peers that support
   * the topic.
   *
   * @throws Error if the overlay service engine is not configured for topical synchronization.
   */
  async startGASPSync(): Promise<void> {
    if (this.syncConfiguration === undefined) {
      throw new Error('Overlay Service Engine not configured for topical synchronization!')
    }

    for (const topic of Object.keys(this.syncConfiguration)) {
      // Make sure syncEndpoints is an array or SHIP
      let syncEndpoints: string[] | string | false = this.syncConfiguration[topic]

      // Check if this topic has been configured NOT to sync
      if (syncEndpoints === false) {
        continue
      }

      if (syncEndpoints === 'SHIP') {
        // Perform lookup and find ship advertisements to set syncEndpoints for topic
        const resolverConfig: LookupResolverConfig = this.slapTrackers
          ? { slapTrackers: this.slapTrackers }
          : {}

        const resolver = new LookupResolver(resolverConfig)
        const lookupAnswer: LookupAnswer = await resolver.query({
          service: 'ls_ship',
          query: {
            topics: [topic]
          }
        })

        // Lookup will currently always return type output-list
        if (lookupAnswer.type === 'output-list') {
          const endpointSet = new Set<string>()

          lookupAnswer.outputs.forEach(output => {
            try {
              // Parse out the advertisements using the provided parser
              const tx = Transaction.fromBEEF(output.beef)
              const advertisement = this.advertiser?.parseAdvertisement(tx.outputs[output.outputIndex].lockingScript)
              if (advertisement?.protocol === 'SHIP') {
                endpointSet.add(advertisement.domain)
              }
            } catch (error) {
              this.logger.error('Failed to parse advertisement output:', error)
            }
          })

          syncEndpoints = Array.from(endpointSet)
        }
      }

      // Now syncEndpoints is guaranteed to be an array of strings without duplicates
      if (Array.isArray(syncEndpoints)) {
        // Remove our own hosting URL so we don't sync with ourselves
        syncEndpoints = syncEndpoints.filter((endpoint) => endpoint !== this.hostingURL)

        this.logger.info(`[GASP SYNC] Will attempt to sync with ${syncEndpoints.length} peer${syncEndpoints.length === 1 ? '' : 's'}`)
        // Sync with each endpoint individually to avoid parallel locks and let failures be isolated
        for (const endpoint of syncEndpoints) {
          this.logger.info(`[GASP SYNC] Starting sync for topic "${topic}" with peer "${endpoint}"`)

          try {
            // Read the last interaction score from storage
            const lastInteraction = await this.storage.getLastInteraction(endpoint, topic)

            const gasp = new GASP(
              new OverlayGASPStorage(topic, this),
              new OverlayGASPRemote(endpoint, topic),
              lastInteraction,
              `[GASP Sync of ${topic} with ${endpoint}]`,
              true,
              true
            )
            await gasp.sync(endpoint, DEFAULT_GASP_SYNC_LIMIT)

            // Save the updated last interaction score
            if (gasp.lastInteraction > lastInteraction) {
              await this.storage.updateLastInteraction(endpoint, topic, gasp.lastInteraction)
            }

            this.logger.info(`[GASP SYNC] Sync successful for topic "${topic}" with peer "${endpoint}"`)
          } catch (err) {
            this.logger.error(
              `[GASP SYNC] Sync failed for topic "${topic}" with peer "${endpoint}"`,
              err
            )
            // Continue on to the next endpoint without throwing
          }
        }
      }
    }
  }

  private async resolveSyncEndpointsForTopic(topic: string): Promise<string[]> {
    if (this.syncConfiguration === undefined) {
      return []
    }

    let syncEndpoints: string[] | string | false = this.syncConfiguration[topic]
    if (syncEndpoints === false || syncEndpoints === undefined) {
      return []
    }

    if (syncEndpoints === 'SHIP') {
      const resolverConfig: LookupResolverConfig = this.slapTrackers
        ? { slapTrackers: this.slapTrackers }
        : {}
      const resolver = new LookupResolver(resolverConfig)
      const lookupAnswer: LookupAnswer = await resolver.query({
        service: 'ls_ship',
        query: {
          topics: [topic]
        }
      })

      const endpointSet = new Set<string>()
      if (lookupAnswer.type === 'output-list') {
        lookupAnswer.outputs.forEach(output => {
          try {
            const tx = Transaction.fromBEEF(output.beef)
            const advertisement = this.advertiser?.parseAdvertisement(tx.outputs[output.outputIndex].lockingScript)
            if (advertisement?.protocol === 'SHIP') {
              endpointSet.add(advertisement.domain)
            }
          } catch (error) {
            this.logger.error('Failed to parse BASM advertisement output:', error)
          }
        })
      }
      syncEndpoints = Array.from(endpointSet)
    }

    if (!Array.isArray(syncEndpoints)) {
      return []
    }

    return syncEndpoints.filter(endpoint => endpoint !== this.hostingURL)
  }

  async provideTopicAnchorTip(topic: string): Promise<TopicAnchorTip> {
    const tip = await this.storage.findTopicAnchorTip?.(topic)
    return tip ?? {
      topic,
      blockHeight: -1,
      tac: BASM_ZERO_HASH
    }
  }

  async provideTopicAnchorRange(topic: string, fromHeight: number, toHeight: number): Promise<TopicAnchorRangeResponse> {
    if (typeof this.storage.findTopicBlockAnchors !== 'function') {
      throw new TypeError('Storage does not support BASM topic anchor ranges')
    }
    if (!Number.isInteger(fromHeight) || !Number.isInteger(toHeight) || fromHeight < 0 || toHeight < fromHeight) {
      throw new Error('Invalid topic anchor range')
    }
    if (toHeight - fromHeight + 1 > DEFAULT_BASM_RANGE_LIMIT) {
      throw new Error(`Topic anchor range is capped at ${DEFAULT_BASM_RANGE_LIMIT} heights`)
    }

    return {
      topic,
      anchors: await this.storage.findTopicBlockAnchors(topic, fromHeight, toHeight)
    }
  }

  async provideAdmittedList(topic: string, blockHeight: number, blockHash?: string): Promise<AdmittedListResponse> {
    if (typeof this.storage.findAdmittedTransactionsForBlock !== 'function') {
      throw new TypeError('Storage does not support BASM admitted lists')
    }

    return {
      topic,
      blockHeight,
      blockHash,
      admitted: await this.storage.findAdmittedTransactionsForBlock(topic, blockHeight, blockHash)
    }
  }

  async provideCompoundMerklePath(topic: string, blockHeight: number, txids: string[]): Promise<CompoundMerklePathResponse> {
    if (typeof this.storage.findTransactionMerklePaths !== 'function') {
      throw new TypeError('Storage does not support direct Merkle path lookup')
    }
    if (txids.length === 0) {
      throw new Error('At least one txid is required')
    }

    const admitted = await this.storage.findAdmittedTransactionsForBlock?.(topic, blockHeight)
    if (admitted !== undefined) {
      const admittedSet = new Set(admitted.map(item => item.txid))
      const missingAdmissions = txids.filter(txid => !admittedSet.has(txid))
      if (missingAdmissions.length > 0) {
        throw new Error(`Requested txids are not admitted to topic ${topic} at height ${blockHeight}: ${missingAdmissions.join(',')}`)
      }
    }

    const proofs = await this.storage.findTransactionMerklePaths(txids)
    const proofByTxid = new Map(proofs.map(proof => [proof.txid, proof]))
    const missing = txids.filter(txid => !proofByTxid.has(txid))
    if (missing.length > 0) {
      throw new Error(`No direct Merkle path found for txids: ${missing.join(',')}`)
    }

    let compound: MerklePath | undefined
    for (const txid of txids) {
      const proof = proofByTxid.get(txid)
      if (proof === undefined) continue
      const path = MerklePath.fromHex(proof.merklePath)
      if (path.blockHeight !== blockHeight) {
        throw new Error(`Merkle path for ${txid} is at height ${path.blockHeight}, expected ${blockHeight}`)
      }
      if (compound === undefined) {
        compound = path
      } else {
        compound.combine(path)
      }
    }

    if (compound === undefined) {
      throw new Error('Unable to build compound Merkle path')
    }

    return {
      topic,
      blockHeight,
      txids,
      merklePath: compound.toHex()
    }
  }

  async provideRawTransactions(txids: string[]): Promise<RawTransactionResponse> {
    if (typeof this.storage.findRawTransactions !== 'function') {
      throw new TypeError('Storage does not support raw transaction lookup')
    }

    const transactions = await this.storage.findRawTransactions(txids)
    const found = new Set(transactions.map(tx => tx.txid))
    return {
      transactions,
      missing: txids.filter(txid => !found.has(txid))
    }
  }

  async startBASMSync(): Promise<BASMPeerSyncReport[]> {
    if (this.syncConfiguration === undefined) {
      throw new Error('Overlay Service Engine not configured for topical synchronization!')
    }

    const reports: BASMPeerSyncReport[] = []
    for (const topic of Object.keys(this.syncConfiguration)) {
      const endpoints = await this.resolveSyncEndpointsForTopic(topic)
      for (const endpoint of endpoints) {
        reports.push(await this.reconcileBASMWithPeer(topic, endpoint))
      }
    }

    return reports
  }

  private async reconcileBASMWithPeer(topic: string, endpoint: string): Promise<BASMPeerSyncReport> {
    const report: BASMPeerSyncReport = {
      topic,
      endpoint,
      status: 'skipped',
      checkedHeights: [],
      missingTxids: [],
      fetchedTxCount: 0
    }

    try {
      const remote = new BASMRemote(endpoint, topic)
      const [localTip, remoteTip] = await Promise.all([
        this.provideTopicAnchorTip(topic),
        remote.requestTopicAnchorTip()
      ])
      report.localTip = localTip
      report.remoteTip = remoteTip

      if (localTip.blockHeight >= remoteTip.blockHeight) {
        report.status = localTip.tac === remoteTip.tac && localTip.blockHeight === remoteTip.blockHeight ? 'matched' : 'diverged'
        report.message = report.status === 'matched'
          ? 'Topic anchor tips match'
          : 'Remote tip is not ahead; historical divergence needs manual or binary-search reconciliation'
        return report
      }

      const fromHeight = Math.max(localTip.blockHeight + 1, remoteTip.blockHeight - DEFAULT_BASM_RANGE_LIMIT + 1, 0)
      const range = await remote.requestTopicAnchorRange(fromHeight, remoteTip.blockHeight)
      for (const remoteAnchor of range.anchors) {
        await this.reconcileRemoteAnchor(topic, remote, remoteAnchor, report)
      }

      const refreshedTip = await this.provideTopicAnchorTip(topic)
      report.localTip = refreshedTip
      report.status = refreshedTip.blockHeight >= remoteTip.blockHeight && refreshedTip.tac === remoteTip.tac ? 'matched' : 'advanced'
      return report
    } catch (error) {
      report.status = 'error'
      report.message = error instanceof Error ? error.message : String(error)
      this.logger.error(`[BASM SYNC] Sync failed for topic "${topic}" with peer "${endpoint}"`, error)
      return report
    }
  }

  private async reconcileRemoteAnchor(
    topic: string,
    remote: BASMRemote,
    remoteAnchor: TopicBlockAnchor,
    report: BASMPeerSyncReport
  ): Promise<void> {
    report.checkedHeights.push(remoteAnchor.blockHeight)
    const localAnchor = await this.storage.findTopicBlockAnchor?.(topic, remoteAnchor.blockHeight, remoteAnchor.blockHash)
    if (localAnchor?.tac === remoteAnchor.tac) {
      return
    }

    const admittedResponse = await remote.requestAdmittedList(remoteAnchor.blockHeight, remoteAnchor.blockHash)
    const remoteBasmRoot = computeBasmRoot(admittedResponse.admitted)
    if (
      remoteBasmRoot !== remoteAnchor.basmRoot ||
      admittedResponse.admitted.length !== remoteAnchor.admittedCount
    ) {
      throw new Error(`Peer ${report.endpoint} supplied an admitted list inconsistent with its anchor at height ${remoteAnchor.blockHeight}`)
    }

    const localAdmitted = await this.storage.findAdmittedTransactionsForBlock?.(topic, remoteAnchor.blockHeight, remoteAnchor.blockHash) ?? []
    const localTxids = new Set(localAdmitted.map(item => item.txid))
    const missingTxids = admittedResponse.admitted
      .map(item => item.txid)
      .filter(txid => !localTxids.has(txid))

    report.missingTxids.push(...missingTxids)
    if (missingTxids.length === 0) {
      report.status = 'diverged'
      return
    }

    await this.fetchBASMMissingTransactions(remote, topic, remoteAnchor, missingTxids)
    report.fetchedTxCount += missingTxids.length
  }

  private async fetchBASMMissingTransactions(
    remote: BASMRemote,
    topic: string,
    anchor: TopicBlockAnchor,
    txids: string[]
  ): Promise<void> {
    if (this.chainTracker === 'scripts only') {
      throw new Error('BASM reconciliation requires a ChainTracker capable of validating BUMP proofs')
    }

    const proofResponse = await remote.requestCompoundMerklePath(anchor.blockHeight, txids)
    const compoundPath = MerklePath.fromHex(proofResponse.merklePath)
    for (const txid of txids) {
      const valid = await compoundPath.verify(txid, this.chainTracker)
      if (!valid) {
        throw new Error(`Peer supplied invalid compound Merkle path for ${txid} at height ${anchor.blockHeight}`)
      }
    }

    const rawResponse = await remote.requestRawTransactions(txids)
    if (rawResponse.missing.length > 0) {
      throw new Error(`Peer did not return raw transactions for txids: ${rawResponse.missing.join(',')}`)
    }

    for (const record of rawResponse.transactions) {
      const tx = Transaction.fromHex(record.rawTx)
      if (tx.id('hex') !== record.txid) {
        throw new Error(`Raw transaction txid mismatch: expected ${record.txid}, got ${tx.id('hex')}`)
      }
      try {
        tx.merklePath = compoundPath.extract([record.txid])
      } catch {
        tx.merklePath = compoundPath
      }
      await this.submit({ beef: tx.toBEEF(), topics: [topic] }, undefined, 'historical-tx')
    }
  }

  async evictUnprovenTransactions(options: {
    topic?: string
    thresholdBlocks?: number
  } = {}): Promise<{
      cutoffHeight: number
      candidates: number
      evictedTransactions: number
      evictedOutputs: number
    }> {
    if (typeof this.storage.findUnprovenAppliedTransactions !== 'function') {
      throw new TypeError('Storage does not support unproven transaction eviction')
    }
    if (this.chainTracker === 'scripts only') {
      throw new Error('Unproven eviction requires a ChainTracker to determine block age')
    }

    const thresholdBlocks = options.thresholdBlocks ?? this.unprovenEvictionBlocks
    const currentHeight = await this.chainTracker.currentHeight()
    const cutoffHeight = currentHeight - thresholdBlocks
    const candidates = await this.storage.findUnprovenAppliedTransactions(cutoffHeight, options.topic)
    let evictedOutputs = 0

    for (const candidate of candidates) {
      for (const output of candidate.outputs) {
        for (const service of Object.values(this.lookupServices)) {
          try {
            await service.outputEvicted(output.txid, output.outputIndex)
          } catch (error) {
            this.logger.debug(`outputEvicted notification failed for ${output.txid}.${output.outputIndex}: ${error}`)
          }
        }
        await this.storage.deleteOutput(output.txid, output.outputIndex, candidate.topic)
        evictedOutputs++
      }
      await this.storage.deleteAppliedTransaction?.(candidate.txid, candidate.topic)
    }

    return {
      cutoffHeight,
      candidates: candidates.length,
      evictedTransactions: candidates.length,
      evictedOutputs
    }
  }

  async refreshUnprovenTransactionProofs(options: {
    topic?: string
    thresholdBlocks?: number
    proofProvider: (txid: string) => Promise<{ merklePath: MerklePath, blockHeight?: number } | undefined>
  }): Promise<{
      cutoffHeight: number
      candidates: number
      refreshedTransactions: number
      missingProofs: number
      failedProofs: number
      failures: Array<{ txid: string, error: string }>
    }> {
    if (typeof this.storage.findUnprovenAppliedTransactions !== 'function') {
      throw new TypeError('Storage does not support unproven transaction lookup')
    }
    if (this.chainTracker === 'scripts only') {
      throw new Error('Unproven proof refresh requires a ChainTracker to determine block age')
    }

    const thresholdBlocks = options.thresholdBlocks ?? this.unprovenEvictionBlocks
    const currentHeight = await this.chainTracker.currentHeight()
    const cutoffHeight = currentHeight - thresholdBlocks
    const candidates = await this.storage.findUnprovenAppliedTransactions(cutoffHeight, options.topic)
    const txids = [...new Set(candidates.map(candidate => candidate.txid))]
    let refreshedTransactions = 0
    let missingProofs = 0
    let failedProofs = 0
    const failures: Array<{ txid: string, error: string }> = []

    for (const txid of txids) {
      try {
        const proof = await options.proofProvider(txid)
        if (proof === undefined) {
          missingProofs++
          continue
        }
        await this.handleNewMerkleProof(txid, proof.merklePath, proof.blockHeight)
        refreshedTransactions++
      } catch (error) {
        failedProofs++
        failures.push({
          txid,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return {
      cutoffHeight,
      candidates: candidates.length,
      refreshedTransactions,
      missingProofs,
      failedProofs,
      failures
    }
  }

  async maintainUnprovenTransactions(options: {
    topic?: string
    thresholdBlocks?: number
    proofProvider: (txid: string) => Promise<{ merklePath: MerklePath, blockHeight?: number } | undefined>
  }): Promise<{
      refresh: {
        cutoffHeight: number
        candidates: number
        refreshedTransactions: number
        missingProofs: number
        failedProofs: number
        failures: Array<{ txid: string, error: string }>
      }
      eviction: {
        cutoffHeight: number
        candidates: number
        evictedTransactions: number
        evictedOutputs: number
      }
    }> {
    const refresh = await this.refreshUnprovenTransactionProofs(options)
    const eviction = await this.evictUnprovenTransactions({
      topic: options.topic,
      thresholdBlocks: options.thresholdBlocks
    })
    return { refresh, eviction }
  }

  async evictAppliedTransaction(txid: string, options: {
    topic?: string
    reason?: string
  } = {}): Promise<{
      txid: string
      reason?: string
      evictedTransactions: number
      evictedOutputs: number
    }> {
    if (typeof this.storage.deleteAppliedTransaction !== 'function') {
      throw new TypeError('Storage does not support applied transaction eviction')
    }

    const outputs = await this.storage.findOutputsForTransaction(txid)
    const filtered = options.topic === undefined
      ? outputs
      : outputs.filter(output => output.topic === options.topic)
    const topics = [...new Set(filtered.map(output => output.topic))]
    let evictedOutputs = 0

    for (const output of filtered) {
      for (const service of Object.values(this.lookupServices)) {
        try {
          await service.outputEvicted(output.txid, output.outputIndex)
        } catch (error) {
          this.logger.debug(`outputEvicted notification failed for ${output.txid}.${output.outputIndex}: ${error}`)
        }
      }
      await this.storage.deleteOutput(output.txid, output.outputIndex, output.topic)
      evictedOutputs++
    }

    for (const topic of topics) {
      await this.storage.deleteAppliedTransaction(txid, topic)
    }

    return {
      txid,
      reason: options.reason,
      evictedTransactions: topics.length,
      evictedOutputs
    }
  }

  /**
   * Given a GASP request, create an initial response.
   *
   * This method processes an initial synchronization request by finding the relevant UTXOs for the given topic
   * since the provided block height in the request. It constructs a response that includes a list of these UTXOs
   * and the min block height from the initial request.
   *
   * @param initialRequest - The GASP initial request containing the version and the block height since the last sync.
   * @param topic - The topic for which UTXOs are being requested.
   * @returns A promise that resolves to a GASPInitialResponse containing the list of UTXOs and the provided min block height.
   */
  async provideForeignSyncResponse(initialRequest: GASPInitialRequest, topic: string): Promise<GASPInitialResponse> {
    const outputs = await this.storage.findUTXOsForTopic(topic, initialRequest.since, initialRequest.limit)

    return {
      UTXOList: outputs.map(output => ({
        txid: output.txid,
        outputIndex: output.outputIndex,
        score: output.score ?? 0
      })),
      since: initialRequest.since
    }
  }

  /**
   * Provides a GASPNode for the given graphID, transaction ID, and output index.
   *
   * @param graphID - The identifier for the graph to which this node belongs (in the format txid.outputIndex).
   * @param txid - The transaction ID for the requested output from somewhere within the graph's history.
   * @param outputIndex - The index of the output in the transaction.
   * @returns A promise that resolves to a GASPNode containing the raw transaction and other optional data.
   * @throws An error if no output is found for the given transaction ID and output index.
   */
  async provideForeignGASPNode(graphID: string, txid: string, outputIndex: number): Promise<GASPNode> {
    const hydrator = async (output: Output | null): Promise<GASPNode> => {
      if (output?.beef === undefined) {
        throw new Error('No matching output found!')
      }

      const rootTx = Transaction.fromBEEF(output.beef)
      let correctTx: Transaction | undefined

      const searchInput = (tx: Transaction): void => {
        if (tx.id('hex') === txid) {
          correctTx = tx
        } else {
          // For each input, look it up and recurse.
          for (const input of tx.inputs) {
            // We should always have a source transaction
            if (input.sourceTransaction === undefined) {
              throw new Error('Incomplete SPV data!')
            } else {
              searchInput(input.sourceTransaction)
            }
          }
        }
      }

      searchInput(rootTx)

      if (correctTx === undefined) {
        // Recursively try to find a matching output
        let foundNode: GASPNode | undefined
        for (const currentOutput of output.outputsConsumed) {
          try {
            const outputFound = await this.storage.findOutput(currentOutput.txid, currentOutput.outputIndex, undefined, undefined, true)
            foundNode = await hydrator(outputFound)
            break
          } catch (error) {
            // Best-effort: output may not be found or hydration fails for this candidate; try the next one
            this.logger.debug(`Unable to hydrate output ${currentOutput.txid}.${currentOutput.outputIndex}: ${error}`)
            continue
          }
        }
        if (foundNode !== undefined) {
          return foundNode
        }
      } else {
        const rawTx = correctTx.toHex()
        const node: GASPNode = {
          rawTx,
          graphID,
          outputIndex
        }
        if (correctTx.merklePath !== undefined) {
          node.proof = correctTx.merklePath.toHex()
        }

        return node
      }
      throw new Error('Unable to find output associated with your request!')
    }

    const [rootTxid, rootOutputIndex] = graphID.split('.')
    const output = await this.storage.findOutput(rootTxid, Number(rootOutputIndex), undefined, undefined, true)
    return await hydrator(output)
  }

  /**
   * Traverse and return the history of a UTXO.
   *
   * This method traverses the history of a given Unspent Transaction Output (UTXO) and returns
   * its historical data based on the provided history selector and current depth.
   *
   * @param output - The UTXO to traverse the history for.
   * @param historySelector - Optionally directs the history traversal:
   *  - If a number, denotes how many previous spends (in terms of chain depth) to include.
   *  - If a function, accepts a BEEF-formatted transaction, an output index, and the current depth as parameters,
   *    returning a promise that resolves to a boolean indicating whether to include the output in the history.
   * @param {number} [currentDepth=0] - The current depth of the traversal relative to the top-level UTXO.
   *
   * @returns {Promise<Output | undefined>} - A promise that resolves to the output history if found, or undefined if not.
  */
  async getUTXOHistory(
    output: Output,
    historySelector?: ((beef: number[], outputIndex: number, currentDepth: number) => Promise<boolean>) | number,
    currentDepth = 0,
    context: UTXOHistoryHydrationContext = this.createUTXOHistoryHydrationContext()
  ): Promise<Output | undefined> {
    // If we have an output but no history selector, just return the output.
    if (historySelector === undefined) {
      return output
    }

    try {
      if (output.beef === undefined) {
        throw new Error('Output must have associated transaction BEEF!')
      }

      const hydratedNode = await this.hydrateUTXOHistoryNode(output, historySelector, currentDepth, context)
      if (hydratedNode === undefined) {
        return undefined
      }

      return {
        ...hydratedNode.output,
        beef: hydratedNode.transaction.toBEEF()
      }
    } catch (e) {
      // Handle any errors that occurred
      // Note: Test this!
      this.logger.error(`Error retrieving UTXO history: ${e} `)
      // return []
      throw new Error(`Error retrieving UTXO history: ${e} `)
    }
  }

  /**
   * Delete a UTXO and all stale consumed inputs.
   * @param output - The UTXO to be deleted.
   * @returns {Promise<void>} - A promise that resolves when the deletion process is complete.
   */
  private async deleteUTXODeep(output: Output): Promise<void> {
    try {
      // Delete the current output IFF there are no references to it
      if (output.consumedBy.length === 0) {
        await this.storage.deleteOutput(output.txid, output.outputIndex, output.topic)

        // Notify the lookup services of the UTXO being deleted
        for (const l of Object.values(this.lookupServices)) {
          try {
            await l.outputNoLongerRetainedInHistory?.(
              output.txid,
              output.outputIndex,
              output.topic
            )
          } catch (e) {
            // Best-effort notification; lookup service failure must not abort UTXO deletion
            this.logger.debug(`outputNoLongerRetainedInHistory notification failed for ${output.txid}.${output.outputIndex}: ${e}`)
          }
        }
      }

      // If there are no more consumed utxos, return
      if (output.outputsConsumed.length === 0) {
        return
      }

      // Delete any stale outputs that were consumed as inputs
      await Promise.all(output.outputsConsumed.map(async (outputIdentifier) => {
        const staleOutput = await this.storage.findOutput(outputIdentifier.txid, outputIdentifier.outputIndex, output.topic)

        // Make sure an output was found
        if (staleOutput === null || staleOutput === undefined) {
          return undefined
        }

        // Parse out the existing data, then concat the new outputs with no duplicates
        if (staleOutput.consumedBy.length !== 0) {
          staleOutput.consumedBy = staleOutput.consumedBy.filter(x => x.txid !== output.txid && x.outputIndex !== output.outputIndex)
          // Update with the new consumedBy data
          await this.storage.updateConsumedBy(outputIdentifier.txid, outputIdentifier.outputIndex, output.topic, staleOutput.consumedBy)
        }

        // Find previousUTXO history
        return await this.deleteUTXODeep(staleOutput)
      }))
    } catch (error) {
      throw new Error(`Failed to delete all stale outputs: ${error as string} `)
    }
  }

  /**
   * Given a new transaction proof (txid, proof),
   * update tx.merklePath if appropriate,
   * and if not, recurse through all input sourceTransactions.
   *
   * @param tx transaction which may benefit from new proof.
   * @param txid BE hex string double hash of transaction proven by proof.
   * @param proof for txid
   */
  private updateInputProofs(tx: Transaction, txid: string, proof: MerklePath): void {
    if (tx.id('hex') === txid) {
      // Update the merkle path to handle potential reorgs
      tx.merklePath = proof
      return
    }
    // A mined transaction's source graph is no longer part of its BEEF. Do not
    // replace an unrelated transaction's proof with the proof for an ancestor.
    if (tx.merklePath !== undefined) return

    for (const input of tx.inputs) {
      // All inputs must have sourceTransactions
      const stx = input.sourceTransaction
      if (typeof stx !== 'object') continue
      this.updateInputProofs(stx, txid, proof)
    }
  }

  /**
   * Recursively updates beefs (merkle proofs) of this output and its consumedBy lineage.
   *
   * @param output - An output derived from txid which may benefit from new proof.
   * @param txid - The txid for which proof is a valid merkle path.
   * @param proof - The merklePath proving txid is a mined transaction hash
   */
  private async updateMerkleProof(output: Output, txid: string, proof: MerklePath): Promise<void> {
    if (output.beef === undefined) {
      throw new Error('Output must have associated transaction BEEF!')
    }

    const tx = Transaction.fromBEEF(output.beef)
    // Update this transaction, or recursively update the matching source
    // transaction. This also persists replacement proofs after a reorg.
    this.updateInputProofs(tx, txid, proof)

    // Update the output's BEEF in the storage DB
    await this.storage.updateTransactionBEEF(output.txid, tx.toBEEF())

    // Recursively update the consumedBy outputs
    for (const consumingOutput of output.consumedBy) {
      const consumedOutputs = await this.storage.findOutputsForTransaction(consumingOutput.txid, true)
      for (const consumedOutput of consumedOutputs) {
        await this.updateMerkleProof(consumedOutput, txid, proof)
      }
    }
  }

  /**
   * Recursively prune UTXOs when an incoming Merkle Proof is received.
   *
   * @param txid - Transaction ID of the associated outputs to prune.
   * @param proof - Merkle proof containing the Merkle path and other relevant data to verify the transaction.
   * @param blockHeight - The block height associated with the incoming merkle proof.
   */
  async handleNewMerkleProof(txid: string, proof: MerklePath, blockHeight?: number): Promise<void> {
    const outputs = await this.storage.findOutputsForTransaction(txid, true)

    if (outputs === undefined || outputs.length === 0) {
      throw new Error('Could not find matching transaction outputs for proof ingest!')
    }

    const proofMetadata = extractMerkleProofMetadata(txid, proof)
    const resolvedBlockHeight = blockHeight ?? proofMetadata?.blockHeight
    const resolvedBlockHash = resolvedBlockHeight === undefined
      ? undefined
      : await this.resolveBlockHash(resolvedBlockHeight, proofMetadata?.merkleRoot)

    for (const output of outputs) {
      await this.updateMerkleProof(output, txid, proof)

      // Add the associated blockHeight
      if (resolvedBlockHeight !== undefined) {
        output.blockHeight = resolvedBlockHeight
        await this.storage.updateOutputBlockHeight?.(output.txid, output.outputIndex, output.topic, resolvedBlockHeight)
      }

      if (output.beef !== undefined) {
        const tx = Transaction.fromBEEF(output.beef)
        this.updateInputProofs(tx, txid, proof)
        await this.recordTransactionData(tx, tx.toBEEF(), resolvedBlockHash)
      }

      if (resolvedBlockHeight !== undefined) {
        await this.storage.updateAppliedTransactionProof?.({
          txid,
          topic: output.topic,
          blockHeight: resolvedBlockHeight,
          blockHash: resolvedBlockHash,
          blockIndex: proofMetadata?.blockIndex,
          merkleRoot: proofMetadata?.merkleRoot
        })
      }

      if (resolvedBlockHeight !== undefined && resolvedBlockHash !== undefined) {
        await this.recomputeTopicBlockAnchor(output.topic, resolvedBlockHeight, resolvedBlockHash)
      }
    }
  }

  /**
   * Find a list of supported topic managers
   * @public
   * @returns {Promise<Record<string, { name: string; shortDescription: string; iconURL?: string; version?: string; informationURL?: string; }>>} - Supported topic managers and their metadata
   */
  async listTopicManagers(): Promise<Record<string, {
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }>> {
    const result: Record<string, {
      name: string
      shortDescription: string
      iconURL?: string
      version?: string
      informationURL?: string
    }> = {}
    for (const t in this.managers) {
      try {
        result[t] = await this.managers[t].getMetaData()
      } catch (e) {
        this.logger.warn(`Unable to get metadata for topic manager: ${t}: ${e}`)
        result[t] = {
          name: t,
          shortDescription: 'No topical tagline.'
        }
      }
    }
    return result
  }

  /**
   * Find a list of supported lookup services
   * @public
   * @returns {Promise<Record<string, { name: string; shortDescription: string; iconURL?: string; version?: string; informationURL?: string; }>>} - Supported lookup services and their metadata
   */
  async listLookupServiceProviders(): Promise<Record<string, {
    name: string
    shortDescription: string
    iconURL?: string
    version?: string
    informationURL?: string
  }>> {
    const result: Record<string, {
      name: string
      shortDescription: string
      iconURL?: string
      version?: string
      informationURL?: string
    }> = {}
    for (const ls in this.lookupServices) {
      try {
        result[ls] = await this.lookupServices[ls].getMetaData()
      } catch (e) {
        this.logger.warn(`Unable to get metadata for lookup service: ${ls}: ${e}`)
        result[ls] = {
          name: ls,
          shortDescription: 'No lookup service tagline.'
        }
      }
    }
    return result
  }

  /**
   * Run a query to get the documentation for a particular topic manager
   * @public
   * @returns {Promise<string>} - the documentation for the topic manager
   */
  async getDocumentationForTopicManager(manager: any): Promise<string> {
    const documentation = await this.managers[manager]?.getDocumentation?.()
    return documentation ?? 'No documentation found!'
  }

  /**
   * Run a query to get the documentation for a particular lookup service
   * @public
   * @returns {Promise<string>} -  the documentation for the lookup service
   */
  async getDocumentationForLookupServiceProvider(provider: any): Promise<string> {
    const documentation = await this.lookupServices[provider]?.getDocumentation?.()
    return documentation ?? 'No documentation found!'
  }

  /**
   * Validates a URL to ensure it does not match disallowed patterns:
   * - Contains "http:" protocol
   * - Contains "localhost" (with or without a port)
   * - Internal or non-routable IP addresses (e.g., 192.168.x.x, 10.x.x.x, 172.16.x.x to 172.31.x.x)
   * - Non-routable IPs like 127.x.x.x, 0.0.0.0, or IPv6 loopback (::1)
   *
   * @param url - The URL string to validate
   * @returns {boolean} - Returns `false` if the URL violates any of the conditions `true` otherwise
   */
  private isValidUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url)

      // Disallow http:
      if (parsedUrl.protocol === 'http:') {
        return false
      }

      // Disallow localhost with or without a port
      if (/^localhost(:\d+)?$/i.test(parsedUrl.hostname)) {
        return false
      }

      // Disallow internal and non-routable IP addresses
      const ipAddress = parsedUrl.hostname

      // Regex for non-routable IPv4 IPs
      const nonRoutableIpv4Patterns = [
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // Loopback IPs
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // 10.x.x.x private IPs
        /^192\.168\.\d{1,3}\.\d{1,3}$/, // 192.168.x.x private IPs
        /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/, // 172.16.x.x to 172.31.x.x private IPs
        /^0\.0\.0\.0$/ // Non-routable address
      ]

      // Check for IPv4 matches
      if (nonRoutableIpv4Patterns.some((pattern) => pattern.test(ipAddress))) {
        return false
      }

      // Check for non-routable IPv6 addresses explicitly
      if (ipAddress === '[::1]') {
        return false
      }

      // If none of the disallowed conditions matched, the URL is valid
      return true
    } catch (_e) {
      // URL constructor throws on malformed input — not a valid URL, return false
      return false
    }
  }
}
