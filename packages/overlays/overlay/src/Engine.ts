import { TopicManager } from './TopicManager.js'
import { LookupService } from './LookupService.js'
import type { LookupFormula } from './LookupFormula.js'
import { Storage } from './storage/Storage.js'
import type { Output } from './Output.js'
import {
  Transaction,
  ChainTracker,
  MerklePath,
  Broadcaster,
  isBroadcastFailure,
  TaggedBEEF,
  STEAK,
  LookupQuestion,
  LookupAnswer,
  isPublicNetworkAddress,
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
import type { Advertisement } from './Advertisement.js'
import { GASP, GASPInitialRequest, GASPInitialResponse, GASPNode } from '@bsv/gasp'
import { SyncConfiguration } from './SyncConfiguration.js'
import { OverlayGASPRemote } from './GASP/OverlayGASPRemote.js'
import { OverlayGASPStorage } from './GASP/OverlayGASPStorage.js'
import {
  BASM_ZERO_HASH,
  type AdmittedTxRef,
  type AdmittedListResponse,
  type BASMPeerSyncReport,
  type CompoundMerklePathResponse,
  type RawTransactionResponse,
  type ReorgReport,
  type TopicAnchorHeader,
  type TopicAnchorHeaderResolver,
  type TopicAnchorRangeResponse,
  type TopicAnchorTip,
  type TopicBlockAnchor,
  computeBasmRoot,
  computeTac,
  extractMerkleProofMetadata
} from './BASM.js'
import { BASMRemote } from './BASMRemote.js'
import { basmHash, basmInteger, requireBASM } from './BASMValidation.js'
import { serializeErrorForLog, serializeLogValue } from './SafeLog.js'
import { decodeAndVerifyDiscoveryAdvertisement } from './DiscoveryAdvertisementValidation.js'
import {
  assertHash,
  assertNonnegativeInteger,
  assertOutpoint,
  assertOutputIndex,
  assertRawTransactionMatches,
  assertRegistryName,
  assertTopic,
  assertTxidList,
  normalizePeerEndpoint,
  validateAdmittanceInstructions,
  MAX_GASP_PAGE_SIZE
} from './RemoteSecurity.js'
import {
  buildOverlayAdmissionPlan,
  getOverlayAdmissionHost,
  overlayAdmissionMode,
  selectNewAdmissionTopics,
  waitForAdmissionReceipt
} from './EngineAdmission.js'

const DEFAULT_GASP_SYNC_LIMIT = 10000
const DEFAULT_BASM_RANGE_LIMIT = 1024
// The public Overlay Express transport defaults to 1,000 anchors per request.
const DEFAULT_BASM_SYNC_PAGE_SIZE = 1000
const MAX_SYNC_ENDPOINTS_PER_TOPIC = 128
const MAX_SUBMISSION_TOPICS = 128
const MAX_SUBMISSION_BEEF_BYTES = 64 * 1024 * 1024
const MAX_OFF_CHAIN_VALUES = 100_000
const MAX_EVICTION_OUTPUTS = 100_000
const MAX_EVICTION_REASON_BYTES = 1024
const MAX_UNPROVEN_CANDIDATES = 10_000
const MAX_UNPROVEN_THRESHOLD_BLOCKS = 10_000_000
const MAX_REORG_ORPHAN_HASHES = 10_000
const MAX_REORG_ROWS = 100_000
const MAX_REORG_DEPTH = 100_000
const MAX_BASM_ADMITTED_PER_BLOCK = 100_000
const MAX_HISTORY_PRUNE_OUTPUTS = 100_000
const MAX_OUTPUT_RELATIONS = 100_000
const MAX_PROOF_UPDATE_OUTPUTS = 100_000
const MAX_LOOKUP_FORMULAS = 100_000
const MAX_LOOKUP_HISTORY_DEPTH = 2048
const MAX_LOOKUP_HYDRATION_NODES = 100_000
const MAX_LOOKUP_STORAGE_ROWS = 100_000
const MAX_LOOKUP_CONTEXT_BYTES = 1024 * 1024
const MAX_LOOKUP_TOTAL_CONTEXT_BYTES = 16 * 1024 * 1024
const MAX_LOOKUP_TOTAL_BEEF_BYTES = 128 * 1024 * 1024
const MAX_STORED_OUTPUT_SCRIPT_BYTES = 64 * 1024 * 1024
const MAX_CURRENT_ADVERTISEMENTS = 10_000
const MAX_REGISTERED_COMPONENTS = 10_000
const MAX_COMPONENT_NAME_BYTES = 256
const MAX_COMPONENT_DESCRIPTION_BYTES = 4096
const MAX_COMPONENT_VERSION_BYTES = 128
const MAX_COMPONENT_URL_BYTES = 2048
const MAX_COMPONENT_DOCUMENTATION_BYTES = 1024 * 1024

type ComponentMetadata = {
  name: string
  shortDescription: string
  iconURL?: string
  version?: string
  informationURL?: string
}

function assertComponentText(
  value: unknown,
  label: string,
  maximumBytes: number,
  allowEmpty = false
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    Array.from(value).some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new TypeError(`${label} is invalid`)
  }
}

function readOwnComponentField(
  value: object,
  key: keyof ComponentMetadata,
  required: boolean
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) {
    if (required) throw new TypeError(`Component metadata ${key} is required`)
    return undefined
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new TypeError(`Component metadata ${key} must be a data property`)
  }
  return descriptor.value
}

function normalizeComponentURL(value: unknown, label: string): string {
  assertComponentText(value, label, MAX_COMPONENT_URL_BYTES)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return parsed.toString()
}

function validateComponentMetadata(value: unknown): ComponentMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Component metadata must be an object')
  }
  const name = readOwnComponentField(value, 'name', true)
  const shortDescription = readOwnComponentField(value, 'shortDescription', true)
  assertComponentText(name, 'Component metadata name', MAX_COMPONENT_NAME_BYTES)
  assertComponentText(
    shortDescription,
    'Component metadata shortDescription',
    MAX_COMPONENT_DESCRIPTION_BYTES,
    true
  )
  const result: ComponentMetadata = { name, shortDescription }
  const iconURL = readOwnComponentField(value, 'iconURL', false)
  if (iconURL !== undefined) result.iconURL = normalizeComponentURL(iconURL, 'Component iconURL')
  const version = readOwnComponentField(value, 'version', false)
  if (version !== undefined) {
    assertComponentText(version, 'Component metadata version', MAX_COMPONENT_VERSION_BYTES)
    result.version = version
  }
  const informationURL = readOwnComponentField(value, 'informationURL', false)
  if (informationURL !== undefined) {
    result.informationURL = normalizeComponentURL(informationURL, 'Component informationURL')
  }
  return result
}

function validateComponentDocumentation(value: unknown): string {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > MAX_COMPONENT_DOCUMENTATION_BYTES
  ) {
    throw new TypeError(
      `Component documentation must be a string of at most ${MAX_COMPONENT_DOCUMENTATION_BYTES} bytes`
    )
  }
  return value
}

function copyRegistry<T>(value: Record<string, T>, label: string): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const names = Object.keys(value)
  if (names.length > MAX_REGISTERED_COMPONENTS) {
    throw new RangeError(`${label} cannot contain more than ${MAX_REGISTERED_COMPONENTS} entries`)
  }
  const result: Record<string, T> = Object.create(null) as Record<string, T>
  for (const name of names) {
    assertRegistryName(name, `${label} name`)
    result[name] = value[name]
  }
  return result
}

function copyBoundedStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_SYNC_ENDPOINTS_PER_TOPIC) {
    throw new TypeError(
      `${label} must be an array of at most ${MAX_SYNC_ENDPOINTS_PER_TOPIC} strings`
    )
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      new TextEncoder().encode(entry).byteLength > 2048 ||
      Array.from(entry).some(character => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint <= 0x1f || codePoint === 0x7f
      })
    ) {
      throw new TypeError(`${label}[${index}] is invalid`)
    }
    return entry
  })
}

function copySyncConfiguration(value: SyncConfiguration | undefined): SyncConfiguration {
  const copied = copyRegistry(value ?? {}, 'Sync configuration')
  const result: SyncConfiguration = Object.create(null) as SyncConfiguration
  for (const name of Object.keys(copied)) {
    const entry = copied[name]
    if (entry === false || entry === 'SHIP') {
      result[name] = entry
      continue
    }
    const endpoints = copyBoundedStringList(entry, `Sync configuration ${name}`)
    if (endpoints === undefined) throw new TypeError(`Sync configuration ${name} is invalid`)
    result[name] = endpoints
  }
  return result
}

function assertUnprovenThreshold(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_UNPROVEN_THRESHOLD_BLOCKS
  ) {
    throw new TypeError(
      `Unproven thresholdBlocks must be an integer between 1 and ${MAX_UNPROVEN_THRESHOLD_BLOCKS}`
    )
  }
}

type UTXOHistoryHydrationContext = {
  outputCache: Map<string, Promise<Output | null>>
  budgetedOutputs: Set<string>
  hydratedNodes: number
  relationCount: number
  totalBeefBytes: number
}

type HydratedUTXOHistoryNode = {
  output: Output
  transaction: Transaction
}

type TopicValidation = {
  topic: string
  isDupe: boolean
  previousCoins: number[]
  previousOutputs: Array<Output | null>
  admissibleOutputs: AdmittanceInstructions
}

type StaleOutput = {
  txid: string
  previousOutputIndex: number
  inputIndex: number
}

type SubmissionMode = 'historical-tx' | 'current-tx' | 'historical-tx-no-spv'

/**
 * Receives each per-topic validation failure that `Engine.submit` records in
 * `failedTopics`. The Engine swallows those errors by design and reports the
 * topic as `{ outputsToAdmit: [], coinsToRetain: [] }`, which is the same STEAK
 * shape as a duplicate or an empty admission. This callback lets a host tell
 * the three apart without parsing log output.
 *
 * The Engine invokes it inside its own try/catch, so a throwing reporter
 * cannot turn a per-topic rejection into a whole-submission failure.
 */
export type TopicFailureReporter = (
  topic: string,
  error: unknown,
  context: { txid: string; mode: SubmissionMode }
) => void

type TopicSubmissionContext = {
  tx: Transaction
  txid: string
  beef: number[]
  offChainValues: number[] | undefined
  mode: SubmissionMode
  dupeTopics: Set<string>
  failedTopics: Set<string>
}

type OutputAdmissionContext = {
  tx: Transaction
  txid: string
  beef: number[]
  topic: string
  outputsConsumed: Array<{ txid: string; outputIndex: number }>
  newUTXOs: Array<{ txid: string; outputIndex: number }>
  offChainValues: number[] | undefined
}

type StorageMutationContext = {
  dupeTopics: Set<string>
  failedTopics: Set<string>
  steak: STEAK
  tx: Transaction
  txid: string
  beef: number[]
  offChainValues: number[] | undefined
}

type OverlayAdmissionSubmitContext = {
  taggedBEEF: TaggedBEEF
  steak: STEAK
  tx: Transaction
  txid: string
  mode: SubmissionMode
  offChainValues: number[] | undefined
  validations: TopicValidation[]
  failedTopics: Set<string>
  anyTopicAccepted: boolean
  onSteakReady?: (steak: STEAK) => void
}

function findSpendingInputIndex(tx: Transaction, output: Output): number {
  return tx.inputs.findIndex(input => {
    const realSource = input.sourceTXID || input.sourceTransaction?.id('hex')
    return realSource === output.txid && input.sourceOutputIndex === output.outputIndex
  })
}

function requireBASMDefined<T>(value: T | undefined, aligned: boolean, message: string): T {
  requireBASM(aligned, message)
  requireBASM(value !== undefined, message)
  return value
}

/**
 * An engine for running BSV Overlay Services (topic managers and lookup services).
 */
export class Engine {
  /**
   * Optional reporter for per-topic validation failures during `submit`.
   * Unset by default; the Engine's behavior is unchanged when it is unset.
   * A field rather than a constructor parameter, so the positional constructor
   * signature stays as it is.
   */
  onTopicFailed?: TopicFailureReporter

  private submissionTail: Promise<void> = Promise.resolve()
  private basmFetchImpl?: typeof fetch

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
   * @param {number} maxLookupResults - Maximum lookup formulas hydrated per request. Use -1 to opt out.
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
    public unprovenEvictionBlocks = 144,
    public maxLookupResults = 1000
  ) {
    if (
      maxLookupResults !== -1 &&
      (!Number.isSafeInteger(maxLookupResults) || maxLookupResults < 1)
    ) {
      throw new TypeError('maxLookupResults must be -1 or a positive safe integer')
    }
    assertUnprovenThreshold(unprovenEvictionBlocks)
    // Registries cross configuration, HTTP dispatch, and JSON response
    // boundaries. Own-property null-prototype copies prevent inherited entries
    // and reserved object names from becoming executable services.
    this.managers = copyRegistry(managers, 'Topic manager registry')
    this.lookupServices = copyRegistry(lookupServices, 'Lookup service registry')
    this.shipTrackers = copyBoundedStringList(this.shipTrackers, 'SHIP trackers')
    this.slapTrackers = copyBoundedStringList(this.slapTrackers, 'SLAP trackers')
    this.syncConfiguration = copySyncConfiguration(this.syncConfiguration)

    // To encourage synchronization of overlay services, the SHIP sync strategy is used by default for all overlay topics, except for 'tm_ship' and 'tm_slap'.
    // For these two topics, any existing trackers are combined with the provided shipTrackers and slapTrackers omitting any duplicates.
    this.syncConfiguration ??= {}

    for (const managerName of Object.keys(this.managers)) {
      if (
        managerName === 'tm_ship' &&
        this.shipTrackers !== undefined &&
        this.syncConfiguration[managerName] !== false
      ) {
        // Combine tm_ship trackers with preexisting entries if any
        const combinedSet = new Set([
          ...(Array.isArray(this.syncConfiguration[managerName])
            ? this.syncConfiguration[managerName]
            : []),
          ...this.shipTrackers
        ])
        this.syncConfiguration[managerName] = Array.from(combinedSet)
      } else if (
        managerName === 'tm_slap' &&
        this.slapTrackers !== undefined &&
        this.syncConfiguration[managerName] !== false
      ) {
        // Combine tm_slap trackers with preexisting entries if any
        const combinedSet = new Set([
          ...(Array.isArray(this.syncConfiguration[managerName])
            ? this.syncConfiguration[managerName]
            : []),
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
      const height = await this.chainTracker.currentHeight()
      assertNonnegativeInteger(height, 'Current chain height')
      return height
    } catch (error) {
      this.logger.warn(
        `Unable to resolve current chain height for overlay metadata: ${error instanceof Error ? error.message : String(error)}`
      )
      return undefined
    }
  }

  private async resolveBlockHash(
    blockHeight: number,
    merkleRoot?: string
  ): Promise<string | undefined> {
    assertNonnegativeInteger(blockHeight, 'BASM block height')
    if (merkleRoot !== undefined) assertHash(merkleRoot, 'BASM merkle root')
    try {
      const header = await this.topicAnchorHeaderResolver?.(blockHeight)
      if (header === undefined) {
        return undefined
      }
      if (typeof header !== 'object' || header === null) {
        throw new TypeError('Header resolver returned an invalid header')
      }
      assertNonnegativeInteger(header.blockHeight, 'BASM header height')
      assertHash(header.blockHash, 'BASM header block hash')
      if (header.merkleRoot !== undefined) assertHash(header.merkleRoot, 'BASM header merkle root')
      if (header.blockHeight !== blockHeight) {
        throw new TypeError('Header resolver returned a different block height')
      }
      if (
        header.merkleRoot !== undefined &&
        merkleRoot !== undefined &&
        header.merkleRoot.toLowerCase() !== merkleRoot.toLowerCase()
      ) {
        throw new Error(
          `Header merkle root ${header.merkleRoot} does not match proof root ${merkleRoot} at height ${blockHeight}`
        )
      }
      return header.blockHash
    } catch (error) {
      this.logger.warn(
        `Unable to resolve BASM block hash: height=${serializeLogValue(blockHeight)} error=${serializeErrorForLog(error)}`
      )
      return undefined
    }
  }

  private compactBEEFForStorage(tx: Transaction, originalBEEF: number[]): number[] {
    return tx.merklePath === undefined ? originalBEEF : tx.toAtomicBEEF()
  }

  private async recordTransactionData(
    tx: Transaction,
    beef: number[],
    blockHash?: string
  ): Promise<void> {
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
      metadata === undefined
        ? undefined
        : this.resolveBlockHash(metadata.blockHeight, metadata.merkleRoot)
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

  private async recomputeTopicBlockAnchor(
    topic: string,
    blockHeight: number,
    blockHash?: string
  ): Promise<TopicBlockAnchor | undefined> {
    assertTopic(topic, 'BASM topic')
    assertNonnegativeInteger(blockHeight, 'BASM block height')
    if (blockHash !== undefined) assertHash(blockHash, 'BASM block hash')
    if (
      typeof this.storage.findAdmittedTransactionsForBlock !== 'function' ||
      typeof this.storage.upsertTopicBlockAnchor !== 'function' ||
      typeof this.storage.findTopicBlockAnchor !== 'function'
    ) {
      return undefined
    }

    const storedAnchor = await this.storage.findTopicBlockAnchor(topic, blockHeight)
    if (storedAnchor !== undefined) {
      this.assertTopicBlockAnchor(storedAnchor, topic, 'Stored BASM anchor', blockHeight)
    }
    const anchorBlockHash = blockHash ?? storedAnchor?.blockHash
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
    if (tip !== undefined) this.assertTopicAnchorTip(tip, topic, 'Stored BASM tip')
    const tipHeight = tip !== undefined && tip.blockHeight >= 0 ? tip.blockHeight : undefined
    const fromHeight = tipHeight === undefined ? blockHeight : Math.min(blockHeight, tipHeight + 1)
    const toHeight = tipHeight === undefined ? blockHeight : Math.max(blockHeight, tipHeight)

    await this.rebuildTopicAnchorChain(
      topic,
      fromHeight,
      toHeight,
      new Map([[blockHeight, anchorBlockHash]])
    )
    const rebuilt = await this.storage.findTopicBlockAnchor(topic, blockHeight)
    if (rebuilt !== undefined) {
      this.assertTopicBlockAnchor(rebuilt, topic, 'Rebuilt BASM anchor', blockHeight)
    }
    return rebuilt
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
    if (toHeight !== undefined) assertNonnegativeInteger(toHeight, 'BASM target height')
    if (
      typeof this.storage.findTopicAnchorTip !== 'function' ||
      typeof this.storage.upsertTopicBlockAnchor !== 'function'
    ) {
      return
    }
    const targetHeight = toHeight ?? (await this.currentHeightOrUndefined())
    if (targetHeight === undefined) {
      return
    }
    assertNonnegativeInteger(targetHeight, 'BASM target height')
    for (const topic of Object.keys(this.managers)) {
      const tip = await this.storage.findTopicAnchorTip(topic)
      if (tip !== undefined) this.assertTopicAnchorTip(tip, topic, 'Stored BASM tip')
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
    assertTopic(topic, 'BASM topic')
    assertNonnegativeInteger(fromHeight, 'BASM range start')
    assertNonnegativeInteger(toHeight, 'BASM range end')
    if (!(blockHashHints instanceof Map)) throw new TypeError('BASM block hash hints must be a Map')
    if (typeof forceResolve !== 'boolean')
      throw new TypeError('BASM forceResolve must be a boolean')
    for (const [height, hash] of blockHashHints) {
      assertNonnegativeInteger(height, 'BASM block hash hint height')
      assertHash(hash, 'BASM block hash hint')
      if (height < fromHeight || height > toHeight) {
        throw new TypeError('BASM block hash hint is outside the rebuild range')
      }
    }
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
      this.logger.warn(
        `[BASM] capping anchor chain extension: topic=${serializeLogValue(topic)} limit=${serializeLogValue(DEFAULT_BASM_RANGE_LIMIT)} requestedFrom=${serializeLogValue(fromHeight)} requestedTo=${serializeLogValue(toHeight)}; will continue on the next pass`
      )
      toHeight = fromHeight + DEFAULT_BASM_RANGE_LIMIT - 1
    }

    const previousAnchor =
      fromHeight > 0 ? await this.storage.findTopicBlockAnchor(topic, fromHeight - 1) : undefined
    if (previousAnchor !== undefined) {
      this.assertTopicBlockAnchor(previousAnchor, topic, 'Previous BASM anchor', fromHeight - 1)
    }
    let prevTac = previousAnchor?.tac ?? BASM_ZERO_HASH

    for (let height = fromHeight; height <= toHeight; height++) {
      const admitted = await this.storage.findAdmittedTransactionsForBlock(
        topic,
        height,
        undefined,
        MAX_BASM_ADMITTED_PER_BLOCK + 1
      )
      const existing = await this.storage.findTopicBlockAnchor(topic, height)
      if (existing !== undefined) {
        this.assertTopicBlockAnchor(existing, topic, 'Stored BASM anchor', height)
      }
      // On a reorg rebuild the existing anchor's block hash is stale, so force
      // canonical re-resolution from the header resolver instead of reusing it.
      const blockHash =
        blockHashHints.get(height) ??
        (forceResolve ? undefined : existing?.blockHash) ??
        (await this.resolveBlockHash(height))
      if (blockHash === undefined) {
        this.logger.warn(
          `[BASM] unable to resolve block hash: topic=${serializeLogValue(topic)} height=${serializeLogValue(height)}; halting chain extension`
        )
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
    return await this.reconcileReorg(input, new Set())
  }

  private async reconcileReorg(
    input: {
      orphanedBlockHashes: string[]
      rebuildFromHeight: number
      newTipHeight: number
    },
    independentlyInvalidProofRows: ReadonlySet<string>
  ): Promise<ReorgReport> {
    if (
      typeof input !== 'object' ||
      input === null ||
      !Array.isArray(input.orphanedBlockHashes) ||
      input.orphanedBlockHashes.length > MAX_REORG_ORPHAN_HASHES
    ) {
      throw new TypeError('Invalid or oversized reorg input')
    }
    assertNonnegativeInteger(input.rebuildFromHeight, 'Reorg rebuild start')
    assertNonnegativeInteger(input.newTipHeight, 'Reorg new tip height')
    if (
      input.rebuildFromHeight > input.newTipHeight ||
      input.newTipHeight - input.rebuildFromHeight + 1 > MAX_REORG_DEPTH
    ) {
      throw new TypeError(`Reorg rebuild ranges are capped at ${MAX_REORG_DEPTH} heights`)
    }
    const orphanedHashes = new Set<string>()
    for (const hash of input.orphanedBlockHashes) {
      assertHash(hash, 'Reorg orphaned block hash')
      const canonical = hash.toLowerCase()
      if (orphanedHashes.has(canonical)) throw new TypeError('Reorg block hashes must be unique')
      orphanedHashes.add(canonical)
    }
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
    const rowsToDemote: Array<{
      txid: string
      topic: string
      blockHeight: number
      reportedBlockHash: string
    }> = []
    const seenRows = new Set<string>()
    for (const blockHash of orphanedHashes) {
      const remaining = MAX_REORG_ROWS - rowsToDemote.length
      const rows = await this.storage.findProvenAppliedTransactionsByBlockHash(
        blockHash,
        remaining + 1
      )
      if (!Array.isArray(rows) || rows.length > remaining) {
        throw new TypeError('Storage returned an invalid or oversized reorg transaction set')
      }
      for (const [index, row] of rows.entries()) {
        if (typeof row !== 'object' || row === null) {
          throw new TypeError(`Storage returned an invalid reorg transaction at index ${index}`)
        }
        assertHash(row.txid, `Reorg transaction[${index}] txid`)
        assertTopic(row.topic, `Reorg transaction[${index}] topic`)
        assertNonnegativeInteger(row.blockHeight, `Reorg transaction[${index}] height`)
        if (row.blockHeight < input.rebuildFromHeight || row.blockHeight > input.newTipHeight) {
          throw new TypeError('Storage returned a reorg transaction outside the rebuild range')
        }
        const key = `${row.txid.toLowerCase()}.${row.topic}`
        if (seenRows.has(key)) throw new TypeError('Storage returned duplicate reorg transactions')
        seenRows.add(key)
        rowsToDemote.push({ ...row, reportedBlockHash: blockHash })
      }
    }

    // The event stream is an acceleration hint, not independent chain-state
    // authority. Before any durable mutation, corroborate every claimed
    // orphaned block against the configured canonical header resolver. A
    // missing answer fails closed; a hash that is still canonical proves the
    // stream claim is stale or hostile.
    const canonicalByHeight = new Map<number, string | null>()
    const authorizedRowsToDemote: typeof rowsToDemote = []
    for (const row of rowsToDemote) {
      let canonical = canonicalByHeight.get(row.blockHeight)
      if (canonical === undefined) {
        canonical = (await this.resolveBlockHash(row.blockHeight))?.toLowerCase() ?? null
        canonicalByHeight.set(row.blockHeight, canonical)
      }
      const rowKey = `${row.txid.toLowerCase()}\0${row.topic}`
      const independentlyInvalid = independentlyInvalidProofRows.has(rowKey)
      if (canonical === null && !independentlyInvalid) {
        throw new Error('Unable to corroborate a reported reorg before mutating state')
      }
      if (canonical === row.reportedBlockHash.toLowerCase() && !independentlyInvalid) {
        if (independentlyInvalidProofRows.size > 0) continue
        throw new Error('Reported orphaned block is still canonical')
      }
      authorizedRowsToDemote.push(row)
    }
    const demotedByTopic = new Map<string, string[]>()
    for (const row of authorizedRowsToDemote) {
      await this.storage.demoteAppliedTransactionToUnproven(row.txid, row.topic)
      const list = demotedByTopic.get(row.topic) ?? []
      list.push(row.txid)
      demotedByTopic.set(row.topic, list)
    }

    // 2) Rebuild every topic anchor chain that intersects the reorged range,
    //    forcing canonical block-hash re-resolution so stale hashes are replaced.
    for (const topic of Object.keys(this.managers)) {
      const existing = await this.storage.findTopicBlockAnchors(
        topic,
        input.rebuildFromHeight,
        input.newTipHeight,
        MAX_REORG_DEPTH + 1
      )
      if (!Array.isArray(existing) || existing.length > MAX_REORG_DEPTH) {
        throw new TypeError('Storage returned an invalid or oversized reorg anchor set')
      }
      if (existing.length === 0) {
        continue
      }
      let startHeight = input.newTipHeight
      const seenHeights = new Set<number>()
      for (const [index, anchor] of existing.entries()) {
        if (typeof anchor !== 'object' || anchor === null) {
          throw new TypeError(`Storage returned an invalid reorg anchor at index ${index}`)
        }
        assertTopic(anchor.topic, `Reorg anchor[${index}] topic`)
        assertNonnegativeInteger(anchor.blockHeight, `Reorg anchor[${index}] height`)
        if (
          anchor.topic !== topic ||
          anchor.blockHeight < input.rebuildFromHeight ||
          anchor.blockHeight > input.newTipHeight ||
          seenHeights.has(anchor.blockHeight)
        ) {
          throw new TypeError('Storage returned an unbound or duplicate reorg anchor')
        }
        assertHash(anchor.blockHash, `Reorg anchor[${index}] block hash`)
        assertHash(anchor.basmRoot, `Reorg anchor[${index}] BASM root`)
        assertHash(anchor.tac, `Reorg anchor[${index}] TAC`)
        assertNonnegativeInteger(anchor.admittedCount, `Reorg anchor[${index}] admitted count`)
        seenHeights.add(anchor.blockHeight)
        startHeight = Math.min(startHeight, anchor.blockHeight)
      }
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
    row: { txid: string; blockHeight: number; blockHash?: string; merkleRoot?: string },
    chainTracker: ChainTracker
  ): Promise<'invalid-proof' | 'stale-block' | false | undefined> {
    let rootInvalid = false
    if (row.merkleRoot !== undefined) {
      try {
        if ((await chainTracker.isValidRootForHeight(row.merkleRoot, row.blockHeight)) !== true) {
          rootInvalid = true
        }
      } catch (error) {
        this.logger.warn(
          `[BASM] root validation failed for ${row.txid} at height ${row.blockHeight}: ${error instanceof Error ? error.message : String(error)}`
        )
        return undefined
      }
    }

    const canonical = await this.resolveBlockHash(row.blockHeight)
    if (canonical !== undefined && canonical.toLowerCase() !== row.blockHash?.toLowerCase()) {
      return 'stale-block'
    }
    return rootInvalid ? 'invalid-proof' : false
  }

  async revalidateRecentAnchors(depth = 3): Promise<ReorgReport | undefined> {
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > MAX_REORG_DEPTH) {
      throw new TypeError(`Reorg revalidation depth must be between 1 and ${MAX_REORG_DEPTH}`)
    }
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
    assertNonnegativeInteger(tip, 'Current chain height')

    const fromHeight = Math.max(0, tip - depth + 1)
    const rows = await this.storage.findProvenAppliedTransactionsInRange(
      fromHeight,
      tip,
      undefined,
      MAX_REORG_ROWS + 1
    )
    if (!Array.isArray(rows) || rows.length > MAX_REORG_ROWS) {
      throw new TypeError('Storage returned an invalid or oversized revalidation set')
    }
    const orphaned = new Set<string>()
    const independentlyInvalidProofRows = new Set<string>()
    let minAffected = Number.POSITIVE_INFINITY

    const seenRows = new Set<string>()
    for (const [index, row] of rows.entries()) {
      if (typeof row !== 'object' || row === null) {
        throw new TypeError(`Storage returned an invalid revalidation row at index ${index}`)
      }
      assertHash(row.txid, `Revalidation row[${index}] txid`)
      assertTopic(row.topic, `Revalidation row[${index}] topic`)
      assertNonnegativeInteger(row.blockHeight, `Revalidation row[${index}] height`)
      if (row.blockHeight < fromHeight || row.blockHeight > tip) {
        throw new TypeError('Storage returned a revalidation row outside the requested range')
      }
      if (row.blockHash !== undefined)
        assertHash(row.blockHash, `Revalidation row[${index}] block hash`)
      if (row.merkleRoot !== undefined)
        assertHash(row.merkleRoot, `Revalidation row[${index}] Merkle root`)
      const key = `${row.txid.toLowerCase()}.${row.topic}`
      if (seenRows.has(key)) throw new TypeError('Storage returned duplicate revalidation rows')
      seenRows.add(key)
      if (row.blockHash === undefined) {
        continue
      }
      const stale = await this.isProvenAnchorStale(row, chainTracker)
      if (stale !== false && stale !== undefined) {
        const blockHash = row.blockHash.toLowerCase()
        orphaned.add(blockHash)
        if (stale === 'invalid-proof') {
          independentlyInvalidProofRows.add(`${row.txid.toLowerCase()}\0${row.topic}`)
        }
        if (orphaned.size > MAX_REORG_ORPHAN_HASHES) {
          throw new TypeError('Revalidation produced too many orphaned block hashes')
        }
        minAffected = Math.min(minAffected, row.blockHeight)
      }
    }

    if (orphaned.size === 0) {
      return { perTopic: [] }
    }

    return await this.reconcileReorg(
      {
        orphanedBlockHashes: Array.from(orphaned),
        rebuildFromHeight: minAffected,
        newTipHeight: tip
      },
      independentlyInvalidProofRows
    )
  }

  private async validateTopicSubmission(
    topic: string,
    context: TopicSubmissionContext
  ): Promise<TopicValidation> {
    const { tx, txid, beef, offChainValues, mode, dupeTopics, failedTopics } = context
    try {
      if (this.managers[topic] === undefined || this.managers[topic] === null) {
        throw new Error(`This server does not support this topic: ${topic}`)
      }

      this.startTime(`dupCheck_${txid.substring(0, 10)}`)
      const isDupe = await this.storage.doesAppliedTransactionExist({ txid, topic })
      this.endTime(`dupCheck_${txid.substring(0, 10)}`)
      if (typeof isDupe !== 'boolean') {
        throw new TypeError('Storage returned an invalid applied-transaction verdict')
      }
      if (isDupe) {
        dupeTopics.add(topic)
        return {
          topic,
          isDupe: true,
          previousCoins: [],
          previousOutputs: [],
          admissibleOutputs: { outputsToAdmit: [], coinsToRetain: [] }
        }
      }

      const previousCoins: number[] = []
      const outputPromises = tx.inputs.map(async (input, inputIndex) => {
        const previousTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
        if (previousTXID === undefined) return null
        const output = await this.storage.findOutput(
          previousTXID,
          input.sourceOutputIndex,
          topic,
          false
        )
        if (output !== undefined && output !== null) {
          this.assertStoredOutputMatches(
            output,
            { txid: previousTXID, outputIndex: input.sourceOutputIndex, topic },
            'Previous topical output'
          )
          if (output.spent !== false) {
            throw new TypeError('Storage returned a spent output for an unspent topical query')
          }
          previousCoins.push(inputIndex)
        }
        return output ?? null
      })

      this.startTime(`previousOutputQuery_${txid.substring(0, 10)}`)
      const previousOutputs = await Promise.all(outputPromises)
      previousCoins.sort((left, right) => left - right)
      this.endTime(`previousOutputQuery_${txid.substring(0, 10)}`)

      this.startTime(`identifyAdmissibleOutputs_${txid.substring(0, 10)}`)
      const admissibleOutputs = validateAdmittanceInstructions(
        await this.managers[topic].identifyAdmissibleOutputs(
          beef,
          previousCoins,
          offChainValues,
          mode
        ),
        tx,
        previousCoins
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
      this.logger.error(
        `Error validating topic during submit: topic=${serializeLogValue(topic)} error=${serializeErrorForLog(error)}`
      )
      failedTopics.add(topic)
      this.reportTopicFailure(topic, error, { txid, mode })
      return {
        topic,
        isDupe: false,
        previousCoins: [],
        previousOutputs: [],
        admissibleOutputs: { outputsToAdmit: [], coinsToRetain: [] }
      }
    }
  }

  private reportTopicFailure(
    topic: string,
    error: unknown,
    context: { txid: string; mode: SubmissionMode }
  ): void {
    if (this.onTopicFailed === undefined) return
    try {
      this.onTopicFailed(topic, error, context)
    } catch (reporterError) {
      // An observability hook must never change admission behavior.
      this.logger.error(
        `Error in onTopicFailed reporter: topic=${serializeLogValue(topic)} error=${serializeErrorForLog(reporterError)}`
      )
    }
  }

  private isTopicSubmissionAccepted(
    validation: TopicValidation,
    failedTopics: Set<string>
  ): boolean {
    return (
      !failedTopics.has(validation.topic) &&
      (validation.isDupe ||
        validation.admissibleOutputs.outputsToAdmit.length > 0 ||
        validation.admissibleOutputs.coinsToRetain.length > 0 ||
        validation.previousCoins.length > 0)
    )
  }

  private async broadcastAcceptedSubmission(
    tx: Transaction,
    txid: string,
    mode: 'historical-tx' | 'current-tx' | 'historical-tx-no-spv',
    anyTopicAccepted: boolean
  ): Promise<void> {
    this.startTime(`broadcast_${txid.substring(0, 10)}`)
    if (mode !== 'historical-tx' && this.broadcaster !== undefined && anyTopicAccepted) {
      try {
        let response: BroadcastResponse | BroadcastFailure
        if (tx.merklePath !== undefined) {
          const mp = tx.merklePath
          const leaf = mp.path[0].find(leaf => leaf.hash === txid)
          response = {
            status: 'success',
            txid,
            message: `In block at height ${mp.blockHeight} index ${leaf?.offset}`
          }
        } else {
          response = await this.broadcaster.broadcast(tx)
        }
        if (isBroadcastFailure(response) && this.throwOnBroadcastFailure) {
          const error = new Error(`Failed to broadcast transaction! Error: ${response.description}`)
          ;(error as any).more = response.more
          throw error
        }
      } catch (error) {
        if (this.throwOnBroadcastFailure) throw error
        this.logger.error('Error broadcasting transaction:', error)
      }
    }
    this.endTime(`broadcast_${txid.substring(0, 10)}`)
  }

  private async abortProvisionalAdmissions(
    validations: TopicValidation[],
    failedTopics: Set<string>,
    beef: number[]
  ): Promise<void> {
    await Promise.all(
      validations.map(async validation => {
        if (validation.isDupe || failedTopics.has(validation.topic)) return
        const outputs = validation.admissibleOutputs.outputsToAdmit
        const abort = this.managers[validation.topic].abortAdmissibleOutputs
        if (outputs.length === 0 || abort === undefined) return
        try {
          await abort.call(this.managers[validation.topic], beef, outputs)
        } catch (error) {
          this.logger.error(
            `Error aborting provisional topic admission: topic=${serializeLogValue(validation.topic)} error=${serializeErrorForLog(error)}`
          )
        }
      })
    )
  }

  private async notifyOutputSpent(
    lookupService: LookupService,
    tx: Transaction,
    txid: string,
    output: Output,
    topic: string,
    offChainValues?: number[]
  ): Promise<void> {
    if (typeof lookupService.outputSpent !== 'function') return
    if (lookupService.spendNotificationMode === 'txid') {
      await lookupService.outputSpent({
        mode: 'txid',
        spendingTxid: txid,
        txid: output.txid,
        outputIndex: output.outputIndex,
        topic
      })
      return
    }
    if (lookupService.spendNotificationMode === 'script') {
      const inputIndex = findSpendingInputIndex(tx, output)
      if (inputIndex === -1) throw new Error('Could not find input index')
      await lookupService.outputSpent({
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
      return
    }
    if (lookupService.spendNotificationMode === 'whole-tx') {
      await lookupService.outputSpent({
        mode: 'whole-tx',
        spendingAtomicBEEF: tx.toAtomicBEEF(),
        txid: output.txid,
        outputIndex: output.outputIndex,
        topic,
        offChainValues
      })
      return
    }
    await lookupService.outputSpent({
      mode: 'none',
      txid: output.txid,
      outputIndex: output.outputIndex,
      topic
    })
  }

  private async markPreviousOutputSpent(
    output: Output | null,
    topic: string,
    tx: Transaction,
    txid: string,
    offChainValues?: number[]
  ): Promise<void> {
    if (output === null) return
    await this.storage.markUTXOAsSpent(output.txid, output.outputIndex, topic, txid)
    await Promise.all(
      Object.values(this.lookupServices).map(async lookupService => {
        try {
          await this.notifyOutputSpent(lookupService, tx, txid, output, topic, offChainValues)
        } catch (error) {
          this.logger.error('Error in lookup service for outputSpent:', error)
        }
      })
    )
  }

  private async markPreviousOutputsSpent(
    validations: TopicValidation[],
    failedTopics: Set<string>,
    tx: Transaction,
    txid: string,
    offChainValues?: number[]
  ): Promise<void> {
    for (const validation of validations) {
      if (validation.isDupe || failedTopics.has(validation.topic)) continue
      for (const output of validation.previousOutputs) {
        await this.markPreviousOutputSpent(output, validation.topic, tx, txid, offChainValues)
      }
    }
  }

  private classifyPreviousCoins(
    tx: Transaction,
    validation: TopicValidation
  ): {
    outputsConsumed: Array<{ txid: string; outputIndex: number }>
    outputsToMarkStale: StaleOutput[]
  } {
    const outputsConsumed: Array<{ txid: string; outputIndex: number }> = []
    const outputsToMarkStale: StaleOutput[] = []
    for (const inputIndex of validation.previousCoins) {
      const input = tx.inputs[inputIndex]
      const previousTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      if (typeof previousTXID !== 'string') continue
      if (validation.admissibleOutputs.coinsToRetain.includes(inputIndex)) {
        outputsConsumed.push({
          txid: previousTXID,
          outputIndex: input.sourceOutputIndex
        })
      } else {
        outputsToMarkStale.push({
          txid: previousTXID,
          previousOutputIndex: input.sourceOutputIndex,
          inputIndex
        })
      }
    }
    return { outputsConsumed, outputsToMarkStale }
  }

  private async removeStaleOutputs(
    outputs: StaleOutput[],
    topic: string,
    txid: string
  ): Promise<void> {
    this.startTime(`lookForStaleOutputs_${txid.substring(0, 10)}`)
    await Promise.all(
      outputs.map(async coin => {
        const output = await this.storage.findOutput(coin.txid, coin.previousOutputIndex, topic)
        if (output !== undefined && output !== null) {
          this.assertStoredOutputMatches(
            output,
            { txid: coin.txid, outputIndex: coin.previousOutputIndex, topic },
            'Stale topical output'
          )
          await this.deleteUTXODeep(output)
        }
      })
    )
    this.endTime(`lookForStaleOutputs_${txid.substring(0, 10)}`)
  }

  private async notifyOutputAdmitted(
    lookupService: LookupService,
    tx: Transaction,
    txid: string,
    outputIndex: number,
    topic: string,
    offChainValues?: number[]
  ): Promise<void> {
    if (lookupService.admissionMode === 'locking-script') {
      if (
        typeof tx.outputs[outputIndex].lockingScript !== 'object' ||
        typeof tx.outputs[outputIndex].satoshis !== 'number'
      )
        return
      await lookupService.outputAdmittedByTopic({
        mode: 'locking-script',
        txid,
        outputIndex,
        lockingScript: tx.outputs[outputIndex].lockingScript,
        satoshis: tx.outputs[outputIndex].satoshis,
        topic,
        offChainValues
      })
      return
    }
    await lookupService.outputAdmittedByTopic({
      mode: 'whole-tx',
      atomicBEEF: tx.toAtomicBEEF(),
      outputIndex,
      topic,
      offChainValues
    })
  }

  private async admitOutput(outputIndex: number, context: OutputAdmissionContext): Promise<void> {
    const { tx, txid, beef, topic, outputsConsumed, newUTXOs, offChainValues } = context
    if (typeof tx.outputs[outputIndex].satoshis !== 'number') return
    this.startTime(`insertNewOutput_${txid.substring(0, 10)}`)
    await this.storage.insertOutput({
      txid,
      outputIndex,
      outputScript: tx.outputs[outputIndex].lockingScript.toBinary(),
      satoshis: tx.outputs[outputIndex].satoshis,
      topic,
      spent: false,
      beef: this.compactBEEFForStorage(tx, beef),
      consumedBy: [],
      outputsConsumed,
      score: Date.now(),
      blockHeight: extractMerkleProofMetadata(txid, tx.merklePath)?.blockHeight
    })
    this.endTime(`insertNewOutput_${txid.substring(0, 10)}`)
    newUTXOs.push({ txid, outputIndex })

    this.startTime(`notifyLookupService${txid.substring(0, 10)}`)
    await Promise.all(
      Object.values(this.lookupServices).map(async lookupService => {
        try {
          await this.notifyOutputAdmitted(
            lookupService,
            tx,
            txid,
            outputIndex,
            topic,
            offChainValues
          )
        } catch (error) {
          this.logger.error('Error in lookup service for outputAdmittedByTopic:', error)
        }
      })
    )
    this.endTime(`notifyLookupService${txid.substring(0, 10)}`)
  }

  private async updateConsumedOutput(
    output: { txid: string; outputIndex: number },
    newUTXOs: Array<{ txid: string; outputIndex: number }>,
    topic: string
  ): Promise<void> {
    const storedOutput = await this.storage.findOutput(output.txid, output.outputIndex, topic)
    if (storedOutput === undefined || storedOutput === null) return
    this.assertStoredOutputMatches(storedOutput, { ...output, topic }, 'Consumed topical output')
    const consumedByMap = new Map<string, { txid: string; outputIndex: number }>()
    for (const [index, relation] of [...storedOutput.consumedBy, ...newUTXOs].entries()) {
      assertHash(relation.txid, `Consumed topical output relation[${index}] txid`)
      assertOutputIndex(
        relation.outputIndex,
        `Consumed topical output relation[${index}] output index`
      )
      consumedByMap.set(this.toOutputCacheKey(relation.txid, relation.outputIndex), relation)
    }
    if (consumedByMap.size > MAX_OUTPUT_RELATIONS) {
      throw new RangeError('Consumed topical output relations exceeded their work budget')
    }
    const consumedBy = Array.from(consumedByMap.values())
    await this.storage.updateConsumedBy(output.txid, output.outputIndex, topic, consumedBy)
  }

  private async applyTopicStorageMutation(
    validation: TopicValidation,
    steak: STEAK,
    tx: Transaction,
    txid: string,
    beef: number[],
    offChainValues?: number[]
  ): Promise<void> {
    const topic = validation.topic
    const { outputsConsumed, outputsToMarkStale } = this.classifyPreviousCoins(tx, validation)
    await this.removeStaleOutputs(outputsToMarkStale, topic, txid)
    steak[topic].coinsRemoved = outputsToMarkStale.map(output => output.inputIndex)

    const newUTXOs: Array<{ txid: string; outputIndex: number }> = []
    for (const outputIndex of validation.admissibleOutputs.outputsToAdmit) {
      await this.admitOutput(outputIndex, {
        tx,
        txid,
        beef,
        topic,
        outputsConsumed,
        newUTXOs,
        offChainValues
      })
    }

    this.startTime(`outputConsumed_${txid.substring(0, 10)}`)
    const appliedRecord = await this.buildAppliedTransactionRecord(tx)
    await this.recordTransactionData(tx, beef, appliedRecord.blockHash)
    await Promise.all([
      ...outputsConsumed.map(async output => {
        await this.updateConsumedOutput(output, newUTXOs, topic)
      }),
      this.storage.insertAppliedTransaction({ txid, topic, ...appliedRecord })
    ])
    if (appliedRecord.blockHeight !== undefined && appliedRecord.blockHash !== undefined) {
      await this.recomputeTopicBlockAnchor(
        topic,
        appliedRecord.blockHeight,
        appliedRecord.blockHash
      )
    }
    this.endTime(`outputConsumed_${txid.substring(0, 10)}`)
  }

  private async applyStorageMutations(
    validations: TopicValidation[],
    context: StorageMutationContext
  ): Promise<void> {
    const { dupeTopics, failedTopics, steak, tx, txid, beef, offChainValues } = context
    for (const validation of validations) {
      const topic = validation.topic
      if (dupeTopics.has(topic) || failedTopics.has(topic)) continue
      await this.applyTopicStorageMutation(validation, steak, tx, txid, beef, offChainValues)
    }
  }

  private async propagateSubmission(
    taggedBEEF: TaggedBEEF,
    steak: STEAK,
    dupeTopics: Set<string>,
    tx: Transaction,
    txid: string
  ): Promise<void> {
    this.startTime(`transactionPropagation_${txid.substring(0, 10)}`)
    const relevantTopics = taggedBEEF.topics.filter(
      topic =>
        steak[topic] !== undefined &&
        !dupeTopics.has(topic) &&
        (steak[topic].outputsToAdmit.length !== 0 || steak[topic].coinsRemoved?.length !== 0)
    )
    if (relevantTopics.length === 0) {
      this.endTime(`transactionPropagation_${txid.substring(0, 10)}`)
      return
    }

    let customBroadcasterConfig
    if (Array.isArray(this.slapTrackers)) {
      const resolverConfig: LookupResolverConfig = {
        slapTrackers: this.slapTrackers
      }
      customBroadcasterConfig = {
        resolver: new LookupResolver(resolverConfig)
      }
    }
    try {
      const shipBroadcaster = new SHIPBroadcaster(relevantTopics, customBroadcasterConfig)
      await shipBroadcaster.broadcast(tx)
    } catch (error) {
      this.logger.error('Error during propagation to other nodes:', error)
    }
    this.endTime(`transactionPropagation_${txid.substring(0, 10)}`)
  }

  private assertSupportedTopics(topics: string[]): void {
    for (const topic of topics) {
      if (this.managers[topic] === undefined || this.managers[topic] === null) {
        throw new Error(`This server does not support this topic: ${topic}`)
      }
    }
  }

  private shouldSkipPropagation(mode: SubmissionMode): boolean {
    return (
      this.advertiser === undefined || mode === 'historical-tx' || mode === 'historical-tx-no-spv'
    )
  }

  private notifySteakReady(callback: ((steak: STEAK) => void) | undefined, steak: STEAK): void {
    if (callback === undefined) return
    try {
      callback(steak)
    } catch (error) {
      this.logger.error('Error in onSteakReady callback:', error)
    }
  }

  private async acknowledgeOverlayAdmission(
    context: OverlayAdmissionSubmitContext
  ): Promise<STEAK | undefined> {
    const admissionHost = getOverlayAdmissionHost(this.storage)
    if (admissionHost === undefined) return undefined
    const {
      taggedBEEF,
      steak,
      tx,
      txid,
      mode,
      offChainValues,
      validations,
      failedTopics,
      anyTopicAccepted,
      onSteakReady
    } = context
    if (!anyTopicAccepted) {
      this.notifySteakReady(onSteakReady, steak)
      return steak
    }
    // A topic counts toward `anyTopicAccepted` when it is a dupe (so the
    // caller still gets broadcast/propagation for a retried submission), but
    // a dupe must never be resubmitted for admission: it was already
    // committed under a (possibly different) operation, and re-including it
    // here would make commitAdmission reject the whole plan. When nothing
    // left over is a genuinely new admission, skip the plan/commit entirely
    // and hand back the STEAK already computed from validation — it reports
    // each dupe topic as accepted-with-nothing-new, same as the classic
    // (non-admission) storage path does.
    if (selectNewAdmissionTopics(validations, failedTopics).length === 0) {
      this.notifySteakReady(onSteakReady, steak)
      return steak
    }
    const applied = await this.buildAppliedTransactionRecord(tx)
    const buildPlan = async () =>
      await buildOverlayAdmissionPlan({
        host: admissionHost,
        tx,
        txid,
        beef: taggedBEEF.beef,
        topics: taggedBEEF.topics,
        mode: overlayAdmissionMode(mode),
        offChainValues,
        validations,
        failedTopics,
        lookupServices: this.lookupServices,
        includePropagation: !this.shouldSkipPropagation(mode),
        applied
      })
    const committed = await waitForAdmissionReceipt(
      admissionHost.admission,
      await buildPlan(),
      buildPlan
    )
    const acknowledged = JSON.parse(committed.receipt.steak) as STEAK
    this.notifySteakReady(onSteakReady, acknowledged)
    return acknowledged
  }

  /**
   * Submits a transaction for processing by Overlay Services.
   * @param {TaggedBEEF} taggedBEEF - The transaction to process
   * @param {function(STEAK): void} [onSTEAKReady] - Optional callback function invoked when the STEAK is ready.
   * @param {string} mode — Indicates the submission behavior, whether historical or current. Historical transactions are not broadcast or propagated.
   * @param {number[]} offChainValues — Values necessary to evaluate topical admittance that are not stored on-chain.
   *
   * The optional callback is invoked after any required transaction broadcast and
   * local storage mutations have completed, but before peer-to-peer propagation.
   *
   * @returns {Promise<STEAK>} The submitted transaction execution acknowledgement
   */
  async submit(
    taggedBEEF: TaggedBEEF,
    onSteakReady?: (steak: STEAK) => void,
    mode: SubmissionMode = 'current-tx',
    offChainValues?: number[]
  ): Promise<STEAK> {
    const previous = this.submissionTail
    let release!: () => void
    this.submissionTail = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      return await this.submitUnlocked(taggedBEEF, onSteakReady, mode, offChainValues)
    } finally {
      release()
    }
  }

  private async submitUnlocked(
    taggedBEEF: TaggedBEEF,
    onSteakReady?: (steak: STEAK) => void,
    mode: SubmissionMode = 'current-tx',
    offChainValues?: number[]
  ): Promise<STEAK> {
    if (
      typeof taggedBEEF !== 'object' ||
      taggedBEEF === null ||
      !Array.isArray(taggedBEEF.beef) ||
      !Array.isArray(taggedBEEF.topics)
    ) {
      throw new TypeError('Tagged BEEF must contain byte and topic arrays')
    }
    if (
      taggedBEEF.beef.length === 0 ||
      taggedBEEF.beef.length > MAX_SUBMISSION_BEEF_BYTES ||
      taggedBEEF.beef.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) {
      throw new TypeError(
        `Tagged BEEF must contain between 1 and ${MAX_SUBMISSION_BEEF_BYTES} bytes`
      )
    }
    if (taggedBEEF.topics.length === 0 || taggedBEEF.topics.length > MAX_SUBMISSION_TOPICS) {
      throw new TypeError(`Tagged BEEF must contain between 1 and ${MAX_SUBMISSION_TOPICS} topics`)
    }
    if (!['historical-tx', 'current-tx', 'historical-tx-no-spv'].includes(mode)) {
      throw new TypeError('Invalid overlay submission mode')
    }
    if (onSteakReady !== undefined && typeof onSteakReady !== 'function') {
      throw new TypeError('onSteakReady must be a function')
    }
    if (
      offChainValues !== undefined &&
      (!Array.isArray(offChainValues) ||
        offChainValues.length > MAX_OFF_CHAIN_VALUES ||
        offChainValues.some(value => !Number.isSafeInteger(value)))
    ) {
      throw new TypeError('offChainValues must be a bounded array of safe integers')
    }
    const uniqueTopics = new Set<string>()
    for (const topic of taggedBEEF.topics) {
      assertTopic(topic, 'Tagged BEEF topic')
      if (uniqueTopics.has(topic)) throw new TypeError('Tagged BEEF contains duplicate topics')
      uniqueTopics.add(topic)
    }
    this.assertSupportedTopics(taggedBEEF.topics)

    // Validate the transaction SPV information
    const tx = Transaction.fromBEEF(taggedBEEF.beef)
    const txid = tx.id('hex')

    this.startTime(`submit_${txid}`)
    // Every submission is SPV-verified except 'historical-tx-no-spv', which is
    // reserved for callers that have already proven inclusion independently
    // (GASP graph finalization and BASM reconciliation). 'historical-tx' is a
    // public submission mode, so it keeps the full SPV check.
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
    const topicValidations = taggedBEEF.topics.map(
      async topic =>
        await this.validateTopicSubmission(topic, {
          tx,
          txid,
          beef: taggedBEEF.beef,
          offChainValues,
          mode,
          dupeTopics,
          failedTopics
        })
    )

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
    const anyTopicAccepted = validations.some(validation =>
      this.isTopicSubmissionAccepted(validation, failedTopics)
    )
    try {
      await this.broadcastAcceptedSubmission(tx, txid, mode, anyTopicAccepted)
    } catch (error) {
      await this.abortProvisionalAdmissions(validations, failedTopics, taggedBEEF.beef)
      throw error
    }

    const admissionSteak = await this.acknowledgeOverlayAdmission({
      taggedBEEF,
      steak,
      tx,
      txid,
      mode,
      offChainValues,
      validations,
      failedTopics,
      anyTopicAccepted,
      onSteakReady
    })
    if (admissionSteak !== undefined) return admissionSteak

    // ===================================================================
    // PHASE 3: MUTATE STORAGE (only after broadcast succeeded)
    // ===================================================================
    // Mark previous outputs as spent and notify lookup services
    try {
      await this.markPreviousOutputsSpent(validations, failedTopics, tx, txid, offChainValues)

      await this.applyStorageMutations(validations, {
        dupeTopics,
        failedTopics,
        steak,
        tx,
        txid,
        beef: taggedBEEF.beef,
        offChainValues
      })
    } catch (error) {
      await this.abortProvisionalAdmissions(validations, failedTopics, taggedBEEF.beef)
      throw error
    }

    // A STEAK is only ready after the corresponding local state is durable.
    // This prevents a callback from reporting success for a storage mutation
    // that later fails.
    this.notifySteakReady(onSteakReady, steak)

    // If we don't have an advertiser or we are dealing with historical transactions, just return the steak
    if (this.shouldSkipPropagation(mode)) {
      return steak
    }

    await this.propagateSubmission(taggedBEEF, steak, dupeTopics, tx, txid)

    return steak
  }

  /**
   * Submit a lookup question to the Overlay Services Engine, and receive back a Lookup Answer
   * @param LookupQuestion — The question to ask the Overlay Services Engine
   * @returns The answer to the question
   */
  async lookup(lookupQuestion: LookupQuestion): Promise<LookupAnswer> {
    if (typeof lookupQuestion !== 'object' || lookupQuestion === null) {
      throw new TypeError('Lookup question must be an object')
    }
    assertRegistryName(lookupQuestion.service, 'Lookup service name')
    // Validate a lookup service for the provider is found
    const lookupService = Object.prototype.hasOwnProperty.call(
      this.lookupServices,
      lookupQuestion.service
    )
      ? this.lookupServices[lookupQuestion.service]
      : undefined
    if (lookupService === undefined || lookupService === null)
      throw new Error(`Lookup service not found for provider: ${lookupQuestion.service}`)

    const lookupResult = await lookupService.lookup(lookupQuestion)
    this.assertLookupFormula(lookupResult)
    const configuredLimit =
      this.maxLookupResults === -1
        ? MAX_LOOKUP_FORMULAS
        : Math.min(this.maxLookupResults, MAX_LOOKUP_FORMULAS)
    if (lookupResult.length > configuredLimit) {
      throw new RangeError(
        `Lookup returned ${lookupResult.length} results; maximum is ${configuredLimit}`
      )
    }
    const hydrationContext = this.createUTXOHistoryHydrationContext()
    await this.preloadOutputsWithBEEF(
      lookupResult.map(({ txid, outputIndex }) => ({ txid, outputIndex })),
      hydrationContext
    )
    const hydratedOutputs = (
      await Promise.all(
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
      )
    )
      .filter(
        (
          output
        ): output is { beef: number[]; outputIndex: number; context: number[] | undefined } =>
          output !== null
      )
      .map(({ beef, outputIndex, context }) =>
        context === undefined ? { beef, outputIndex } : { beef, outputIndex, context }
      )
    return {
      type: 'output-list',
      outputs: hydratedOutputs
    }
  }

  private createUTXOHistoryHydrationContext(): UTXOHistoryHydrationContext {
    return {
      outputCache: new Map<string, Promise<Output | null>>(),
      budgetedOutputs: new Set<string>(),
      hydratedNodes: 0,
      relationCount: 0,
      totalBeefBytes: 0
    }
  }

  private toOutputCacheKey(txid: string, outputIndex: number): string {
    return `${txid.toLowerCase()}:${outputIndex}`
  }

  private assertLookupFormula(value: unknown): asserts value is LookupFormula {
    if (!Array.isArray(value)) throw new TypeError('Lookup service must return an array')
    if (value.length > MAX_LOOKUP_FORMULAS) {
      throw new RangeError(`Lookup returned more than ${MAX_LOOKUP_FORMULAS} results`)
    }
    let totalContextBytes = 0
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== 'object' || entry === null) {
        throw new TypeError(`Lookup result[${index}] is invalid`)
      }
      assertHash(entry.txid, `Lookup result[${index}] txid`)
      assertOutputIndex(entry.outputIndex, `Lookup result[${index}] output index`)
      if (
        entry.history !== undefined &&
        typeof entry.history !== 'function' &&
        (!Number.isSafeInteger(entry.history) ||
          (entry.history as number) < -1 ||
          (entry.history as number) > MAX_LOOKUP_HISTORY_DEPTH)
      ) {
        throw new TypeError(
          `Lookup result[${index}] history must be -1 through ${MAX_LOOKUP_HISTORY_DEPTH}, or a function`
        )
      }
      if (entry.context !== undefined) {
        if (!Array.isArray(entry.context) || entry.context.length > MAX_LOOKUP_CONTEXT_BYTES) {
          throw new TypeError(`Lookup result[${index}] context must be bounded bytes`)
        }
        for (let byteIndex = 0; byteIndex < entry.context.length; byteIndex++) {
          const byte = entry.context[byteIndex]
          if (
            !Object.prototype.hasOwnProperty.call(entry.context, byteIndex) ||
            !Number.isInteger(byte) ||
            byte < 0 ||
            byte > 255
          ) {
            throw new TypeError(`Lookup result[${index}] context must be bounded bytes`)
          }
        }
        totalContextBytes += entry.context.length
        if (totalContextBytes > MAX_LOOKUP_TOTAL_CONTEXT_BYTES) {
          throw new RangeError('Lookup result contexts exceeded their total byte budget')
        }
      }
    }
  }

  private validateLookupOutput(
    value: unknown,
    label: string,
    expected?: { txid: string; outputIndex: number },
    context?: UTXOHistoryHydrationContext
  ): asserts value is Output {
    this.assertStoredOutputRelations(value, label)
    if (
      expected !== undefined &&
      (value.txid.toLowerCase() !== expected.txid.toLowerCase() ||
        value.outputIndex !== expected.outputIndex)
    ) {
      throw new TypeError(`${label} does not match the requested outpoint`)
    }
    if (value.beef === undefined) return
    if (
      !Array.isArray(value.beef) ||
      value.beef.length === 0 ||
      value.beef.length > MAX_SUBMISSION_BEEF_BYTES ||
      value.beef.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) {
      throw new TypeError(`${label} has invalid or oversized transaction BEEF`)
    }
    const transaction = Transaction.fromBEEF(value.beef)
    if (transaction.id('hex').toLowerCase() !== value.txid.toLowerCase()) {
      throw new TypeError(`${label} BEEF does not match its transaction ID`)
    }
    if (value.outputIndex >= transaction.outputs.length) {
      throw new TypeError(`${label} index is outside its transaction`)
    }
    if (context !== undefined) {
      const key = this.toOutputCacheKey(value.txid, value.outputIndex)
      if (!context.budgetedOutputs.has(key)) {
        context.budgetedOutputs.add(key)
        context.totalBeefBytes += value.beef.length
        if (context.totalBeefBytes > MAX_LOOKUP_TOTAL_BEEF_BYTES) {
          throw new RangeError('Lookup transaction BEEF exceeded its total byte budget')
        }
      }
    }
  }

  private async preloadOutputsWithBEEF(
    outpoints: Array<{ txid: string; outputIndex: number }>,
    context: UTXOHistoryHydrationContext
  ): Promise<void> {
    if (outpoints.length === 0) {
      return
    }

    const deduped: Array<{ txid: string; outputIndex: number }> = []
    const seen = new Set<string>()

    for (const outpoint of outpoints) {
      assertHash(outpoint.txid, 'Lookup outpoint txid')
      assertOutputIndex(outpoint.outputIndex, 'Lookup outpoint output index')
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
    if (context.outputCache.size + deduped.length > MAX_LOOKUP_HYDRATION_NODES) {
      throw new RangeError('Lookup output traversal exceeded its work budget')
    }

    const findOutputsByOutpoints = this.storage.findOutputsByOutpoints
    if (typeof findOutputsByOutpoints === 'function') {
      const outputs = await findOutputsByOutpoints.call(this.storage, deduped, true)
      if (!Array.isArray(outputs) || outputs.length > MAX_LOOKUP_STORAGE_ROWS) {
        throw new TypeError('Storage returned invalid or oversized batched lookup outputs')
      }
      const requestedKeys = new Set(
        deduped.map(outpoint => this.toOutputCacheKey(outpoint.txid, outpoint.outputIndex))
      )
      const outputsByKey = new Map<string, Output>()
      for (const [index, output] of outputs.entries()) {
        this.validateLookupOutput(output, `Batched lookup output[${index}]`)
        const key = this.toOutputCacheKey(output.txid, output.outputIndex)
        if (!requestedKeys.has(key)) {
          throw new TypeError('Storage returned an output that was not requested')
        }
        if (!outputsByKey.has(key)) outputsByKey.set(key, output)
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
    if (output !== null && output !== undefined) {
      this.validateLookupOutput(output, 'Lookup output', { txid, outputIndex }, context)
    }
    return output ?? null
  }

  private async hydrateUTXOHistoryNode(
    output: Output,
    historySelector:
      ((beef: number[], outputIndex: number, currentDepth: number) => Promise<boolean>) | number,
    currentDepth: number,
    context: UTXOHistoryHydrationContext,
    ancestors: ReadonlySet<string> = new Set<string>()
  ): Promise<HydratedUTXOHistoryNode | undefined> {
    let shouldTraverseHistory: boolean
    if (typeof historySelector === 'number') {
      shouldTraverseHistory = currentDepth <= historySelector
    } else {
      if (currentDepth > MAX_LOOKUP_HISTORY_DEPTH) {
        throw new RangeError('Lookup history exceeded its maximum depth')
      }
      if (output.beef === undefined) {
        throw new Error('Output must have associated transaction BEEF!')
      }
      shouldTraverseHistory = await historySelector(output.beef, output.outputIndex, currentDepth)
      if (typeof shouldTraverseHistory !== 'boolean') {
        throw new TypeError('Lookup history selector must return a boolean')
      }
    }

    if (shouldTraverseHistory === false) {
      return undefined
    }
    if (currentDepth > MAX_LOOKUP_HISTORY_DEPTH) {
      throw new RangeError('Lookup history exceeded its maximum depth')
    }
    this.validateLookupOutput(output, 'Lookup history output', undefined, context)
    if (output.beef === undefined) {
      throw new Error('Output must have associated transaction BEEF!')
    }
    const outputKey = this.toOutputCacheKey(output.txid, output.outputIndex)
    if (ancestors.has(outputKey)) throw new TypeError('Lookup history contains a cycle')
    context.hydratedNodes += 1
    context.relationCount += output.outputsConsumed.length
    if (
      context.hydratedNodes > MAX_LOOKUP_HYDRATION_NODES ||
      context.relationCount > MAX_OUTPUT_RELATIONS
    ) {
      throw new RangeError('Lookup history traversal exceeded its work budget')
    }

    const tx = Transaction.fromBEEF(output.beef)
    const inputIndexBySource = new Map<string, number>()
    tx.inputs.forEach((candidateInput, index) => {
      const sourceTXID =
        candidateInput.sourceTXID !== undefined && candidateInput.sourceTXID !== ''
          ? candidateInput.sourceTXID
          : candidateInput.sourceTransaction?.id('hex')

      if (sourceTXID === undefined) return
      const key = this.toOutputCacheKey(sourceTXID, candidateInput.sourceOutputIndex)
      if (inputIndexBySource.has(key)) {
        throw new TypeError('Lookup history transaction contains duplicate source outpoints')
      }
      inputIndexBySource.set(key, index)
    })
    for (const relation of output.outputsConsumed) {
      if (!inputIndexBySource.has(this.toOutputCacheKey(relation.txid, relation.outputIndex))) {
        throw new TypeError('Lookup history relation is not an input of its transaction')
      }
    }

    await this.preloadOutputsWithBEEF(output.outputsConsumed, context)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(outputKey)
    const childNodes: HydratedUTXOHistoryNode[] = []
    for (const outputIdentifier of output.outputsConsumed) {
      const childOutput = await this.loadOutputWithBEEF(
        outputIdentifier.txid,
        outputIdentifier.outputIndex,
        context
      )
      if (childOutput === null) continue
      const childNode = await this.hydrateUTXOHistoryNode(
        childOutput,
        historySelector,
        currentDepth + 1,
        context,
        nextAncestors
      )
      if (childNode !== undefined) childNodes.push(childNode)
    }

    for (const child of childNodes) {
      const inputIndex = inputIndexBySource.get(
        this.toOutputCacheKey(child.output.txid, child.output.outputIndex)
      )

      if (inputIndex === -1 || inputIndex == null) {
        continue
      }

      const targetInput = tx.inputs[inputIndex]
      if (!targetInput) {
        this.logger.error(
          `Input at index ${inputIndex} is undefined, but findIndex found it. Possible sparse array from BEEF parsing.`
        )
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
  private validateCurrentAdvertisements(
    value: unknown,
    protocol: 'SHIP' | 'SLAP',
    advertiser: Advertiser
  ): Advertisement[] {
    if (!Array.isArray(value) || value.length > MAX_CURRENT_ADVERTISEMENTS) {
      throw new TypeError('Advertiser returned an invalid or oversized advertisement set')
    }
    let totalBeefBytes = 0
    return value.map((candidate, index) => {
      if (typeof candidate !== 'object' || candidate === null) {
        throw new TypeError(`Advertisement[${index}] is invalid`)
      }
      const advertisement = candidate as Advertisement
      if (advertisement.protocol !== protocol) {
        throw new TypeError(`Advertisement[${index}] has the wrong protocol`)
      }
      assertRegistryName(advertisement.topicOrService, `Advertisement[${index}] name`)
      if (
        typeof advertisement.identityKey !== 'string' ||
        !/^(?:02|03)[0-9a-fA-F]{64}$/.test(advertisement.identityKey) ||
        typeof advertisement.domain !== 'string' ||
        !this.isValidUrl(advertisement.domain) ||
        !Array.isArray(advertisement.beef) ||
        advertisement.beef.length === 0 ||
        advertisement.beef.length > MAX_SUBMISSION_BEEF_BYTES ||
        advertisement.beef.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
      ) {
        throw new TypeError(`Advertisement[${index}] has invalid identity, domain, or BEEF`)
      }
      assertOutputIndex(advertisement.outputIndex, `Advertisement[${index}] output index`)
      totalBeefBytes += advertisement.beef.length
      if (totalBeefBytes > MAX_LOOKUP_TOTAL_BEEF_BYTES) {
        throw new RangeError('Advertisement BEEF exceeded its total byte budget')
      }
      const transaction = Transaction.fromBEEF(advertisement.beef)
      if (advertisement.outputIndex >= transaction.outputs.length) {
        throw new TypeError(`Advertisement[${index}] output index is outside its transaction`)
      }
      const parsed = advertiser.parseAdvertisement(
        transaction.outputs[advertisement.outputIndex].lockingScript
      )
      if (
        parsed.protocol !== advertisement.protocol ||
        parsed.identityKey.toLowerCase() !== advertisement.identityKey.toLowerCase() ||
        parsed.topicOrService !== advertisement.topicOrService ||
        normalizePeerEndpoint(parsed.domain) !== normalizePeerEndpoint(advertisement.domain)
      ) {
        throw new TypeError(`Advertisement[${index}] metadata does not match its BEEF`)
      }
      return {
        ...advertisement,
        identityKey: advertisement.identityKey.toLowerCase(),
        domain: normalizePeerEndpoint(advertisement.domain),
        beef: [...advertisement.beef]
      }
    })
  }

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
    const normalizedHostingURL = normalizePeerEndpoint(this.hostingURL)

    // Step 1: Retrieve Current Configuration
    let configuredTopics = Object.keys(this.managers)
    let configuredServices = Object.keys(this.lookupServices)

    // Filter out default SHIP/SLAP topics/services if suppressDefaultSyncAdvertisements is true
    if (this.suppressDefaultSyncAdvertisements === true) {
      configuredTopics = configuredTopics.filter(
        topic => topic !== 'tm_ship' && topic !== 'tm_slap'
      )
      configuredServices = configuredServices.filter(
        service => service !== 'ls_ship' && service !== 'ls_slap'
      )
    }

    // Step 2: Fetch Existing Advertisements
    const currentSHIPAdvertisements = this.validateCurrentAdvertisements(
      await advertiser.findAllAdvertisements('SHIP'),
      'SHIP',
      advertiser
    )
    const currentSLAPAdvertisements = this.validateCurrentAdvertisements(
      await advertiser.findAllAdvertisements('SLAP'),
      'SLAP',
      advertiser
    )

    // Step 3: Compare and Determine Actions
    const requiredSHIPAdvertisements = new Set(configuredTopics)
    const requiredSLAPAdvertisements = new Set(configuredServices)

    const shipsToCreate = Array.from(requiredSHIPAdvertisements).filter(
      topicOrService =>
        !currentSHIPAdvertisements.some(
          x => x.topicOrService === topicOrService && x.domain === normalizedHostingURL
        )
    )
    const slapsToCreate = Array.from(requiredSLAPAdvertisements).filter(
      topicOrService =>
        !currentSLAPAdvertisements.some(
          x => x.topicOrService === topicOrService && x.domain === normalizedHostingURL
        )
    )
    const shipsToRevoke = currentSHIPAdvertisements.filter(
      ad => !requiredSHIPAdvertisements.has(ad.topicOrService)
    )
    const slapsToRevoke = currentSLAPAdvertisements.filter(
      ad => !requiredSLAPAdvertisements.has(ad.topicOrService)
    )

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
        const taggedBEEF = await advertiser.revokeAdvertisements([
          ...shipsToRevoke,
          ...slapsToRevoke
        ])
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
      const configuredEndpoints = this.syncConfiguration[topic]
      if (configuredEndpoints === false) continue
      if (!Array.isArray(configuredEndpoints) && configuredEndpoints !== 'SHIP') continue

      const syncEndpoints = await this.resolveSyncEndpointsForTopic(
        topic,
        'Failed to parse advertisement output:'
      )
      this.logger.info(
        `[GASP SYNC] Will attempt to sync with ${syncEndpoints.length} peer${syncEndpoints.length === 1 ? '' : 's'}`
      )
      // Sync with each endpoint sequentially to avoid parallel locks while
      // keeping peer failures isolated.
      for (const endpoint of syncEndpoints) {
        await this.syncGASPWithPeer(topic, endpoint)
      }
    }
  }

  private async syncGASPWithPeer(topic: string, endpoint: string): Promise<void> {
    this.logger.info(`[GASP SYNC] Starting sync for topic "${topic}" with peer "${endpoint}"`)

    try {
      const lastInteraction = await this.storage.getLastInteraction(endpoint, topic)
      assertNonnegativeInteger(lastInteraction, 'Stored GASP last interaction')
      const gasp = new GASP(
        new OverlayGASPStorage(topic, this),
        new OverlayGASPRemote(endpoint, topic),
        lastInteraction,
        `[GASP Sync of ${topic} with ${endpoint}]`,
        true,
        true
      )
      await gasp.sync(endpoint, DEFAULT_GASP_SYNC_LIMIT)

      if (gasp.lastInteraction > lastInteraction) {
        await this.storage.updateLastInteraction(endpoint, topic, gasp.lastInteraction)
      }
      this.logger.info(`[GASP SYNC] Sync successful for topic "${topic}" with peer "${endpoint}"`)
    } catch (error) {
      this.logger.error(
        `[GASP SYNC] Sync failed for topic "${topic}" with peer "${endpoint}"`,
        error
      )
      // Continue on to the next endpoint without throwing.
    }
  }

  private async resolveSyncEndpointsForTopic(
    topic: string,
    advertisementErrorMessage = 'Failed to parse BASM advertisement output:'
  ): Promise<string[]> {
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
        for (const output of lookupAnswer.outputs) {
          try {
            const tx = Transaction.fromBEEF(output.beef)
            assertOutputIndex(output.outputIndex, 'SHIP advertisement output index')
            if (
              output.txid !== undefined &&
              (typeof output.txid !== 'string' ||
                output.txid.toLowerCase() !== tx.id('hex').toLowerCase())
            ) {
              throw new TypeError('SHIP advertisement transaction ID does not match its BEEF')
            }
            const selectedOutput = tx.outputs[output.outputIndex]
            if (selectedOutput == null || selectedOutput.satoshis !== 1) {
              throw new TypeError('SHIP advertisement must identify a one-satoshi output')
            }
            const advertisement = await decodeAndVerifyDiscoveryAdvertisement(
              selectedOutput.lockingScript,
              'SHIP'
            )
            if (advertisement.topicOrService !== topic) {
              throw new TypeError('SHIP advertisement does not match the requested topic')
            }
            endpointSet.add(advertisement.domain)
          } catch (error) {
            this.logger.error(advertisementErrorMessage, error)
          }
        }
      }
      syncEndpoints = Array.from(endpointSet)
    }

    if (!Array.isArray(syncEndpoints)) {
      return []
    }

    const normalizedHostingURL =
      typeof this.hostingURL === 'string'
        ? (() => {
            try {
              return normalizePeerEndpoint(this.hostingURL)
            } catch {
              return this.hostingURL
            }
          })()
        : undefined
    const validated = new Set<string>()
    for (const endpoint of syncEndpoints) {
      try {
        const normalized = normalizePeerEndpoint(endpoint)
        if (normalized !== normalizedHostingURL) validated.add(normalized)
      } catch (error) {
        this.logger.error(
          `[OVERLAY SYNC] Ignoring unsafe peer endpoint ${serializeLogValue(endpoint)}: ${serializeErrorForLog(error)}`
        )
      }
      if (validated.size >= MAX_SYNC_ENDPOINTS_PER_TOPIC) break
    }
    return [...validated]
  }

  private assertSupportedBASMTopic(topic: string): void {
    assertTopic(topic, 'BASM topic')
    if (this.managers[topic] === undefined || this.managers[topic] === null) {
      throw new Error(`This server does not support this topic: ${topic}`)
    }
  }

  private assertTopicAnchorTip(
    value: unknown,
    topic: string,
    label: string
  ): asserts value is TopicAnchorTip {
    if (typeof value !== 'object' || value === null) throw new TypeError(`${label} is invalid`)
    const tip = value as Record<string, unknown>
    assertTopic(tip.topic, `${label} topic`)
    if (tip.topic !== topic) throw new TypeError(`${label} does not match the requested topic`)
    if (!Number.isSafeInteger(tip.blockHeight) || (tip.blockHeight as number) < -1) {
      throw new TypeError(`${label} height is invalid`)
    }
    assertHash(tip.tac, `${label} TAC`)
    if (tip.blockHash !== undefined) assertHash(tip.blockHash, `${label} block hash`)
    if (tip.basmRoot !== undefined) assertHash(tip.basmRoot, `${label} BASM root`)
    if (tip.admittedCount !== undefined) {
      assertNonnegativeInteger(tip.admittedCount, `${label} admitted count`)
      if (tip.admittedCount > MAX_BASM_ADMITTED_PER_BLOCK) {
        throw new RangeError(`${label} admitted count is too large`)
      }
    }
  }

  private assertTopicBlockAnchor(
    value: unknown,
    topic: string,
    label: string,
    expectedHeight?: number,
    expectedBlockHash?: string
  ): asserts value is TopicBlockAnchor {
    if (typeof value !== 'object' || value === null) throw new TypeError(`${label} is invalid`)
    const anchor = value as Record<string, unknown>
    assertTopic(anchor.topic, `${label} topic`)
    if (anchor.topic !== topic) throw new TypeError(`${label} does not match the requested topic`)
    assertNonnegativeInteger(anchor.blockHeight, `${label} height`)
    if (expectedHeight !== undefined && anchor.blockHeight !== expectedHeight) {
      throw new TypeError(`${label} does not match the requested height`)
    }
    assertHash(anchor.blockHash, `${label} block hash`)
    if (
      expectedBlockHash !== undefined &&
      anchor.blockHash.toLowerCase() !== expectedBlockHash.toLowerCase()
    ) {
      throw new TypeError(`${label} does not match the requested block hash`)
    }
    assertHash(anchor.basmRoot, `${label} BASM root`)
    assertHash(anchor.tac, `${label} TAC`)
    assertNonnegativeInteger(anchor.admittedCount, `${label} admitted count`)
    if (anchor.admittedCount > MAX_BASM_ADMITTED_PER_BLOCK) {
      throw new RangeError(`${label} admitted count is too large`)
    }
  }

  async provideTopicAnchorTip(topic: string): Promise<TopicAnchorTip> {
    if (typeof this.storage.findTopicAnchorTip !== 'function') {
      throw Object.assign(new TypeError('Storage does not support BASM topic anchor tips'), {
        code: 'BASM_UNSUPPORTED'
      })
    }
    const tip = await this.storage.findTopicAnchorTip?.(topic)
    if (tip !== undefined) {
      this.assertTopicAnchorTip(tip, topic, 'Stored BASM tip')
      return tip
    }
    return {
      topic,
      blockHeight: -1,
      tac: BASM_ZERO_HASH
    }
  }

  async provideTopicAnchorRange(
    topic: string,
    fromHeight: number,
    toHeight: number
  ): Promise<TopicAnchorRangeResponse> {
    this.assertSupportedBASMTopic(topic)
    if (typeof this.storage.findTopicBlockAnchors !== 'function') {
      throw Object.assign(new TypeError('Storage does not support BASM topic anchor ranges'), {
        code: 'BASM_UNSUPPORTED'
      })
    }
    if (
      !Number.isSafeInteger(fromHeight) ||
      !Number.isSafeInteger(toHeight) ||
      fromHeight < 0 ||
      toHeight < fromHeight
    ) {
      throw new Error('Invalid topic anchor range')
    }
    if (toHeight - fromHeight + 1 > DEFAULT_BASM_RANGE_LIMIT) {
      throw new Error(`Topic anchor range is capped at ${DEFAULT_BASM_RANGE_LIMIT} heights`)
    }

    const anchors = await this.storage.findTopicBlockAnchors(
      topic,
      fromHeight,
      toHeight,
      toHeight - fromHeight + 2
    )
    if (!Array.isArray(anchors) || anchors.length > toHeight - fromHeight + 1) {
      throw new TypeError('Storage returned an invalid or oversized BASM anchor range')
    }
    let previousHeight = -1
    for (const anchor of anchors) {
      this.assertTopicBlockAnchor(anchor, topic, 'Stored BASM anchor')
      if (
        anchor.blockHeight < fromHeight ||
        anchor.blockHeight > toHeight ||
        anchor.blockHeight <= previousHeight
      ) {
        throw new TypeError('Storage returned an unbound or unordered BASM anchor range')
      }
      previousHeight = anchor.blockHeight
    }
    return { topic, anchors }
  }

  async provideAdmittedList(
    topic: string,
    blockHeight: number,
    blockHash?: string
  ): Promise<AdmittedListResponse> {
    this.assertSupportedBASMTopic(topic)
    if (typeof this.storage.findAdmittedTransactionsForBlock !== 'function') {
      throw Object.assign(new TypeError('Storage does not support BASM admitted lists'), {
        code: 'BASM_UNSUPPORTED'
      })
    }
    assertNonnegativeInteger(blockHeight, 'BASM admitted-list height')
    if (blockHash !== undefined) assertHash(blockHash, 'BASM admitted-list block hash')

    const admitted = await this.storage.findAdmittedTransactionsForBlock(
      topic,
      blockHeight,
      blockHash,
      MAX_BASM_ADMITTED_PER_BLOCK + 1
    )
    if (!Array.isArray(admitted) || admitted.length > MAX_BASM_ADMITTED_PER_BLOCK) {
      throw new RangeError('Storage returned an invalid or oversized BASM admitted list')
    }
    const seen = new Set<string>()
    const seenBlockIndexes = new Set<number>()
    for (const [index, item] of admitted.entries()) {
      if (typeof item !== 'object' || item === null)
        throw new TypeError(`Invalid BASM admission at index ${index}`)
      assertHash(item.txid, `BASM admission[${index}] txid`)
      assertNonnegativeInteger(item.blockIndex, `BASM admission[${index}] block index`)
      const canonical = item.txid.toLowerCase()
      if (seen.has(canonical)) throw new TypeError('Storage returned duplicate BASM admissions')
      if (seenBlockIndexes.has(item.blockIndex)) {
        throw new TypeError('Storage returned duplicate BASM block indexes')
      }
      seen.add(canonical)
      seenBlockIndexes.add(item.blockIndex)
    }

    return {
      topic,
      blockHeight,
      blockHash,
      admitted
    }
  }

  async provideCompoundMerklePath(
    topic: string,
    blockHeight: number,
    txids: string[]
  ): Promise<CompoundMerklePathResponse> {
    this.assertSupportedBASMTopic(topic)
    if (typeof this.storage.findTransactionMerklePaths !== 'function') {
      throw Object.assign(new TypeError('Storage does not support direct Merkle path lookup'), {
        code: 'BASM_UNSUPPORTED'
      })
    }
    assertNonnegativeInteger(blockHeight, 'BASM compound-path height')
    assertTxidList(txids, 'BASM compound-path txids')

    const admitted = await this.storage.findAdmittedTransactionsForBlock?.(
      topic,
      blockHeight,
      undefined,
      MAX_BASM_ADMITTED_PER_BLOCK + 1
    )
    if (admitted !== undefined) {
      if (!Array.isArray(admitted) || admitted.length > MAX_BASM_ADMITTED_PER_BLOCK) {
        throw new TypeError('Storage returned an invalid or oversized BASM admitted list')
      }
      computeBasmRoot(admitted)
      const admittedSet = new Set(admitted.map(item => item.txid.toLowerCase()))
      const missingAdmissions = txids.filter(txid => !admittedSet.has(txid.toLowerCase()))
      if (missingAdmissions.length > 0) {
        throw new Error(
          `Requested txids are not admitted to topic ${topic} at height ${blockHeight}: ${missingAdmissions.join(',')}`
        )
      }
    }

    const proofs = await this.storage.findTransactionMerklePaths(txids)
    if (!Array.isArray(proofs) || proofs.length > txids.length) {
      throw new TypeError('Storage returned an invalid BASM proof set')
    }
    const requested = new Set(txids.map(txid => txid.toLowerCase()))
    const proofByTxid = new Map<string, (typeof proofs)[number]>()
    for (const proof of proofs) {
      assertHash(proof.txid, 'BASM proof txid')
      const canonical = proof.txid.toLowerCase()
      if (
        !requested.has(canonical) ||
        proofByTxid.has(canonical) ||
        typeof proof.merklePath !== 'string'
      ) {
        throw new TypeError('Storage returned an unexpected or duplicate BASM proof')
      }
      proofByTxid.set(canonical, proof)
    }
    const missing = txids.filter(txid => !proofByTxid.has(txid.toLowerCase()))
    if (missing.length > 0) {
      throw new Error(`No direct Merkle path found for txids: ${missing.join(',')}`)
    }

    let compound: MerklePath | undefined
    for (const txid of txids) {
      const proof = proofByTxid.get(txid.toLowerCase())
      if (proof === undefined) continue
      const path = MerklePath.fromHex(proof.merklePath)
      if (path.blockHeight !== blockHeight) {
        throw new Error(
          `Merkle path for ${txid} is at height ${path.blockHeight}, expected ${blockHeight}`
        )
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

  async provideRawTransactions(txids: string[], topic?: string): Promise<RawTransactionResponse> {
    if (typeof this.storage.findRawTransactions !== 'function') {
      throw Object.assign(new TypeError('Storage does not support raw transaction lookup'), {
        code: 'BASM_UNSUPPORTED'
      })
    }
    assertTxidList(txids, 'BASM raw-transaction txids')
    if (topic === undefined) {
      throw new TypeError('A BASM topic is required for raw transaction lookup')
    }
    this.assertSupportedBASMTopic(topic)

    const authorizedTxids = (
      await Promise.all(
        txids.map(async txid => {
          const authorized = await this.storage.doesAppliedTransactionExist({ txid, topic })
          if (typeof authorized !== 'boolean') {
            throw new TypeError('Storage returned an invalid BASM authorization verdict')
          }
          return { txid, authorized }
        })
      )
    )
      .filter(entry => entry.authorized)
      .map(entry => entry.txid)

    const transactions = await this.storage.findRawTransactions(authorizedTxids)
    if (!Array.isArray(transactions) || transactions.length > authorizedTxids.length) {
      throw new TypeError('Storage returned an invalid BASM raw-transaction set')
    }
    const requested = new Set(authorizedTxids.map(txid => txid.toLowerCase()))
    const found = new Set<string>()
    for (const transaction of transactions) {
      assertRawTransactionMatches(transaction.txid, transaction.rawTx)
      const canonical = transaction.txid.toLowerCase()
      if (!requested.has(canonical) || found.has(canonical)) {
        throw new TypeError('Storage returned an unexpected or duplicate BASM raw transaction')
      }
      found.add(canonical)
    }
    return {
      transactions,
      missing: txids.filter(txid => !found.has(txid.toLowerCase()))
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

  private async reconcileBASMWithPeer(
    topic: string,
    endpoint: string
  ): Promise<BASMPeerSyncReport> {
    const report: BASMPeerSyncReport = {
      topic,
      endpoint,
      status: 'skipped',
      checkedHeights: [],
      missingTxids: [],
      fetchedTxCount: 0
    }

    try {
      const remote = new BASMRemote(endpoint, topic, this.basmFetchImpl)
      const [localTip, remoteTip] = await Promise.all([
        this.provideTopicAnchorTip(topic),
        remote.requestTopicAnchorTip()
      ])
      report.localTip = localTip
      report.remoteTip = remoteTip
      await this.requireMatchingRemoteBASMTip(remote, remoteTip)
      if (localTip.blockHeight >= remoteTip.blockHeight) {
        return await this.finishBASMWhenRemoteIsNotAhead(topic, localTip, remoteTip, report)
      }
      return await this.advanceBASMWithRemoteAnchors(topic, remote, localTip, remoteTip, report)
    } catch (error) {
      return this.markBASMPeerSyncError(report, topic, endpoint, error)
    }
  }

  private async requireMatchingRemoteBASMTip(
    remote: BASMRemote,
    remoteTip: TopicAnchorTip
  ): Promise<void> {
    if (remoteTip.blockHeight < 0) {
      return
    }
    const tipRange = await remote.requestTopicAnchorRange(
      remoteTip.blockHeight,
      remoteTip.blockHeight
    )
    const remoteTipAnchor = tipRange.anchors[0]
    const tipAnchor = requireBASMDefined(
      remoteTipAnchor,
      remoteTipAnchor?.tac === remoteTip.tac,
      'BASM tip does not match its anchor'
    )
    for (const field of ['blockHash', 'basmRoot', 'admittedCount'] as const) {
      requireBASM(
        remoteTip[field] === undefined || remoteTip[field] === tipAnchor[field],
        'BASM tip metadata does not match its anchor'
      )
    }
    await this.requireCanonicalBASMAnchor(tipAnchor)
  }

  private async finishBASMWhenRemoteIsNotAhead(
    topic: string,
    localTip: TopicAnchorTip,
    remoteTip: TopicAnchorTip,
    report: BASMPeerSyncReport
  ): Promise<BASMPeerSyncReport> {
    const tipsMatch =
      localTip.tac === remoteTip.tac && localTip.blockHeight === remoteTip.blockHeight
    if (localTip.blockHeight >= 0 && tipsMatch) {
      const localAnchor = await this.storage.findTopicBlockAnchor?.(topic, localTip.blockHeight)
      await this.requireCanonicalBASMAnchor(
        requireBASMDefined(
          localAnchor,
          localAnchor?.tac === localTip.tac,
          'Local BASM tip lacks its anchor'
        )
      )
    }
    report.status = tipsMatch ? 'matched' : 'diverged'
    report.message = tipsMatch
      ? 'Topic anchor tips match'
      : 'Remote tip is not ahead; historical divergence needs manual or binary-search reconciliation'
    return report
  }

  private requireBASMRangePrefix(
    localTip: TopicAnchorTip,
    remoteTip: TopicAnchorTip,
    fromHeight: number,
    toHeight: number,
    anchors: TopicBlockAnchor[]
  ): void {
    requireBASM(
      anchors.length > 0 && anchors.at(-1)?.blockHeight === toHeight,
      'BASM range omits its requested target'
    )
    requireBASM(
      localTip.blockHeight < 0 || anchors[0].blockHeight === fromHeight,
      'BASM range omits its next height'
    )
    let previousTac = localTip.tac
    for (const anchor of anchors) {
      requireBASM(
        anchor.tac === computeTac(previousTac, anchor.blockHash, anchor.basmRoot),
        'BASM range TAC is inconsistent with its prefix'
      )
      previousTac = anchor.tac
    }
    if (toHeight === remoteTip.blockHeight)
      requireBASM(previousTac === remoteTip.tac, 'BASM range differs from its tip')
  }

  private async advanceBASMWithRemoteAnchors(
    topic: string,
    remote: BASMRemote,
    localTip: TopicAnchorTip,
    remoteTip: TopicAnchorTip,
    report: BASMPeerSyncReport
  ): Promise<BASMPeerSyncReport> {
    const fromHeight =
      localTip.blockHeight < 0
        ? Math.max(remoteTip.blockHeight - DEFAULT_BASM_SYNC_PAGE_SIZE + 1, 0)
        : localTip.blockHeight + 1
    const toHeight = Math.min(fromHeight + DEFAULT_BASM_SYNC_PAGE_SIZE - 1, remoteTip.blockHeight)
    const range = await remote.requestTopicAnchorRange(fromHeight, toHeight)
    this.requireBASMRangePrefix(localTip, remoteTip, fromHeight, toHeight, range.anchors)
    for (const remoteAnchor of range.anchors) {
      await this.reconcileRemoteAnchor(topic, remote, remoteAnchor, report)
      if (report.status === 'diverged') return report
    }

    const finalRemoteTip = await remote.requestTopicAnchorTip()
    requireBASM(
      finalRemoteTip.blockHeight === remoteTip.blockHeight && finalRemoteTip.tac === remoteTip.tac,
      'BASM peer history changed during reconciliation'
    )

    const refreshedTip = await this.provideTopicAnchorTip(topic)
    report.localTip = refreshedTip
    report.status =
      refreshedTip.blockHeight === remoteTip.blockHeight && refreshedTip.tac === remoteTip.tac
        ? 'matched'
        : 'advanced'
    return report
  }

  private markBASMPeerSyncError(
    report: BASMPeerSyncReport,
    topic: string,
    endpoint: string,
    error: unknown
  ): BASMPeerSyncReport {
    report.status = 'error'
    if (error instanceof Error && 'code' in error && typeof error.code === 'string')
      report.errorCode = error.code
    report.message = error instanceof Error ? error.message : String(error)
    this.logger.error(`[BASM SYNC] Sync failed for topic "${topic}" with peer "${endpoint}"`, error)
    return report
  }

  private async requireCanonicalBASMAnchor(
    anchor: TopicBlockAnchor,
    proofRoot?: string
  ): Promise<TopicAnchorHeader> {
    if (this.chainTracker === 'scripts only' || this.topicAnchorHeaderResolver === undefined) {
      throw new Error('BASM reconciliation requires a ChainTracker and canonical header resolver')
    }
    const resolvedHeader = await this.topicAnchorHeaderResolver(anchor.blockHeight)
    const header = requireBASMDefined(
      resolvedHeader,
      resolvedHeader?.blockHeight === anchor.blockHeight,
      'BASM canonical header is unavailable or has the wrong height'
    )
    requireBASM(
      basmHash(header.blockHash.toLowerCase(), 'canonical block hash') === anchor.blockHash,
      'BASM anchor block hash is not canonical'
    )
    if (proofRoot !== undefined && header.merkleRoot !== undefined) {
      requireBASM(
        header.merkleRoot.toLowerCase() === proofRoot,
        'BASM proof root differs from its canonical header'
      )
    }
    if (header.blockTransactionCount !== undefined) {
      basmInteger(header.blockTransactionCount, 'canonical block transaction count', 1)
      requireBASM(
        anchor.admittedCount <= header.blockTransactionCount,
        'BASM admitted count exceeds canonical block transaction count'
      )
    }
    return header
  }

  private validateBASMProofPositions(
    path: MerklePath,
    admitted: AdmittedTxRef[],
    count: number
  ): void {
    requireBASM(
      admitted.every(item => item.blockIndex < count),
      'BASM admitted index exceeds canonical block transaction count'
    )
    let width = count
    for (let height = 0; height < path.path.length; height++) {
      requireBASM(height === 0 || width > 1, 'BASM proof exceeds canonical tree depth')
      for (const node of path.path[height]) {
        requireBASM(
          node.duplicate === true ? width % 2 === 1 && node.offset === width : node.offset < width,
          'BASM proof node is outside canonical block positions'
        )
      }
      width = Math.ceil(width / 2)
    }
  }

  private async reconcileRemoteAnchor(
    topic: string,
    remote: BASMRemote,
    remoteAnchor: TopicBlockAnchor,
    report: BASMPeerSyncReport
  ): Promise<void> {
    await this.requireCanonicalBASMAnchor(remoteAnchor)
    report.checkedHeights.push(remoteAnchor.blockHeight)
    const localAnchor = await this.storage.findTopicBlockAnchor?.(
      topic,
      remoteAnchor.blockHeight,
      remoteAnchor.blockHash
    )
    if (localAnchor !== undefined) {
      this.assertTopicBlockAnchor(
        localAnchor,
        topic,
        'Stored local BASM anchor',
        remoteAnchor.blockHeight,
        remoteAnchor.blockHash
      )
    }
    if (localAnchor?.tac === remoteAnchor.tac) {
      return
    }

    const admittedResponse = await remote.requestAdmittedList(
      remoteAnchor.blockHeight,
      remoteAnchor.blockHash
    )
    const remoteBasmRoot = computeBasmRoot(admittedResponse.admitted)
    if (
      remoteBasmRoot !== remoteAnchor.basmRoot ||
      admittedResponse.admitted.length !== remoteAnchor.admittedCount
    ) {
      throw new Error(
        `Peer ${report.endpoint} supplied an admitted list inconsistent with its anchor at height ${remoteAnchor.blockHeight}`
      )
    }

    const localAdmitted =
      (await this.storage.findAdmittedTransactionsForBlock?.(
        topic,
        remoteAnchor.blockHeight,
        remoteAnchor.blockHash
      )) ?? []
    // BRC-136: an empty topic at a height has k = 0 and R = 32 zero bytes, which
    // the root/count check above has already enforced. There is no transaction
    // to bind to a proof or to fetch, so the height is checked without a proof
    // round trip; it only diverges when this node admitted something there.
    if (admittedResponse.admitted.length === 0) {
      if (localAdmitted.length > 0) report.status = 'diverged'
      return
    }
    const localTxids = new Set(localAdmitted.map(item => item.txid))
    const missingTxids = admittedResponse.admitted
      .map(item => item.txid)
      .filter(txid => !localTxids.has(txid))

    report.missingTxids.push(...missingTxids)
    // The BASM root only commits to txid order. Bind claimed original indices to
    // the compound path even when every remote txid is already local.
    const assurance = await this.fetchBASMMissingTransactions(
      remote,
      topic,
      remoteAnchor,
      admittedResponse.admitted,
      missingTxids
    )
    if (report.positionValidation !== 'encoded-offset-only') report.positionValidation = assurance
    if (missingTxids.length === 0) {
      report.status = 'diverged'
      return
    }
    report.fetchedTxCount += missingTxids.length
  }

  private async fetchBASMMissingTransactions(
    remote: BASMRemote,
    topic: string,
    anchor: TopicBlockAnchor,
    admitted: AdmittedTxRef[],
    txids: string[]
  ): Promise<'canonical-count' | 'encoded-offset-only'> {
    if (this.chainTracker === 'scripts only') {
      throw new Error(
        'BASM reconciliation requires a ChainTracker capable of validating BUMP proofs'
      )
    }

    // Validate the whole claimed ordered subset, including entries already local:
    // the BASM root alone does not bind the peer's claimed original positions.
    const proofResponse = await remote.requestCompoundMerklePath(
      anchor.blockHeight,
      admitted.map(item => item.txid)
    )
    const compoundPath = MerklePath.fromHex(proofResponse.merklePath)
    requireBASM(
      compoundPath.blockHeight === anchor.blockHeight,
      'BASM proof height does not match its anchor'
    )
    requireBASM(
      compoundPath.toHex() === proofResponse.merklePath.toLowerCase(),
      'BASM proof is not canonically encoded'
    )
    const proofRoot = compoundPath.computeRoot()
    const proofHeader = await this.requireCanonicalBASMAnchor(anchor, proofRoot)
    if (proofHeader.blockTransactionCount !== undefined) {
      this.validateBASMProofPositions(compoundPath, admitted, proofHeader.blockTransactionCount)
    }
    for (const { txid, blockIndex } of admitted) {
      const leaf = compoundPath.path[0]?.find(item => item.hash === txid)
      requireBASM(leaf?.offset === blockIndex, 'BASM proof does not bind the admitted block index')
      requireBASM(
        compoundPath.path[0].length !== 1 || compoundPath.path.length !== 1 || blockIndex === 0,
        'BASM singleton proof has a nonzero block index'
      )
      requireBASM(
        compoundPath.computeRoot(txid) === proofRoot,
        'BASM proof root does not match the admitted transaction'
      )
    }
    // Inclusion is root/height, not coinbase maturity. MerklePath.verify also
    // applies the 100-block spendability rule at offset 0.
    const valid = await this.chainTracker.isValidRootForHeight(proofRoot, compoundPath.blockHeight)
    if (!valid) {
      throw new Error(`Peer supplied invalid compound Merkle path at height ${anchor.blockHeight}`)
    }
    if (txids.length === 0) {
      return proofHeader.blockTransactionCount === undefined
        ? 'encoded-offset-only'
        : 'canonical-count'
    }

    const rawResponse = await remote.requestRawTransactions(txids)
    if (rawResponse.missing.length > 0) {
      throw new Error(
        `Peer did not return raw transactions for txids: ${rawResponse.missing.join(',')}`
      )
    }

    const transactions = rawResponse.transactions.map(record => {
      const tx = Transaction.fromHex(record.rawTx)
      if (tx.id('hex') !== record.txid || tx.toHex() !== record.rawTx.toLowerCase()) {
        throw new Error(
          `Raw transaction txid mismatch: expected ${record.txid}, got ${tx.id('hex')}`
        )
      }
      tx.merklePath = compoundPath.extract([record.txid])
      return tx
    })
    const refreshedAnchor = (
      await remote.requestTopicAnchorRange(anchor.blockHeight, anchor.blockHeight)
    ).anchors[0]
    requireBASM(
      refreshedAnchor?.blockHash === anchor.blockHash &&
        refreshedAnchor?.basmRoot === anchor.basmRoot &&
        refreshedAnchor?.admittedCount === anchor.admittedCount &&
        refreshedAnchor?.tac === anchor.tac,
      'BASM peer anchor changed before admission'
    )
    const commitHeader = await this.requireCanonicalBASMAnchor(anchor, proofRoot)
    requireBASM(
      commitHeader.blockTransactionCount === proofHeader.blockTransactionCount,
      'BASM canonical block transaction count changed before admission'
    )
    // Apply in the independently checked block order, regardless of raw response order.
    // Admit with 'historical-tx-no-spv': inclusion is already proven above by
    // isValidRootForHeight plus the canonical-header binding. Re-running
    // Transaction.verify would apply MerklePath.verify's coinbase 100-block
    // spendability rule and reject an admitted coinbase from a recent block.
    const transactionById = new Map(transactions.map(tx => [tx.id('hex'), tx]))
    for (const txid of txids) {
      const tx = transactionById.get(txid)
      requireBASM(tx !== undefined, 'BASM raw response omits a requested transaction')
      await this.submit({ beef: tx.toBEEF(), topics: [topic] }, undefined, 'historical-tx-no-spv')
    }
    const finalHeader = await this.requireCanonicalBASMAnchor(anchor, proofRoot)
    requireBASM(
      finalHeader.blockTransactionCount === proofHeader.blockTransactionCount,
      'BASM canonical block transaction count changed during admission'
    )
    return proofHeader.blockTransactionCount === undefined
      ? 'encoded-offset-only'
      : 'canonical-count'
  }

  async evictUnprovenTransactions(
    options: {
      topic?: string
      thresholdBlocks?: number
    } = {}
  ): Promise<{
    cutoffHeight: number
    candidates: number
    evictedTransactions: number
    evictedOutputs: number
  }> {
    if (typeof this.storage.findUnprovenAppliedTransactions !== 'function') {
      throw new TypeError('Storage does not support unproven transaction eviction')
    }
    if (typeof this.storage.deleteAppliedTransaction !== 'function') {
      throw new TypeError('Storage does not support applied transaction eviction')
    }
    if (this.chainTracker === 'scripts only') {
      throw new Error('Unproven eviction requires a ChainTracker to determine block age')
    }

    if (options.topic !== undefined) assertTopic(options.topic, 'Unproven eviction topic')
    const thresholdBlocks = options.thresholdBlocks ?? this.unprovenEvictionBlocks
    assertUnprovenThreshold(thresholdBlocks)
    const currentHeight = await this.chainTracker.currentHeight()
    assertNonnegativeInteger(currentHeight, 'Current chain height')
    const cutoffHeight = currentHeight - thresholdBlocks
    const candidates = await this.storage.findUnprovenAppliedTransactions(
      cutoffHeight,
      options.topic,
      { maxCandidates: MAX_UNPROVEN_CANDIDATES, maxOutputs: MAX_EVICTION_OUTPUTS }
    )
    this.validateUnprovenCandidates(candidates, cutoffHeight, options.topic)
    let evictedOutputs = 0

    for (const candidate of candidates) {
      for (const output of candidate.outputs) {
        for (const service of Object.values(this.lookupServices)) {
          try {
            await service.outputEvicted(output.txid, output.outputIndex)
          } catch (error) {
            this.logger.debug(
              `outputEvicted notification failed for ${output.txid}.${output.outputIndex}: ${error}`
            )
          }
        }
        await this.storage.deleteOutput(output.txid, output.outputIndex, candidate.topic)
        evictedOutputs++
      }
      await this.storage.deleteAppliedTransaction(candidate.txid, candidate.topic)
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
    proofProvider: (
      txid: string
    ) => Promise<{ merklePath: MerklePath; blockHeight?: number } | undefined>
  }): Promise<{
    cutoffHeight: number
    candidates: number
    refreshedTransactions: number
    missingProofs: number
    failedProofs: number
    failures: Array<{ txid: string; error: string }>
  }> {
    if (typeof this.storage.findUnprovenAppliedTransactions !== 'function') {
      throw new TypeError('Storage does not support unproven transaction lookup')
    }
    if (this.chainTracker === 'scripts only') {
      throw new Error('Unproven proof refresh requires a ChainTracker to determine block age')
    }

    if (
      typeof options !== 'object' ||
      options === null ||
      typeof options.proofProvider !== 'function'
    ) {
      throw new TypeError('Unproven proof refresh requires a proofProvider')
    }
    if (options.topic !== undefined) assertTopic(options.topic, 'Unproven refresh topic')
    const thresholdBlocks = options.thresholdBlocks ?? this.unprovenEvictionBlocks
    assertUnprovenThreshold(thresholdBlocks)
    const currentHeight = await this.chainTracker.currentHeight()
    assertNonnegativeInteger(currentHeight, 'Current chain height')
    const cutoffHeight = currentHeight - thresholdBlocks
    const candidates = await this.storage.findUnprovenAppliedTransactions(
      cutoffHeight,
      options.topic,
      { maxCandidates: MAX_UNPROVEN_CANDIDATES, maxOutputs: MAX_EVICTION_OUTPUTS }
    )
    this.validateUnprovenCandidates(candidates, cutoffHeight, options.topic)
    const txids = [...new Set(candidates.map(candidate => candidate.txid))]
    let refreshedTransactions = 0
    let missingProofs = 0
    let failedProofs = 0
    const failures: Array<{ txid: string; error: string }> = []

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
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1024)
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

  private validateUnprovenCandidates(
    candidates: unknown,
    cutoffHeight: number,
    requestedTopic?: string
  ): asserts candidates is Array<{
    txid: string
    topic: string
    firstSeenHeight?: number
    outputs: Array<{ txid: string; outputIndex: number }>
  }> {
    if (!Array.isArray(candidates) || candidates.length > MAX_UNPROVEN_CANDIDATES) {
      throw new TypeError('Storage returned an invalid or oversized unproven candidate set')
    }
    const seenCandidates = new Set<string>()
    const seenOutputs = new Set<string>()
    let outputCount = 0
    for (const [candidateIndex, candidate] of candidates.entries()) {
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        !Array.isArray(candidate.outputs)
      ) {
        throw new TypeError(
          `Storage returned an invalid unproven candidate at index ${candidateIndex}`
        )
      }
      assertHash(candidate.txid, `Unproven candidate[${candidateIndex}] txid`)
      assertTopic(candidate.topic, `Unproven candidate[${candidateIndex}] topic`)
      if (requestedTopic !== undefined && candidate.topic !== requestedTopic) {
        throw new TypeError('Storage returned an unproven candidate for a different topic')
      }
      if (candidate.firstSeenHeight === undefined) {
        throw new TypeError('Storage returned an unproven candidate without an age anchor')
      }
      assertNonnegativeInteger(
        candidate.firstSeenHeight,
        `Unproven candidate[${candidateIndex}] firstSeenHeight`
      )
      if (candidate.firstSeenHeight > cutoffHeight) {
        throw new TypeError('Storage returned an unproven candidate newer than the cutoff')
      }
      const candidateKey = `${candidate.txid.toLowerCase()}.${candidate.topic}`
      if (seenCandidates.has(candidateKey)) {
        throw new TypeError('Storage returned duplicate unproven candidates')
      }
      seenCandidates.add(candidateKey)
      outputCount += candidate.outputs.length
      if (outputCount > MAX_EVICTION_OUTPUTS) {
        throw new TypeError('Storage returned too many unproven outputs')
      }
      for (const [outputIndex, output] of candidate.outputs.entries()) {
        if (typeof output !== 'object' || output === null) {
          throw new TypeError(
            `Storage returned an invalid unproven output at ${candidateIndex}.${outputIndex}`
          )
        }
        assertHash(output.txid, `Unproven output[${candidateIndex}.${outputIndex}] txid`)
        assertOutputIndex(
          output.outputIndex,
          `Unproven output[${candidateIndex}.${outputIndex}] index`
        )
        if (output.txid.toLowerCase() !== candidate.txid.toLowerCase()) {
          throw new TypeError('Storage returned an unproven output for a different transaction')
        }
        const outputKey = `${candidateKey}.${output.outputIndex}`
        if (seenOutputs.has(outputKey)) {
          throw new TypeError('Storage returned duplicate unproven outputs')
        }
        seenOutputs.add(outputKey)
      }
    }
  }

  async maintainUnprovenTransactions(options: {
    topic?: string
    thresholdBlocks?: number
    proofProvider: (
      txid: string
    ) => Promise<{ merklePath: MerklePath; blockHeight?: number } | undefined>
  }): Promise<{
    refresh: {
      cutoffHeight: number
      candidates: number
      refreshedTransactions: number
      missingProofs: number
      failedProofs: number
      failures: Array<{ txid: string; error: string }>
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

  async evictAppliedTransaction(
    txid: string,
    options: {
      topic?: string
      reason?: string
    } = {}
  ): Promise<{
    txid: string
    reason?: string
    evictedTransactions: number
    evictedOutputs: number
  }> {
    if (typeof this.storage.deleteAppliedTransaction !== 'function') {
      throw new TypeError('Storage does not support applied transaction eviction')
    }

    assertHash(txid, 'Evicted transaction txid')
    if (options.topic !== undefined) assertTopic(options.topic, 'Eviction topic')
    if (
      options.reason !== undefined &&
      (typeof options.reason !== 'string' ||
        new TextEncoder().encode(options.reason).byteLength > MAX_EVICTION_REASON_BYTES)
    ) {
      throw new TypeError('Eviction reason must be a bounded string')
    }

    const outputs = await this.storage.findOutputsForTransaction(
      txid,
      false,
      MAX_EVICTION_OUTPUTS + 1
    )
    if (!Array.isArray(outputs) || outputs.length > MAX_EVICTION_OUTPUTS) {
      throw new TypeError('Storage returned an invalid or oversized eviction output set')
    }
    const seenOutputs = new Set<string>()
    for (const [index, output] of outputs.entries()) {
      if (typeof output !== 'object' || output === null) {
        throw new TypeError(`Storage returned an invalid eviction output at index ${index}`)
      }
      assertHash(output.txid, `Eviction output[${index}] txid`)
      assertOutputIndex(output.outputIndex, `Eviction output[${index}] index`)
      assertTopic(output.topic, `Eviction output[${index}] topic`)
      if (output.txid.toLowerCase() !== txid.toLowerCase()) {
        throw new TypeError('Storage returned an eviction output for a different transaction')
      }
      const key = `${output.txid.toLowerCase()}.${output.outputIndex}.${output.topic}`
      if (seenOutputs.has(key)) throw new TypeError('Storage returned duplicate eviction outputs')
      seenOutputs.add(key)
    }
    const filtered =
      options.topic === undefined
        ? outputs
        : outputs.filter(output => output.topic === options.topic)
    const topics = [...new Set(filtered.map(output => output.topic))]
    let evictedOutputs = 0

    for (const output of filtered) {
      for (const service of Object.values(this.lookupServices)) {
        try {
          await service.outputEvicted(output.txid, output.outputIndex)
        } catch (error) {
          this.logger.debug(
            `outputEvicted notification failed for ${output.txid}.${output.outputIndex}: ${error}`
          )
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
  async provideForeignSyncResponse(
    initialRequest: GASPInitialRequest,
    topic: string
  ): Promise<GASPInitialResponse> {
    this.assertSupportedBASMTopic(topic)
    if (
      typeof initialRequest !== 'object' ||
      initialRequest === null ||
      initialRequest.version !== 1
    ) {
      throw new TypeError('Unsupported or invalid GASP request version')
    }
    assertNonnegativeInteger(initialRequest.since, 'GASP request since')
    const limit = initialRequest.limit ?? 1000
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GASP_PAGE_SIZE) {
      throw new TypeError(`GASP request limit must be between 1 and ${MAX_GASP_PAGE_SIZE}`)
    }
    const outputs = await this.storage.findUTXOsForTopic(topic, initialRequest.since, limit)
    if (!Array.isArray(outputs) || outputs.length > limit) {
      throw new TypeError('Storage returned an invalid or oversized GASP UTXO list')
    }
    const seen = new Set<string>()
    const UTXOList = outputs.map((output, index) => {
      this.assertStoredOutputRelations(output, `GASP UTXO[${index}]`)
      if (output.topic !== topic) throw new TypeError('Storage returned a cross-topic GASP UTXO')
      assertNonnegativeInteger(output.score ?? 0, `GASP UTXO[${index}] score`)
      if ((output.score ?? 0) < initialRequest.since) {
        throw new TypeError('Storage returned a GASP UTXO below the requested score')
      }
      const outpoint = `${output.txid.toLowerCase()}.${output.outputIndex}`
      if (seen.has(outpoint)) throw new TypeError('Storage returned duplicate GASP UTXOs')
      seen.add(outpoint)
      return {
        txid: output.txid,
        outputIndex: output.outputIndex,
        score: output.score ?? 0
      }
    })

    return {
      UTXOList,
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
  async provideForeignGASPNode(
    graphID: string,
    txid: string,
    outputIndex: number,
    topic?: string
  ): Promise<GASPNode> {
    assertOutpoint(graphID, 'GASP graphID')
    assertHash(txid, 'GASP txid')
    assertOutputIndex(outputIndex, 'GASP output index')
    if (topic !== undefined) this.assertSupportedBASMTopic(topic)
    const searchedOutputs = new Set<string>()
    let searchedTransactions = 0
    let totalBeefBytes = 0

    const hydrator = async (
      output: Output | null,
      expected: { txid: string; outputIndex: number },
      depth: number,
      ancestors: ReadonlySet<string>
    ): Promise<GASPNode | undefined> => {
      if (output === null) return undefined
      this.validateLookupOutput(output, 'Stored GASP output', expected)
      if (output.beef === undefined) throw new Error('Stored GASP output has no transaction BEEF')
      if (topic !== undefined && output.topic !== topic) {
        throw new Error('Requested GASP output is not admitted to this topic')
      }
      if (depth > 2048 || searchedOutputs.size >= 2048) {
        throw new Error('GASP ancestry search exceeded its resource limit')
      }
      const outputID = this.toOutputCacheKey(output.txid, output.outputIndex)
      if (ancestors.has(outputID)) throw new Error('Cycle detected in stored GASP ancestry')
      if (searchedOutputs.has(outputID)) return undefined
      searchedOutputs.add(outputID)
      totalBeefBytes += output.beef.length
      if (totalBeefBytes > MAX_LOOKUP_TOTAL_BEEF_BYTES) {
        throw new Error('GASP transaction BEEF exceeded its resource limit')
      }

      const rootTx = Transaction.fromBEEF(output.beef)
      let correctTx: Transaction | undefined

      const transactionStack = [rootTx]
      const visitedTransactions = new Set<string>()
      while (transactionStack.length > 0) {
        const candidate = transactionStack.pop()!
        const candidateTxid = candidate.id('hex')
        if (visitedTransactions.has(candidateTxid)) continue
        searchedTransactions += 1
        if (searchedTransactions > 2048)
          throw new Error('GASP transaction ancestry exceeded its resource limit')
        visitedTransactions.add(candidateTxid)
        if (candidateTxid.toLowerCase() === txid.toLowerCase()) {
          correctTx = candidate
          break
        }
        for (const input of candidate.inputs) {
          if (input.sourceTransaction !== undefined) {
            if (transactionStack.length + searchedTransactions >= 2048) {
              throw new Error('GASP transaction ancestry exceeded its resource limit')
            }
            transactionStack.push(input.sourceTransaction)
          }
        }
      }

      if (correctTx === undefined) {
        if (output.outputsConsumed.length > 2048) {
          throw new Error('Stored GASP ancestry fan-out exceeded its resource limit')
        }
        const sourceOutpoints = new Set<string>()
        for (const input of rootTx.inputs) {
          const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
          if (sourceTXID !== undefined) {
            sourceOutpoints.add(this.toOutputCacheKey(sourceTXID, input.sourceOutputIndex))
          }
        }
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(outputID)
        for (const currentOutput of output.outputsConsumed) {
          const relationKey = this.toOutputCacheKey(currentOutput.txid, currentOutput.outputIndex)
          if (!sourceOutpoints.has(relationKey)) {
            throw new TypeError('Stored GASP ancestry relation is not a transaction input')
          }
          const outputFound = await this.storage.findOutput(
            currentOutput.txid,
            currentOutput.outputIndex,
            topic,
            undefined,
            true
          )
          const foundNode = await hydrator(outputFound, currentOutput, depth + 1, nextAncestors)
          if (foundNode !== undefined) return foundNode
        }
      } else {
        if (outputIndex >= correctTx.outputs.length) {
          throw new Error('Requested GASP output index does not exist')
        }
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
      return undefined
    }

    const separator = graphID.lastIndexOf('.')
    const rootTxid = graphID.slice(0, separator)
    const rootOutputIndex = Number(graphID.slice(separator + 1))
    const output = await this.storage.findOutput(rootTxid, rootOutputIndex, topic, undefined, true)
    const node = await hydrator(
      output,
      { txid: rootTxid, outputIndex: rootOutputIndex },
      0,
      new Set<string>()
    )
    if (node === undefined) throw new Error('Unable to find output associated with your request!')
    return node
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
    historySelector?:
      ((beef: number[], outputIndex: number, currentDepth: number) => Promise<boolean>) | number,
    currentDepth = 0,
    context: UTXOHistoryHydrationContext = this.createUTXOHistoryHydrationContext()
  ): Promise<Output | undefined> {
    assertNonnegativeInteger(currentDepth, 'Lookup history current depth')
    if (currentDepth > MAX_LOOKUP_HISTORY_DEPTH) {
      throw new RangeError('Lookup history current depth is too large')
    }
    if (
      historySelector !== undefined &&
      typeof historySelector !== 'function' &&
      (!Number.isSafeInteger(historySelector) ||
        historySelector < -1 ||
        historySelector > MAX_LOOKUP_HISTORY_DEPTH)
    ) {
      throw new TypeError(
        `Lookup history must be -1 through ${MAX_LOOKUP_HISTORY_DEPTH}, or a function`
      )
    }
    // If we have an output but no history selector, just return the output.
    if (historySelector === undefined) {
      return output
    }

    try {
      if (output.beef === undefined) {
        throw new Error('Output must have associated transaction BEEF!')
      }

      const hydratedNode = await this.hydrateUTXOHistoryNode(
        output,
        historySelector,
        currentDepth,
        context
      )
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
      const queue: Output[] = [output]
      const processed = new Set<string>()
      let relationCount = 0
      for (let cursor = 0; cursor < queue.length; cursor++) {
        if (queue.length > MAX_HISTORY_PRUNE_OUTPUTS) {
          throw new RangeError('Historical output pruning exceeded its work budget')
        }
        const current = queue[cursor]
        this.assertStoredOutputRelations(current, 'Historical output')
        const currentKey = `${current.txid.toLowerCase()}.${current.outputIndex}.${current.topic}`
        if (processed.has(currentKey)) continue
        processed.add(currentKey)

        // A retained descendant still depends on this output and therefore on
        // its ancestors. Do not prune through a node that remains referenced.
        if (current.consumedBy.length !== 0) continue

        await this.storage.deleteOutput(current.txid, current.outputIndex, current.topic)
        for (const lookupService of Object.values(this.lookupServices)) {
          try {
            await lookupService.outputNoLongerRetainedInHistory?.(
              current.txid,
              current.outputIndex,
              current.topic
            )
          } catch (error) {
            this.logger.debug(
              `outputNoLongerRetainedInHistory notification failed for ${current.txid}.${current.outputIndex}: ${error}`
            )
          }
        }

        for (const outputIdentifier of current.outputsConsumed) {
          relationCount++
          if (relationCount > MAX_OUTPUT_RELATIONS) {
            throw new RangeError('Historical output pruning exceeded its relation budget')
          }
          const staleOutput = await this.storage.findOutput(
            outputIdentifier.txid,
            outputIdentifier.outputIndex,
            current.topic
          )
          if (staleOutput === null || staleOutput === undefined) continue
          this.assertStoredOutputRelations(staleOutput, 'Historical ancestor output')
          if (
            staleOutput.txid.toLowerCase() !== outputIdentifier.txid.toLowerCase() ||
            staleOutput.outputIndex !== outputIdentifier.outputIndex ||
            staleOutput.topic !== current.topic
          ) {
            throw new TypeError('Storage returned an unbound historical ancestor output')
          }

          const remainingReferences = staleOutput.consumedBy.filter(
            reference =>
              reference.txid.toLowerCase() !== current.txid.toLowerCase() ||
              reference.outputIndex !== current.outputIndex
          )
          // If the current output was not a recorded consumer, it has no
          // authority to prune this ancestor or any of its dependencies.
          if (remainingReferences.length === staleOutput.consumedBy.length) continue
          await this.storage.updateConsumedBy(
            staleOutput.txid,
            staleOutput.outputIndex,
            staleOutput.topic,
            remainingReferences
          )
          staleOutput.consumedBy = remainingReferences
          if (remainingReferences.length === 0) queue.push(staleOutput)
        }
      }
    } catch (error) {
      throw new Error('Failed to delete all stale outputs', { cause: error })
    }
  }

  private assertStoredOutputRelations(value: unknown, label: string): asserts value is Output {
    if (typeof value !== 'object' || value === null) throw new TypeError(`${label} is invalid`)
    const candidate = value as Record<string, unknown>
    assertHash(candidate.txid, `${label} txid`)
    assertOutputIndex(candidate.outputIndex, `${label} output index`)
    assertTopic(candidate.topic, `${label} topic`)
    if (
      !Array.isArray(candidate.outputScript) ||
      candidate.outputScript.length > MAX_STORED_OUTPUT_SCRIPT_BYTES ||
      candidate.outputScript.some(
        (byte: unknown) => !Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255
      ) ||
      !Number.isSafeInteger(candidate.satoshis) ||
      (candidate.satoshis as number) < 0 ||
      typeof candidate.spent !== 'boolean'
    ) {
      throw new TypeError(`${label} has invalid output data`)
    }
    if (candidate.blockHeight !== undefined) {
      assertNonnegativeInteger(candidate.blockHeight, `${label} block height`)
    }
    if (candidate.score !== undefined) {
      assertNonnegativeInteger(candidate.score, `${label} score`)
    }
    if (
      !Array.isArray(candidate.consumedBy) ||
      candidate.consumedBy.length > MAX_OUTPUT_RELATIONS ||
      !Array.isArray(candidate.outputsConsumed) ||
      candidate.outputsConsumed.length > MAX_OUTPUT_RELATIONS
    ) {
      throw new TypeError(`${label} has invalid or oversized relations`)
    }
    for (const [relationType, relations] of [
      ['consumedBy', candidate.consumedBy],
      ['outputsConsumed', candidate.outputsConsumed]
    ] as const) {
      const seen = new Set<string>()
      for (const [index, relation] of relations.entries()) {
        if (typeof relation !== 'object' || relation === null) {
          throw new TypeError(`${label} ${relationType}[${index}] is invalid`)
        }
        assertHash(relation.txid, `${label} ${relationType}[${index}] txid`)
        assertOutputIndex(relation.outputIndex, `${label} ${relationType}[${index}] output index`)
        const key = `${relation.txid.toLowerCase()}.${relation.outputIndex}`
        if (seen.has(key)) throw new TypeError(`${label} has duplicate ${relationType} relations`)
        seen.add(key)
      }
    }
  }

  private assertStoredOutputMatches(
    value: unknown,
    expected: { txid: string; outputIndex: number; topic: string },
    label: string
  ): asserts value is Output {
    this.assertStoredOutputRelations(value, label)
    if (
      value.txid.toLowerCase() !== expected.txid.toLowerCase() ||
      value.outputIndex !== expected.outputIndex ||
      value.topic !== expected.topic
    ) {
      throw new TypeError(`${label} does not match the requested outpoint and topic`)
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
  private updateInputProofs(tx: Transaction, txid: string, proof: MerklePath): boolean {
    const pending: Transaction[] = [tx]
    const visited = new WeakSet<object>()
    let found = false
    for (let cursor = 0; cursor < pending.length; cursor++) {
      if (pending.length > MAX_PROOF_UPDATE_OUTPUTS) {
        throw new RangeError('Merkle-proof source traversal exceeded its work budget')
      }
      const current = pending[cursor]
      if (visited.has(current)) continue
      visited.add(current)
      if (current.id('hex') === txid) {
        current.merklePath = proof
        found = true
        continue
      }
      // A mined transaction's source graph is no longer part of its BEEF. Do
      // not replace an unrelated transaction's proof with an ancestor proof.
      if (current.merklePath !== undefined) continue
      for (const input of current.inputs) {
        if (typeof input.sourceTransaction === 'object') {
          if (pending.length >= MAX_PROOF_UPDATE_OUTPUTS) {
            throw new RangeError('Merkle-proof source traversal exceeded its work budget')
          }
          pending.push(input.sourceTransaction)
        }
      }
    }
    return found
  }

  private prepareMerkleProofUpdate(output: Output, txid: string, proof: MerklePath): number[] {
    this.assertStoredOutputRelations(output, 'Merkle-proof output')
    if (
      !Array.isArray(output.beef) ||
      output.beef.length === 0 ||
      output.beef.length > MAX_SUBMISSION_BEEF_BYTES ||
      output.beef.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) {
      throw new TypeError('Merkle-proof output must have bounded transaction BEEF')
    }
    const tx = Transaction.fromBEEF(output.beef)
    if (tx.id('hex').toLowerCase() !== output.txid.toLowerCase()) {
      throw new TypeError('Stored Merkle-proof output BEEF does not match its transaction ID')
    }
    if (output.outputIndex >= tx.outputs.length) {
      throw new TypeError('Stored Merkle-proof output index is outside its transaction')
    }
    if (!this.updateInputProofs(tx, txid, proof)) {
      throw new TypeError('Stored descendant BEEF does not contain the proven transaction')
    }
    return tx.toBEEF()
  }

  private async collectMerkleProofOutputs(initialOutputs: Output[]): Promise<Output[]> {
    if (initialOutputs.length > MAX_PROOF_UPDATE_OUTPUTS) {
      throw new RangeError('Merkle-proof output set exceeded its work budget')
    }
    const pending = [...initialOutputs]
    const collected: Output[] = []
    const seenOutputs = new Set<string>()
    const fetchedTransactions = new Set<string>()
    let totalBeefBytes = 0
    for (let cursor = 0; cursor < pending.length; cursor++) {
      if (pending.length > MAX_PROOF_UPDATE_OUTPUTS) {
        throw new RangeError('Merkle-proof descendant traversal exceeded its work budget')
      }
      const output = pending[cursor]
      this.assertStoredOutputRelations(output, 'Merkle-proof output')
      const key = `${output.txid.toLowerCase()}.${output.outputIndex}.${output.topic}`
      if (seenOutputs.has(key)) continue
      seenOutputs.add(key)
      if (!Array.isArray(output.beef)) {
        throw new TypeError('Merkle-proof graph output is missing transaction BEEF')
      }
      totalBeefBytes += output.beef.length
      if (totalBeefBytes > MAX_LOOKUP_TOTAL_BEEF_BYTES) {
        throw new RangeError('Merkle-proof graph BEEF exceeded its total byte budget')
      }
      collected.push(output)

      for (const relation of output.consumedBy) {
        const transactionKey = relation.txid.toLowerCase()
        if (fetchedTransactions.has(transactionKey)) continue
        fetchedTransactions.add(transactionKey)
        const remaining = MAX_PROOF_UPDATE_OUTPUTS - pending.length
        const descendants = await this.storage.findOutputsForTransaction(
          relation.txid,
          true,
          remaining + 1
        )
        if (!Array.isArray(descendants) || descendants.length > remaining) {
          throw new TypeError('Storage returned an invalid or oversized proof descendant set')
        }
        for (const descendant of descendants) {
          this.assertStoredOutputRelations(descendant, 'Merkle-proof descendant output')
          if (descendant.txid.toLowerCase() !== transactionKey) {
            throw new TypeError('Storage returned an unbound Merkle-proof descendant output')
          }
          pending.push(descendant)
        }
      }
    }
    return collected
  }

  /**
   * Recursively prune UTXOs when an incoming Merkle Proof is received.
   *
   * @param txid - Transaction ID of the associated outputs to prune.
   * @param proof - Merkle proof containing the Merkle path and other relevant data to verify the transaction.
   * @param blockHeight - The block height associated with the incoming merkle proof.
   */
  async handleNewMerkleProof(txid: string, proof: MerklePath, blockHeight?: number): Promise<void> {
    assertHash(txid, 'Merkle proof transaction ID')
    if (this.chainTracker === 'scripts only') {
      throw new Error('Merkle proof ingestion requires a ChainTracker')
    }
    if (blockHeight !== undefined) {
      assertNonnegativeInteger(blockHeight, 'Merkle proof block height')
      if (blockHeight !== proof.blockHeight) {
        throw new Error('Merkle proof block height does not match the supplied proof')
      }
    }
    const proofMetadata = extractMerkleProofMetadata(txid, proof)
    if (proofMetadata === undefined) {
      throw new Error('Merkle proof does not contain the claimed transaction')
    }
    if (!(await proof.verify(txid, this.chainTracker))) {
      throw new Error('Merkle proof is not valid for the claimed block height')
    }

    const outputs = await this.storage.findOutputsForTransaction(
      txid,
      true,
      MAX_PROOF_UPDATE_OUTPUTS + 1
    )

    if (
      !Array.isArray(outputs) ||
      outputs.length === 0 ||
      outputs.length > MAX_PROOF_UPDATE_OUTPUTS
    ) {
      throw new Error('Could not find matching transaction outputs for proof ingest!')
    }
    for (const output of outputs) {
      this.assertStoredOutputRelations(output, 'Merkle-proof root output')
      if (output.txid.toLowerCase() !== txid.toLowerCase()) {
        throw new TypeError('Storage returned an unbound Merkle-proof root output')
      }
    }

    const graphOutputs = await this.collectMerkleProofOutputs(outputs)
    const preparedUpdates = graphOutputs.map(output => ({
      output,
      beef: this.prepareMerkleProofUpdate(output, txid, proof)
    }))
    for (const update of preparedUpdates) {
      await this.storage.updateTransactionBEEF(update.output.txid, update.beef)
      update.output.beef = update.beef
    }

    const resolvedBlockHeight = blockHeight ?? proofMetadata?.blockHeight
    const resolvedBlockHash =
      resolvedBlockHeight === undefined
        ? undefined
        : await this.resolveBlockHash(resolvedBlockHeight, proofMetadata?.merkleRoot)

    for (const output of outputs) {
      // Add the associated blockHeight
      if (resolvedBlockHeight !== undefined) {
        output.blockHeight = resolvedBlockHeight
        await this.storage.updateOutputBlockHeight?.(
          output.txid,
          output.outputIndex,
          output.topic,
          resolvedBlockHeight
        )
      }

      if (output.beef !== undefined) {
        const tx = Transaction.fromBEEF(output.beef)
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
  async listTopicManagers(): Promise<
    Record<
      string,
      {
        name: string
        shortDescription: string
        iconURL?: string
        version?: string
        informationURL?: string
      }
    >
  > {
    const result: Record<
      string,
      {
        name: string
        shortDescription: string
        iconURL?: string
        version?: string
        informationURL?: string
      }
    > = Object.create(null) as Record<
      string,
      {
        name: string
        shortDescription: string
        iconURL?: string
        version?: string
        informationURL?: string
      }
    >
    for (const t of Object.keys(this.managers)) {
      try {
        result[t] = validateComponentMetadata(await this.managers[t].getMetaData())
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
  async listLookupServiceProviders(): Promise<
    Record<
      string,
      {
        name: string
        shortDescription: string
        iconURL?: string
        version?: string
        informationURL?: string
      }
    >
  > {
    const result: Record<
      string,
      {
        name: string
        shortDescription: string
        iconURL?: string
        version?: string
        informationURL?: string
      }
    > = Object.create(null) as Record<
      string,
      {
        name: string
        shortDescription: string
        iconURL?: string
        version?: string
        informationURL?: string
      }
    >
    for (const ls of Object.keys(this.lookupServices)) {
      try {
        result[ls] = validateComponentMetadata(await this.lookupServices[ls].getMetaData())
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
    const service =
      typeof manager === 'string' && Object.prototype.hasOwnProperty.call(this.managers, manager)
        ? this.managers[manager]
        : undefined
    const documentation = await service?.getDocumentation?.()
    return documentation === undefined
      ? 'No documentation found!'
      : validateComponentDocumentation(documentation)
  }

  /**
   * Run a query to get the documentation for a particular lookup service
   * @public
   * @returns {Promise<string>} -  the documentation for the lookup service
   */
  async getDocumentationForLookupServiceProvider(provider: any): Promise<string> {
    const service =
      typeof provider === 'string' &&
      Object.prototype.hasOwnProperty.call(this.lookupServices, provider)
        ? this.lookupServices[provider]
        : undefined
    const documentation = await service?.getDocumentation?.()
    return documentation === undefined
      ? 'No documentation found!'
      : validateComponentDocumentation(documentation)
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
      const parsedUrl = new URL(normalizePeerEndpoint(url))

      // Disallow localhost with or without a port
      if (/^localhost(:\d+)?$/i.test(parsedUrl.hostname)) {
        return false
      }

      // Disallow internal and non-routable IP addresses
      const ipAddress = parsedUrl.hostname
      const literal = /^[\d.]+$/.test(ipAddress) || ipAddress.includes(':')
      if (literal && !isPublicNetworkAddress(ipAddress)) return false

      // Regex for non-routable IPv4 IPs
      const nonRoutableIpv4Patterns = [
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // Loopback IPs
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // 10.x.x.x private IPs
        /^192\.168\.\d{1,3}\.\d{1,3}$/, // 192.168.x.x private IPs
        /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/, // 172.16.x.x to 172.31.x.x private IPs
        /^0\.0\.0\.0$/ // Non-routable address
      ]

      // Check for IPv4 matches
      if (nonRoutableIpv4Patterns.some(pattern => pattern.test(ipAddress))) {
        return false
      }

      // Check for non-routable IPv6 addresses explicitly
      if (ipAddress === '[::1]') {
        return false
      }

      // If none of the disallowed conditions matched, the URL is valid
      return true
    } catch {
      // URL constructor throws on malformed input — not a valid URL, return false
      return false
    }
  }
}
