import {
  DEFAULT_SLAP_TRACKERS,
  DEFAULT_TESTNET_SLAP_TRACKERS,
  DEFAULT_TTN_SLAP_TRACKERS,
  LookupResolver,
  OverlayAdminTokenTemplate,
  PushDrop,
  Transaction,
  Utils,
  type LookupAnswer,
  type LookupNetworkPreset,
  type LookupQuestion
} from '@bsv/sdk'

import { DEFAULTS, isPublicKeyHex } from '../protocol/query.js'

export interface DiscoveredHost {
  url: string
  /**
   * Every identity key a SLAP token advertised for this URL, without duplicates. SLAP is
   * permissionless, so anyone may advertise anyone's URL: when the list is present, the BRC-103
   * session key must be one of its entries, and no single token can bind the URL to a wrong key.
   */
  identityKeys?: string[]
}

/** One advertisement, before advertisements for the same URL are merged. */
interface Advertisement {
  url: string
  identityKey?: string
}

/** Satisfied by the SDK `LookupResolver`; injectable for tests. */
export interface LookupResolverLike {
  query: (question: LookupQuestion, timeout?: number) => Promise<LookupAnswer>
}

/** Network options carry the same names and meaning as `LookupResolverConfig`. */
export interface DiscoveryOptions {
  networkPreset?: LookupNetworkPreset
  slapTrackers?: string[]
  /** Per market key, hosts used in place of discovery. */
  hostOverrides?: Record<string, string[]>
  /** Per market key, hosts used in addition to discovery. */
  additionalHosts?: Record<string, string[]>
  resolver?: LookupResolverLike
  hostsTtlMs?: number
  now?: () => number
}

export type DiscoveryTarget =
  | { kind: 'overlay-lookup'; service: string }
  | { kind: 'message-list'; recipient: string }
  | { kind: 'static'; key: string }

/** The market key is the lookup service name for `overlay-lookup`, else the class name. */
export function discoveryTarget(
  type: string,
  params: Record<string, unknown>,
  client: string
): DiscoveryTarget {
  if (type === 'overlay-lookup') {
    if (typeof params.service !== 'string' || params.service.length === 0) {
      throw new TypeError('overlay-lookup needs params.service')
    }
    return { kind: 'overlay-lookup', service: params.service }
  }
  if (type === 'message-list') {
    return {
      kind: 'message-list',
      recipient: typeof params.recipient === 'string' ? params.recipient : client
    }
  }
  return { kind: 'static', key: type }
}

/** The key `hostOverrides`/`additionalHosts` are looked up under: the service name for
 * `overlay-lookup`, else the class name (per the brief, shared across every recipient). */
function marketKey(target: DiscoveryTarget): string {
  if (target.kind === 'overlay-lookup') return target.service
  return target.kind === 'message-list' ? 'message-list' : target.key
}

/** The key the TTL cache is stored under. Unlike `marketKey`, `message-list` targets are keyed
 * per recipient so that resolving message boxes for two identities never mixes their hosts. */
function cacheKey(target: DiscoveryTarget): string {
  return target.kind === 'message-list' ? `message-list:${target.recipient}` : marketKey(target)
}

function defaultTrackers(preset: LookupNetworkPreset): string[] {
  if (preset === 'local') return ['http://localhost:8080']
  if (preset === 'testnet') return DEFAULT_TESTNET_SLAP_TRACKERS
  if (preset === 'teratestnet') return DEFAULT_TTN_SLAP_TRACKERS
  return DEFAULT_SLAP_TRACKERS
}

/**
 * Bootstraps from SLAP trackers, as `LookupResolver` does. Discovery runs on the free BRC-24
 * `/lookup` route and makes no wallet call; the fee of the query that follows covers it.
 */
export class HostDiscovery {
  private readonly preset: LookupNetworkPreset
  private readonly trackers: string[]
  private readonly overrides: Record<string, string[]>
  private readonly additional: Record<string, string[]>
  private readonly resolver: LookupResolverLike
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, { hosts: DiscoveredHost[]; expiresAt: number }>()

  constructor(options: DiscoveryOptions = {}) {
    this.preset = options.networkPreset ?? 'mainnet'
    this.trackers = options.slapTrackers ?? defaultTrackers(this.preset)
    this.overrides = options.hostOverrides ?? {}
    this.additional = options.additionalHosts ?? {}
    this.resolver =
      options.resolver ??
      new LookupResolver({ networkPreset: this.preset, slapTrackers: this.trackers })
    this.ttlMs = options.hostsTtlMs ?? DEFAULTS.hostsTtlMs
    this.now = options.now ?? Date.now
  }

  async hostsFor(target: DiscoveryTarget): Promise<DiscoveredHost[]> {
    const key = cacheKey(target)
    const cached = this.cache.get(key)
    if (cached !== undefined && this.now() < cached.expiresAt) return cached.hosts
    const overrideKey = marketKey(target)
    const found = new Map<string, DiscoveredHost>()
    const add = (candidate: string, identityKey?: string): void => {
      const url = this.normalize(candidate)
      if (url === undefined) return
      let host = found.get(url)
      if (host === undefined) {
        host = { url }
        found.set(url, host)
      }
      if (isPublicKeyHex(identityKey) && host.identityKeys?.includes(identityKey) !== true) {
        host.identityKeys = [...(host.identityKeys ?? []), identityKey]
      }
    }
    const override = this.overrides[overrideKey]
    let failed = false
    if (override !== undefined) {
      for (const host of override) add(host)
    } else {
      const discovered = await this.discover(target)
      if (discovered === undefined) {
        failed = true
      } else {
        for (const host of discovered) add(host.url, host.identityKey)
      }
      for (const host of this.additional[overrideKey] ?? []) add(host)
    }
    const hosts = [...found.values()]
    // A resolver failure must not be cached: it would pin the client to this call's
    // (empty, or additionalHosts-only) result for the full TTL. A successful call, even one
    // whose answer names no hosts, is still cached.
    if (!failed) this.cache.set(key, { hosts, expiresAt: this.now() + this.ttlMs })
    return hosts
  }

  /** Returns `undefined` when the resolver itself failed (never cached), distinct from an
   * empty array, which is a successful answer that named no hosts (cached as usual). */
  private async discover(target: DiscoveryTarget): Promise<Advertisement[] | undefined> {
    if (target.kind === 'static') return []
    if (target.kind === 'overlay-lookup' && target.service === 'ls_slap') {
      return this.trackers.map(url => ({ url }))
    }
    const question: LookupQuestion =
      target.kind === 'overlay-lookup'
        ? { service: 'ls_slap', query: { service: target.service } }
        : { service: 'ls_messagebox', query: { identityKey: target.recipient } }
    let answer: LookupAnswer
    try {
      answer = await this.resolver.query(question)
    } catch {
      return undefined
    }
    if (answer.type !== 'output-list') return []
    const hosts: Advertisement[] = []
    for (const output of answer.outputs) {
      try {
        const transaction = Transaction.fromBEEF(output.beef)
        const script = transaction.outputs[output.outputIndex].lockingScript
        if (target.kind === 'overlay-lookup') {
          const token = OverlayAdminTokenTemplate.decode(script)
          if (token.protocol === 'SLAP' && token.topicOrService === target.service) {
            hosts.push({ url: token.domain, identityKey: token.identityKey })
          }
        } else {
          hosts.push({ url: Utils.toUTF8(PushDrop.decode(script).fields[1]) })
        }
      } catch {
        // An undecodable advertisement names no host.
      }
    }
    return hosts
  }

  private normalize(candidate: string): string | undefined {
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:' || (url.protocol === 'http:' && this.preset === 'local')) {
        return url.origin
      }
    } catch {
      // Not a URL.
    }
    return undefined
  }
}
