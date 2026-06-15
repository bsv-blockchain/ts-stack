import { Beef } from '../transaction/Beef.js'
import { PubKeyHex, WalletProtocol } from '../wallet/Wallet.interfaces.js'
import { WalletInterface } from '../wallet/index.js'
// Type-only import — erased at runtime, so it introduces no module cycle with overlay-tools.
import type { LookupResolver } from '../overlay-tools/index.js'

/**
 * Configuration interface for GlobalKVStore operations.
 * Defines all options for connecting to overlay services and managing KVStore behavior.
 */
export interface KVStoreConfig {
  /** The overlay service host URL */
  overlayHost?: string
  /** Protocol ID for the KVStore protocol */
  protocolID?: WalletProtocol
  /** Service name for overlay submission */
  serviceName?: string
  /** Amount of satoshis for each token */
  tokenAmount?: number
  /** Topics for overlay submission */
  topics?: string[]
  /** Originator */
  originator?: string
  /** Wallet interface for operations */
  wallet?: WalletInterface
  /** Network preset for overlay services */
  networkPreset?: 'mainnet' | 'testnet' | 'local'
  /**
   * A pre-built lookup resolver to use for all overlay queries — both reads and
   * write-host (SHIP) discovery. When provided, it takes precedence and
   * `hostOverrides` / `slapTrackers` are ignored for resolver construction.
   * Use this to fully control overlay host resolution.
   */
  lookupResolver?: LookupResolver
  /**
   * Per-service overlay host overrides (`serviceName -> hosts`), applied when
   * the store builds its default lookup resolver. This pins which hosts answer
   * *lookup* queries for a given service (e.g. read lookups via `ls_kvstore`),
   * instead of discovering them via SLAP.
   *
   * Note this does not by itself pin the *broadcast* target: writes are
   * submitted to the hosts that the `ls_ship` SHIP lookup returns, so an
   * `ls_ship` override only changes which tracker answers — the broadcast host
   * is whatever advertisements that lookup names. To force writes to a specific
   * backend, use a resolver / SHIP setup whose `ls_ship` results return the
   * desired host. Ignored when `lookupResolver` is supplied.
   */
  hostOverrides?: Record<string, string[]>
  /**
   * Override the SLAP trackers used by the default lookup resolver. Ignored when
   * `lookupResolver` is supplied.
   */
  slapTrackers?: string[]
  /** Whether to accept delayed broadcast */
  acceptDelayedBroadcast?: boolean
  /** Whether to let overlay handle broadcasting (prevents UTXO spending on rejection) */
  overlayBroadcast?: boolean
  /** Description for token set */
  tokenSetDescription?: string
  /** Description for token update */
  tokenUpdateDescription?: string
  /** Description for token removal */
  tokenRemovalDescription?: string
}

/**
 * Query parameters for KVStore lookups from overlay services.
 * Must include at least one selector: key, controller, protocolID, or non-empty tags.
 * Pagination and ordering fields only refine selector-based lookups.
 */
export interface KVStoreQuery {
  key?: string
  controller?: PubKeyHex
  protocolID?: WalletProtocol
  tags?: string[]
  /**
   * Controls tag matching behavior when tags are specified.
   * - 'all': Requires all specified tags to be present (default)
   * - 'any': Requires at least one of the specified tags to be present
   */
  tagQueryMode?: 'all' | 'any'
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
}

/**
 * Options for configuring KVStore get operations (local processing)
 */
export interface KVStoreGetOptions {
  /** Whether to build and include history for each entry */
  history?: boolean
  /** Whether to include token transaction data in results */
  includeToken?: boolean
  /** Service name for overlay retrieval */
  serviceName?: string
}

export interface KVStoreSetOptions {
  protocolID?: WalletProtocol
  tokenSetDescription?: string
  tokenUpdateDescription?: string
  tokenAmount?: number
  tags?: string[]
}

export interface KVStoreRemoveOptions {
  protocolID?: WalletProtocol
  tokenRemovalDescription?: string
}

/**
 * KVStore entry returned from queries
 */
export interface KVStoreEntry {
  key: string
  value: string
  controller: PubKeyHex
  protocolID: WalletProtocol
  tags?: string[]
  token?: KVStoreToken
  history?: string[]
}

/**
 * Result structure for KVStore lookups from overlay services.
 * Contains the transaction output information for a found key-value pair.
 */
export interface KVStoreLookupResult {
  txid: string
  outputIndex: number
  outputScript: string
  satoshis: number
  history?: (output: any, currentDepth: number) => Promise<boolean>
}

/**
 * Token structure containing a KVStore token from overlay services.
 * Wraps the transaction data and metadata for a key-value pair.
 */
export interface KVStoreToken {
  txid: string
  outputIndex: number
  satoshis: number
  beef: Beef
}

export const kvProtocol = {
  protocolID: 0,
  key: 1,
  value: 2,
  controller: 3,
  tags: 4,
  signature: 5 // Note: signature moves to position 5 when tags are present
}
