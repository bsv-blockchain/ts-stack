/**
 * Identity Registry — legacy unauthenticated tag/handle directory for
 * MessageBox and identity lookup.
 *
 * Core class (IdentityRegistry) is framework-agnostic.
 * createIdentityRegistryHandler() returns Next.js App Router compatible { GET, POST }.
 *
 * SECURITY: The current wire contract carries only a public identity key. It
 * contains no signature, nonce, or challenge proving control of that key, so
 * this registry MUST NOT be treated as an authenticated identity assertion or
 * used by itself to select a payment recipient. Exposing the handler publicly
 * also permits third parties to register or revoke entries as another key.
 * Deploy it only behind an application authorization layer until a versioned
 * proof-of-key-control protocol replaces the legacy request format.
 */

import { join } from 'node:path'
import { snapshotPlainDataRecord } from '../core/certificate-validation'
import { IdentityRegistryConfig, IdentityRegistryStore, RegistryEntry } from '../core/types'
import {
  boundedPositiveSafeInteger,
  normalizeRegistryIdentityKey,
  normalizeRegistryQuery,
  normalizeRegistryTag,
  remoteRegistryError,
  validateRegistryEntries
} from '../core/identity-registry-validation'
import { JsonFileStore } from './json-file-store'
import {
  HandlerRequest,
  HandlerResponse,
  getSearchParams,
  jsonResponse,
  toNextHandlers
} from './handler-types'

// ============================================================================
// Default file-based store
// ============================================================================

class FileIdentityRegistryStore implements IdentityRegistryStore {
  private readonly store: JsonFileStore<RegistryEntry[]>

  constructor(filePath?: string) {
    this.store = new JsonFileStore<RegistryEntry[]>(
      filePath ?? join(process.cwd(), '.identity-registry.json')
    )
  }

  load(): RegistryEntry[] {
    return this.store.load() ?? []
  }

  save(entries: RegistryEntry[]): void {
    this.store.save(entries)
  }
}

// ============================================================================
// IdentityRegistry core class
// ============================================================================

export interface RegistryResult {
  success: boolean
  message: string
  tag: string
  error?: string
}

export class IdentityRegistry {
  private readonly store: IdentityRegistryStore
  private readonly validateTag?: (tag: string, identityKey: string) => string | null
  private readonly maxTagsPerIdentity: number
  private readonly maxEntries: number
  private readonly maxLookupResults: number

  constructor(config?: IdentityRegistryConfig) {
    const ownedConfig =
      config == null
        ? (Object.create(null) as Record<string, unknown>)
        : snapshotPlainDataRecord(config)
    if (ownedConfig == null) throw new TypeError('Invalid identity registry configuration')
    if (
      ownedConfig.store != null &&
      (typeof (ownedConfig.store as IdentityRegistryStore).load !== 'function' ||
        typeof (ownedConfig.store as IdentityRegistryStore).save !== 'function')
    ) {
      throw new TypeError('Invalid identity registry store')
    }
    if (ownedConfig.validateTag != null && typeof ownedConfig.validateTag !== 'function') {
      throw new TypeError('Invalid identity registry tag validator')
    }
    this.store =
      (ownedConfig.store as IdentityRegistryStore | undefined) ?? new FileIdentityRegistryStore()
    this.validateTag = ownedConfig.validateTag as IdentityRegistryConfig['validateTag']
    this.maxTagsPerIdentity = boundedPositiveSafeInteger(
      ownedConfig.maxTagsPerIdentity,
      32,
      256,
      'maxTagsPerIdentity'
    )
    this.maxEntries = boundedPositiveSafeInteger(
      ownedConfig.maxEntries,
      10_000,
      100_000,
      'maxEntries'
    )
    this.maxLookupResults = boundedPositiveSafeInteger(
      ownedConfig.maxLookupResults,
      100,
      1_000,
      'maxLookupResults'
    )
  }

  private loadEntries(): RegistryEntry[] {
    return validateRegistryEntries(this.store.load(), this.maxEntries)
  }

  lookup(query: string): Array<{ tag: string; identityKey: string }> {
    if (typeof query === 'string' && query.trim() === '') return []
    const q = normalizeRegistryQuery(query).toLowerCase()
    const entries = this.loadEntries()
    return entries
      .filter(e => e.tag.toLowerCase().includes(q))
      .slice(0, this.maxLookupResults)
      .map(e => ({ tag: e.tag, identityKey: e.identityKey }))
  }

  list(identityKey: string): Array<{ tag: string; createdAt: string }> {
    const normalizedIdentityKey = normalizeRegistryIdentityKey(identityKey)
    const entries = this.loadEntries()
    return entries
      .filter(e => e.identityKey === normalizedIdentityKey)
      .map(e => ({ tag: e.tag, createdAt: e.createdAt }))
  }

  register(tag: string, identityKey: string): RegistryResult {
    const normalizedTag = normalizeRegistryTag(tag)
    const normalizedIdentityKey = normalizeRegistryIdentityKey(identityKey)

    // Custom validation
    if (this.validateTag != null) {
      const err = this.validateTag(normalizedTag, normalizedIdentityKey)
      if (err != null) {
        const safeError = remoteRegistryError(err, 'Tag rejected by application policy')
        return { success: false, message: safeError, tag: normalizedTag, error: safeError }
      }
    }

    const entries = this.loadEntries()

    // Check tag ownership
    const existing = entries.find(e => e.tag.toLowerCase() === normalizedTag.toLowerCase())
    if (existing != null && existing.identityKey !== normalizedIdentityKey) {
      return {
        success: false,
        message: `Tag "${normalizedTag}" is already registered to another identity`,
        tag: normalizedTag,
        error: `Tag "${normalizedTag}" is already registered to another identity`
      }
    }
    if (existing?.identityKey === normalizedIdentityKey) {
      return { success: true, message: 'Tag already registered', tag: normalizedTag }
    }

    // Check max tags
    const count = entries.filter(e => e.identityKey === normalizedIdentityKey).length
    if (count >= this.maxTagsPerIdentity) {
      return {
        success: false,
        message: `Maximum ${this.maxTagsPerIdentity} tags per identity`,
        tag: normalizedTag,
        error: `Maximum ${this.maxTagsPerIdentity} tags per identity`
      }
    }
    if (entries.length >= this.maxEntries) {
      return {
        success: false,
        message: 'Registry capacity reached',
        tag: normalizedTag,
        error: 'Registry capacity reached'
      }
    }

    entries.push({
      tag: normalizedTag,
      identityKey: normalizedIdentityKey,
      createdAt: new Date().toISOString()
    })
    this.store.save(entries)
    return { success: true, message: 'Tag registered', tag: normalizedTag }
  }

  revoke(tag: string, identityKey: string): RegistryResult {
    const normalizedTag = normalizeRegistryTag(tag)
    const normalizedIdentityKey = normalizeRegistryIdentityKey(identityKey)
    const entries = this.loadEntries()
    const idx = entries.findIndex(
      e =>
        e.tag.toLowerCase() === normalizedTag.toLowerCase() &&
        e.identityKey === normalizedIdentityKey
    )
    if (idx === -1) {
      return {
        success: false,
        message: 'Tag not found or does not belong to this identity',
        tag: normalizedTag,
        error: 'Tag not found or does not belong to this identity'
      }
    }
    entries.splice(idx, 1)
    this.store.save(entries)
    return { success: true, message: 'Tag revoked', tag: normalizedTag }
  }
}

// ============================================================================
// Next.js handler factory
// ============================================================================

export function createIdentityRegistryHandler(
  config?: IdentityRegistryConfig
): ReturnType<typeof toNextHandlers> {
  const registry = new IdentityRegistry(config)

  const coreHandlers = {
    async GET(req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const action = params.get('action')

      try {
        if (action === 'lookup') {
          const query = params.get('query')
          if (query == null || query === '')
            return jsonResponse({ success: false, error: 'Missing query parameter' }, 400)
          const results = registry.lookup(query)
          return jsonResponse({ success: true, query, results })
        }
        if (action === 'list') {
          const identityKey = params.get('identityKey')
          if (identityKey == null || identityKey === '')
            return jsonResponse({ success: false, error: 'Missing identityKey parameter' }, 400)
          const tags = registry.list(identityKey)
          return jsonResponse({ success: true, tags })
        }
        return jsonResponse({ success: false, error: 'Unknown action' }, 400)
      } catch {
        return jsonResponse({ success: false, error: 'Registry request failed' }, 400)
      }
    },

    async POST(req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const action = params.get('action')

      try {
        if (action !== 'register' && action !== 'revoke') {
          return jsonResponse({ success: false, error: 'Unknown action' }, 400)
        }
        const body = snapshotPlainDataRecord(await req.json())
        if (body == null) {
          return jsonResponse({ success: false, error: 'Request body must be an object' }, 400)
        }
        const { tag, identityKey } = body
        if (typeof tag !== 'string' || typeof identityKey !== 'string') {
          return jsonResponse(
            { success: false, error: 'Missing required fields: tag, identityKey' },
            400
          )
        }

        if (action === 'register') {
          const result = registry.register(tag, identityKey)
          return jsonResponse(
            result.error == null
              ? { success: true, message: result.message, tag: result.tag }
              : { success: false, error: result.error },
            result.success ? 200 : 409
          )
        }
        const result = registry.revoke(tag, identityKey)
        return jsonResponse(
          result.error == null
            ? { success: true, message: result.message, tag: result.tag }
            : { success: false, error: result.error },
          result.success ? 200 : 404
        )
      } catch {
        return jsonResponse({ success: false, error: 'Registry request failed' }, 400)
      }
    }
  }

  return toNextHandlers(coreHandlers)
}
