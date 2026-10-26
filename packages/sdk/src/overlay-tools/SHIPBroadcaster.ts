import Transaction from '../transaction/Transaction.js'
import type {
  BroadcastResponse,
  BroadcastFailure,
  Broadcaster
} from '../transaction/Broadcaster.js'
import { Writer } from '../primitives/utils.js'
import LookupResolver, { type LookupNetworkPreset } from './LookupResolver.js'
import { decodeAndVerifyOverlayAdvertisement } from './OverlayAdminTokenTemplate.js'
import { isOverlayTopicName } from './OverlayNames.js'
import { createPublicNetworkFetch } from '../storage/PublicHTTPSFetch.js'
import { utf8ByteLength } from '../primitives/UTF8.js'

/**
 * Tagged BEEF
 *
 * @description
 * Tagged BEEF ([Background Evaluation Extended Format](https://brc.dev/62)) structure. Comprises a transaction, its SPV information, and the overlay topics where its inclusion is requested.
 */
export interface TaggedBEEF {
  beef: number[]
  topics: string[]
  offChainValues?: number[]
}

/**
 * Instructs the Overlay Services Engine about which outputs to admit and which previous outputs to retain. Returned by a Topic Manager.
 */
export interface AdmittanceInstructions {
  /**
   * The indices of all admissible outputs into the managed topic from the provided transaction.
   */
  outputsToAdmit: number[]

  /**
   * The indices of all inputs from the provided transaction which spend previously-admitted outputs that should be retained for historical record-keeping.
   */
  coinsToRetain: number[]

  /**
   * The indices of all inputs from the provided transaction which reference previously-admitted outputs,
   * which are now considered spent and have been removed from the managed topic.
   */
  coinsRemoved?: number[]
}

/**
 * Submitted Transaction Execution AcKnowledgment
 *
 * @description
 * Comprises the topics where a transaction was submitted, and for each one, the output indices for the UTXOs newly admitted into the topics, and the coins retained.
 * An object whose keys are topic names and whose values are topical admittance instructions denoting the state of the submitted transaction with respect to the associated topic.
 */
export type STEAK = Record<string, AdmittanceInstructions>

/** The require mode for topic acknowledgment: all topics must be present, or any one suffices. */
export type RequireMode = 'all' | 'any'

/** Specifies which topics must be acknowledged: all, any, or a specific list. */
export type TopicAcknowledgmentRequirement = RequireMode | string[]

/** Configuration options for the SHIP broadcaster. */
export interface SHIPBroadcasterConfig {
  /**
   * The network preset to use, unless other options override it.
   * - mainnet: use mainnet resolver and HTTPS facilitator
   * - testnet: use testnet resolver and HTTPS facilitator
   * - teratestnet: use TerraTestNet resolver and HTTPS facilitator
   * - local: directly send to localhost:8080 and a facilitator that permits plain HTTP
   */
  networkPreset?: LookupNetworkPreset
  /** The facilitator used to make requests to Overlay Services hosts. */
  facilitator?: OverlayBroadcastFacilitator
  /**
   * The resolver used to locate suitable hosts with SHIP. Advertisement
   * authorship is verified locally, but this resolver's trackers remain the
   * authority for whether a signed advertisement is current and unspent.
   */
  resolver?: LookupResolver
  /** Determines which topics (all, any, or a specific list) must be present within all STEAKs received from every host for the broadcast to be considered a success. By default, all hosts must acknowledge all topics. */
  requireAcknowledgmentFromAllHostsForTopics?: TopicAcknowledgmentRequirement
  /** Determines which topics (all, any, or a specific list) must be present within STEAK received from at least one host for the broadcast to be considered a success. */
  requireAcknowledgmentFromAnyHostForTopics?: TopicAcknowledgmentRequirement
  /** Determines a mapping whose keys are specific hosts and whose values are the topics (all, any, or a specific list) that must be present within the STEAK received by the given hosts, in order for the broadcast to be considered a success. */
  requireAcknowledgmentFromSpecificHostsForTopics?: Record<string, TopicAcknowledgmentRequirement>
}

/** Facilitates transaction broadcasts that return STEAK. */
export interface OverlayBroadcastFacilitator {
  send: (url: string, taggedBEEF: TaggedBEEF) => Promise<STEAK>
}

const MAX_SHIP_QUERY_TIMEOUT = 5000
const MAX_SHIP_RESPONSE_BYTES = 1024 * 1024
const MAX_SHIP_BODY_BYTES = 64 * 1024 * 1024
const MAX_SHIP_TOPICS = 64
const MAX_SHIP_INSTRUCTION_INDEXES = 4096
const MAX_SHIP_HOSTS = 32
const MAX_SHIP_ADVERTISEMENTS = 256
const MAX_SHIP_ADVERTISEMENT_BEEF_BYTES = 16 * 1024 * 1024
const MAX_SHIP_TOTAL_ADVERTISEMENT_BEEF_BYTES = 64 * 1024 * 1024
const SHIP_REQUEST_TIMEOUT_MS = 30_000

function shipEndpoint(base: string, allowHTTP: boolean): URL {
  const httpEnabled = allowHTTP === true
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new TypeError('Overlay host must be a valid absolute URL.')
  }
  if (
    (url.protocol !== 'https:' && !(httpEnabled && url.protocol === 'http:')) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(
      httpEnabled
        ? 'Overlay host must be a credential-free HTTP(S) origin.'
        : 'HTTPS facilitator can only use URLs that start with "https:" and contain a credential-free origin.'
    )
  }
  url.pathname = '/submit'
  return url
}

function isExactByteArray(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor == null ||
      !('value' in descriptor) ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      return false
    }
  }
  return true
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && descriptor != null && 'value' in descriptor
  })
}

function canonicalTopics(value: unknown, label: string, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_SHIP_TOPICS
  ) {
    throw new TypeError(`${label} must be a bounded array of canonical topic names.`)
  }
  const topics: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    const topic = descriptor != null && 'value' in descriptor ? descriptor.value : undefined
    if (typeof topic !== 'string' || !isOverlayTopicName(topic) || seen.has(topic)) {
      throw new TypeError(`${label} must contain unique canonical tm_ topic names.`)
    }
    seen.add(topic)
    topics.push(topic)
  }
  return topics
}

function snapshotAcknowledgmentRequirement(
  value: unknown,
  topics: string[],
  label: string
): TopicAcknowledgmentRequirement {
  if (value === 'all' || value === 'any') return value
  const required = canonicalTopics(value, label, true)
  if (required.some(topic => !topics.includes(topic))) {
    throw new TypeError(`${label} may only reference topics included in this broadcast.`)
  }
  return required
}

function snapshotSpecificHostRequirements(
  value: unknown,
  topics: string[],
  allowHTTP: boolean
): Record<string, TopicAcknowledgmentRequirement> {
  if (!isPlainRecord(value)) {
    throw new TypeError('Specific-host acknowledgment requirements must be a plain object.')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_SHIP_HOSTS) {
    throw new TypeError('Specific-host acknowledgment requirements contain too many hosts.')
  }
  const result: Record<string, TopicAcknowledgmentRequirement> = Object.create(null)
  for (const [host, requirement] of entries) {
    const canonicalHost = shipEndpoint(host, allowHTTP).origin
    if (Object.hasOwn(result, canonicalHost)) {
      throw new TypeError('Specific-host acknowledgment requirements contain a duplicate host.')
    }
    result[canonicalHost] = snapshotAcknowledgmentRequirement(
      requirement,
      topics,
      `Acknowledgment requirement for ${canonicalHost}`
    )
  }
  return result
}

function validateInstructionIndexes(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length > MAX_SHIP_INSTRUCTION_INDEXES) {
    throw new Error(`SHIP ${label} is invalid.`)
  }
  const seen = new Set<number>()
  const result: number[] = []
  for (let position = 0; position < value.length; position++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, position)
    const index = descriptor != null && 'value' in descriptor ? descriptor.value : undefined
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff || seen.has(index)) {
      throw new Error(`SHIP ${label} is invalid.`)
    }
    seen.add(index)
    result.push(index)
  }
  return result
}

function validateSTEAK(value: unknown, topics: string[]): STEAK {
  if (!isPlainRecord(value)) throw new Error('SHIP response is not a valid STEAK object.')
  const entries = Object.entries(value)
  if (entries.length > MAX_SHIP_TOPICS) throw new Error('SHIP response contains too many topics.')
  const allowedTopics = new Set(topics)
  const result: STEAK = Object.create(null)
  for (const [topic, rawInstructions] of entries) {
    if (!allowedTopics.has(topic) || !isPlainRecord(rawInstructions)) {
      throw new Error('SHIP response acknowledged an unexpected topic.')
    }
    const instructionKeys = Object.keys(rawInstructions)
    if (
      instructionKeys.some(
        key => !['outputsToAdmit', 'coinsToRetain', 'coinsRemoved'].includes(key)
      )
    ) {
      throw new Error('SHIP response contains unexpected instruction fields.')
    }
    result[topic] = {
      outputsToAdmit: validateInstructionIndexes(rawInstructions.outputsToAdmit, 'outputsToAdmit'),
      coinsToRetain: validateInstructionIndexes(rawInstructions.coinsToRetain, 'coinsToRetain'),
      ...(rawInstructions.coinsRemoved === undefined
        ? {}
        : {
            coinsRemoved: validateInstructionIndexes(rawInstructions.coinsRemoved, 'coinsRemoved')
          })
    }
  }
  return result
}

async function readSHIPJSON(response: Response): Promise<unknown> {
  const declared = response.headers?.get?.('content-length')
  if (
    declared != null &&
    (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_SHIP_RESPONSE_BYTES)
  ) {
    throw new Error('SHIP response exceeds the maximum permitted size.')
  }
  const reader = response.body?.getReader()
  if (reader == null) {
    const serialized = JSON.stringify(await response.json())
    if (serialized === undefined || utf8ByteLength(serialized) > MAX_SHIP_RESPONSE_BYTES) {
      throw new Error('SHIP response exceeds the maximum permitted size.')
    }
    // Return the measured plain-data snapshot rather than the adapter-owned
    // object, which may contain accessors or be mutated after validation.
    return JSON.parse(serialized)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_SHIP_RESPONSE_BYTES) {
        throw new Error('SHIP response exceeds the maximum permitted size.')
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    throw error
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('SHIP response is not valid UTF-8.')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('SHIP response is not valid JSON.')
  }
}

export class HTTPSOverlayBroadcastFacilitator implements OverlayBroadcastFacilitator {
  httpClient: typeof fetch
  allowHTTP: boolean

  constructor(httpClient?: typeof fetch, allowHTTP: boolean = false) {
    const httpEnabled = allowHTTP === true
    this.httpClient = httpClient ?? (httpEnabled ? fetch : createPublicNetworkFetch())
    this.allowHTTP = httpEnabled
  }

  async send(url: string, taggedBEEF: TaggedBEEF): Promise<STEAK> {
    const endpoint = shipEndpoint(url, this.allowHTTP)
    if (!isExactByteArray(taggedBEEF.beef) || taggedBEEF.beef.length === 0) {
      throw new TypeError('SHIP BEEF must be a non-empty byte array.')
    }
    const topics = canonicalTopics(taggedBEEF.topics, 'SHIP topics')
    if (taggedBEEF.offChainValues !== undefined && !isExactByteArray(taggedBEEF.offChainValues)) {
      throw new TypeError('SHIP off-chain values must be a byte array.')
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      // OpenAPI "simple" array encoding is comma-separated. Overlay Express
      // accepts this canonical form and the legacy JSON array during rollout.
      'X-Topics': topics.join(',')
    }
    let body
    if (Array.isArray(taggedBEEF.offChainValues)) {
      headers['x-includes-off-chain-values'] = 'true'
      const w = new Writer()
      w.writeVarIntNum(taggedBEEF.beef.length)
      w.write(taggedBEEF.beef)
      w.write(taggedBEEF.offChainValues)
      body = new Uint8Array(w.toArray())
    } else {
      body = new Uint8Array(taggedBEEF.beef)
    }
    if (body.byteLength > MAX_SHIP_BODY_BYTES) {
      throw new RangeError('SHIP request body exceeds the maximum permitted size.')
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const request = (async () => {
      const response = await this.httpClient(endpoint.toString(), {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        redirect: 'error'
      })
      if (!response.ok) throw new Error('Failed to facilitate broadcast')
      return await readSHIPJSON(response)
    })()
    request.catch(() => {})
    try {
      return (await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('SHIP request timed out.'))
          }, SHIP_REQUEST_TIMEOUT_MS)
        })
      ])) as STEAK
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * Broadcasts transactions to one or more overlay topics.
 */
export default class TopicBroadcaster implements Broadcaster {
  private readonly topics: string[]
  readonly #facilitator: OverlayBroadcastFacilitator
  readonly #resolver: LookupResolver
  readonly #requireAcknowledgmentFromAllHostsForTopics: TopicAcknowledgmentRequirement
  readonly #requireAcknowledgmentFromAnyHostForTopics: TopicAcknowledgmentRequirement
  readonly #requireAcknowledgmentFromSpecificHostsForTopics: Record<
    string,
    TopicAcknowledgmentRequirement
  >
  readonly #networkPreset: LookupNetworkPreset

  // Cache for findInterestedHosts to avoid repeated SHIP tracker lookups
  #interestedHostsCache: { hosts: Record<string, Set<string>>; expiresAt: number } | null = null
  #interestedHostsInFlight: Promise<Record<string, Set<string>>> | null = null
  readonly #interestedHostsTtlMs: number

  /**
   * Constructs an instance of the SHIP broadcaster.
   *
   * @param {string[]} topics - The list of SHIP topic names where transactions are to be sent.
   * @param {SHIPBroadcasterConfig} config - Configuration options for the SHIP broadcaster.
   */
  constructor(topics: string[], config: SHIPBroadcasterConfig = {}) {
    this.topics = canonicalTopics(topics, 'Broadcast topics')
    const networkPreset = config.networkPreset ?? 'mainnet'
    if (!['mainnet', 'testnet', 'teratestnet', 'local'].includes(networkPreset)) {
      throw new TypeError('SHIP network preset is invalid.')
    }
    this.#networkPreset = networkPreset
    const allowHTTP = this.#networkPreset === 'local'
    this.#facilitator =
      config.facilitator ?? new HTTPSOverlayBroadcastFacilitator(undefined, allowHTTP)
    this.#resolver = config.resolver ?? new LookupResolver({ networkPreset: this.#networkPreset })
    this.#requireAcknowledgmentFromAllHostsForTopics = snapshotAcknowledgmentRequirement(
      config.requireAcknowledgmentFromAllHostsForTopics ?? [],
      this.topics,
      'All-host acknowledgment requirement'
    )
    this.#requireAcknowledgmentFromAnyHostForTopics = snapshotAcknowledgmentRequirement(
      config.requireAcknowledgmentFromAnyHostForTopics ?? 'all',
      this.topics,
      'Any-host acknowledgment requirement'
    )
    this.#requireAcknowledgmentFromSpecificHostsForTopics = snapshotSpecificHostRequirements(
      config.requireAcknowledgmentFromSpecificHostsForTopics ?? {},
      this.topics,
      allowHTTP
    )
    this.#interestedHostsTtlMs = 5 * 60 * 1000 // 5 minutes
  }

  /**
   * Broadcasts a transaction to Overlay Services via SHIP.
   *
   * @param {Transaction} tx - The transaction to be sent.
   * @returns {Promise<BroadcastResponse | BroadcastFailure>} A promise that resolves to either a success or failure response.
   */
  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    let beef: number[]
    const rawOffChainValues =
      tx.metadata instanceof Map
        ? (tx.metadata.get('OffChainValues') as number[] | undefined)
        : (tx.metadata?.OffChainValues as number[] | undefined)
    if (rawOffChainValues !== undefined && !isExactByteArray(rawOffChainValues)) {
      throw new TypeError('Transaction off-chain values must be a dense byte array.')
    }
    const offChainValues = rawOffChainValues === undefined ? undefined : [...rawOffChainValues]
    try {
      beef = tx.toBEEF()
    } catch {
      throw new Error(
        'Transactions sent via SHIP to Overlay Services must be serializable to BEEF format.'
      )
    }
    const interestedHosts = await this.findInterestedHosts()
    if (Object.keys(interestedHosts).length === 0) {
      return {
        status: 'error',
        code: 'ERR_NO_HOSTS_INTERESTED',
        description: `No ${this.#networkPreset} hosts are interested in receiving this transaction.`
      }
    }
    const hostPromises = Object.entries(interestedHosts).map(async ([host, topics]) => {
      try {
        const steak = await this.#facilitator.send(host, {
          beef,
          offChainValues,
          topics: [...topics]
        })
        if (steak == null || Object.keys(steak).length === 0) {
          throw new Error('Steak has no topics.')
        }
        return {
          host,
          success: true,
          steak: validateSTEAK(steak, [...topics])
        }
      } catch (error) {
        return { host, success: false, error }
      }
    })

    const results = await Promise.all(hostPromises)
    const successfulHosts = results.filter(result => result.success)

    if (successfulHosts.length === 0) {
      return {
        status: 'error',
        code: 'ERR_ALL_HOSTS_REJECTED',
        description: `All ${this.#networkPreset} topical hosts have rejected the transaction.`
      }
    }

    // Collect host acknowledgments
    const hostAcknowledgments: Record<string, Set<string>> = Object.create(null)
    for (const host of Object.keys(interestedHosts)) hostAcknowledgments[host] = new Set()

    for (const result of successfulHosts) {
      const host = result.host
      const steak = result.steak as STEAK

      const acknowledgedTopics = new Set<string>()

      for (const [topic, instructions] of Object.entries(steak)) {
        const outputsToAdmit = instructions.outputsToAdmit
        const coinsToRetain = instructions.coinsToRetain
        const coinsRemoved = instructions.coinsRemoved

        if (
          (outputsToAdmit?.length ?? 0) > 0 ||
          (coinsToRetain?.length ?? 0) > 0 ||
          (coinsRemoved?.length ?? 0) > 0
        ) {
          acknowledgedTopics.add(topic)
        }
      }

      hostAcknowledgments[host] = acknowledgedTopics
    }

    // Now, perform the checks
    const allHostsError = this.checkAllHostsRequirement(hostAcknowledgments)
    if (allHostsError != null) return allHostsError

    const anyHostError = this.#checkAnyHostRequirement(hostAcknowledgments)
    if (anyHostError != null) return anyHostError

    const specificHostsError = this.checkSpecificHostsRequirement(hostAcknowledgments)
    if (specificHostsError != null) return specificHostsError

    // If all checks pass, return success
    return {
      status: 'success',
      txid: tx.id('hex'),
      message: `Sent to ${successfulHosts.length} Overlay Services ${successfulHosts.length === 1 ? 'host' : 'hosts'}.`
    }
  }

  /** Resolves the (requiredTopics, require) pair for requireAcknowledgmentFromAllHostsForTopics. */
  #resolveAllHostsRequirement(): { requiredTopics: string[]; require: RequireMode } {
    const r = this.#requireAcknowledgmentFromAllHostsForTopics
    if (r === 'any') return { requiredTopics: this.topics, require: 'any' }
    if (Array.isArray(r)) return { requiredTopics: r, require: 'all' }
    // Default 'all' or unknown: all topics, all requirement
    return { requiredTopics: this.topics, require: 'all' }
  }

  private checkAllHostsRequirement(
    hostAcknowledgments: Record<string, Set<string>>
  ): BroadcastFailure | null {
    const { requiredTopics, require } = this.#resolveAllHostsRequirement()
    if (requiredTopics.length === 0) return null
    if (!this.checkAcknowledgmentFromAllHosts(hostAcknowledgments, requiredTopics, require)) {
      return {
        status: 'error',
        code: 'ERR_REQUIRE_ACK_FROM_ALL_HOSTS_FAILED',
        description: 'Not all hosts acknowledged the required topics.'
      }
    }
    return null
  }

  /** Resolves the (requiredTopics, require) pair for requireAcknowledgmentFromAnyHostForTopics. */
  #resolveAnyHostRequirement(): { requiredTopics: string[]; require: RequireMode } {
    const r = this.#requireAcknowledgmentFromAnyHostForTopics
    if (r === 'all') return { requiredTopics: this.topics, require: 'all' }
    if (r === 'any') return { requiredTopics: this.topics, require: 'any' }
    if (Array.isArray(r)) return { requiredTopics: r, require: 'all' }
    return { requiredTopics: [], require: 'all' }
  }

  #checkAnyHostRequirement(
    hostAcknowledgments: Record<string, Set<string>>
  ): BroadcastFailure | null {
    const { requiredTopics, require } = this.#resolveAnyHostRequirement()
    if (requiredTopics.length === 0) return null
    if (!this.checkAcknowledgmentFromAnyHost(hostAcknowledgments, requiredTopics, require)) {
      return {
        status: 'error',
        code: 'ERR_REQUIRE_ACK_FROM_ANY_HOST_FAILED',
        description: 'No host acknowledged the required topics.'
      }
    }
    return null
  }

  private checkSpecificHostsRequirement(
    hostAcknowledgments: Record<string, Set<string>>
  ): BroadcastFailure | null {
    if (Object.keys(this.#requireAcknowledgmentFromSpecificHostsForTopics).length === 0) return null
    if (
      !this.checkAcknowledgmentFromSpecificHosts(
        hostAcknowledgments,
        this.#requireAcknowledgmentFromSpecificHostsForTopics
      )
    ) {
      return {
        status: 'error',
        code: 'ERR_REQUIRE_ACK_FROM_SPECIFIC_HOSTS_FAILED',
        description: 'Specific hosts did not acknowledge the required topics.'
      }
    }
    return null
  }

  /**
   * Returns true if `acknowledgedTopics` satisfies the given requirement against `requiredTopics`.
   */
  #topicsMatchRequirement(
    acknowledgedTopics: Set<string>,
    requiredTopics: string[],
    require: RequireMode
  ): boolean {
    if (require === 'all') {
      return requiredTopics.every(t => acknowledgedTopics.has(t))
    }
    return requiredTopics.some(t => acknowledgedTopics.has(t))
  }

  private checkAcknowledgmentFromAllHosts(
    hostAcknowledgments: Record<string, Set<string>>,
    requiredTopics: string[],
    require: RequireMode
  ): boolean {
    return Object.values(hostAcknowledgments).every(acknowledged =>
      this.#topicsMatchRequirement(acknowledged, requiredTopics, require)
    )
  }

  private checkAcknowledgmentFromAnyHost(
    hostAcknowledgments: Record<string, Set<string>>,
    requiredTopics: string[],
    require: RequireMode
  ): boolean {
    return Object.values(hostAcknowledgments).some(acknowledged =>
      this.#topicsMatchRequirement(acknowledged, requiredTopics, require)
    )
  }

  private checkAcknowledgmentFromSpecificHosts(
    hostAcknowledgments: Record<string, Set<string>>,
    requirements: Record<string, 'all' | 'any' | string[]>
  ): boolean {
    for (const [host, requiredTopicsOrAllAny] of Object.entries(requirements)) {
      const acknowledgedTopics = hostAcknowledgments[host]
      if (acknowledgedTopics == null) {
        // Host did not respond successfully
        return false
      }
      let requiredTopics: string[]
      let require: RequireMode
      if (requiredTopicsOrAllAny === 'all' || requiredTopicsOrAllAny === 'any') {
        require = requiredTopicsOrAllAny
        requiredTopics = this.topics
      } else if (Array.isArray(requiredTopicsOrAllAny)) {
        requiredTopics = requiredTopicsOrAllAny
        require = 'all'
      } else {
        // Invalid configuration
        continue
      }
      if (!this.#topicsMatchRequirement(acknowledgedTopics, requiredTopics, require)) {
        return false
      }
    }
    return true
  }

  /**
   * Finds which hosts are interested in transactions tagged with the given set of topics.
   *
   * @returns A mapping of URLs for hosts interested in this transaction. Keys are URLs, values are which of our topics the specific host cares about.
   */
  private async findInterestedHosts(): Promise<Record<string, Set<string>>> {
    // Handle the local network preset
    if (this.#networkPreset === 'local') {
      const resultSet = new Set<string>()
      for (const topic of this.topics) {
        resultSet.add(topic)
      }
      return { 'http://localhost:8080': resultSet }
    }

    // Return cached result if still valid
    const now = Date.now()
    if (this.#interestedHostsCache != null && this.#interestedHostsCache.expiresAt > now) {
      return this.#interestedHostsCache.hosts
    }

    // Deduplicate concurrent requests
    if (this.#interestedHostsInFlight != null) {
      return await this.#interestedHostsInFlight
    }

    this.#interestedHostsInFlight = this.#fetchInterestedHosts()
    try {
      const hosts = await this.#interestedHostsInFlight
      this.#interestedHostsCache = { hosts, expiresAt: Date.now() + this.#interestedHostsTtlMs }
      return hosts
    } finally {
      this.#interestedHostsInFlight = null
    }
  }

  /**
   * Performs the actual SHIP lookup to discover interested hosts.
   * @private
   */
  async #fetchInterestedHosts(): Promise<Record<string, Set<string>>> {
    // Find all SHIP advertisements for the topics we care about
    const results: Record<string, Set<string>> = Object.create(null)
    const answer = await this.#resolver.query(
      {
        service: 'ls_ship',
        query: {
          topics: this.topics
        }
      },
      MAX_SHIP_QUERY_TIMEOUT
    )
    if (
      !isPlainRecord(answer) ||
      answer.type !== 'output-list' ||
      !Array.isArray(answer.outputs) ||
      answer.outputs.length > MAX_SHIP_ADVERTISEMENTS
    ) {
      throw new Error('SHIP answer is not a bounded output list.')
    }
    let totalBeefBytes = 0
    for (let index = 0; index < answer.outputs.length; index++) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(answer.outputs, index)
        const output = descriptor != null && 'value' in descriptor ? descriptor.value : undefined
        if (!isPlainRecord(output)) continue
        const outputIndex = output.outputIndex
        if (
          !isExactByteArray(output.beef) ||
          output.beef.length === 0 ||
          output.beef.length > MAX_SHIP_ADVERTISEMENT_BEEF_BYTES ||
          typeof outputIndex !== 'number' ||
          !Number.isSafeInteger(outputIndex) ||
          outputIndex < 0 ||
          outputIndex > 0xffffffff ||
          (output.txid !== undefined &&
            (typeof output.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(output.txid)))
        ) {
          continue
        }
        totalBeefBytes += output.beef.length
        if (totalBeefBytes > MAX_SHIP_TOTAL_ADVERTISEMENT_BEEF_BYTES) {
          throw new Error('SHIP advertisement answer exceeds its total BEEF byte budget.')
        }
        const tx = Transaction.fromBEEF(output.beef)
        const txid = tx.id('hex')
        if (output.txid !== undefined && output.txid.toLowerCase() !== txid) continue
        const selectedOutput = tx.outputs[outputIndex]
        if (selectedOutput == null || selectedOutput.satoshis !== 1) continue
        const script = selectedOutput.lockingScript
        const parsed = await decodeAndVerifyOverlayAdvertisement(script, 'SHIP')
        if (!this.topics.includes(parsed.topicOrService)) {
          continue
        }
        const host = shipEndpoint(parsed.domain, false).origin
        results[host] ??= new Set()
        results[host].add(parsed.topicOrService)
        if (Object.keys(results).length >= MAX_SHIP_HOSTS) break
      } catch {
        // Output could not be decoded as an overlay admin token — not a SHIP advertisement; skip
        continue
      }
    }
    return results
  }
}
