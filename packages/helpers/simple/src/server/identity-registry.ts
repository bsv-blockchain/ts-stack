/**
 * Identity Registry — tag/handle registration for MessageBox and identity lookup.
 *
 * Core class (IdentityRegistry) is framework-agnostic.
 * createIdentityRegistryHandler() returns Next.js App Router compatible { GET, POST }.
 */

import { join } from 'node:path'
import {
  IdentityRegistryConfig,
  IdentityRegistryStore,
  RegistryEntry
} from '../core/types'
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

  constructor (filePath?: string) {
    this.store = new JsonFileStore<RegistryEntry[]>(
      filePath ?? join(process.cwd(), '.identity-registry.json')
    )
  }

  load (): RegistryEntry[] {
    return this.store.load() ?? []
  }

  save (entries: RegistryEntry[]): void {
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

  constructor (config?: IdentityRegistryConfig) {
    this.store = config?.store ?? new FileIdentityRegistryStore()
    this.validateTag = config?.validateTag
    this.maxTagsPerIdentity = config?.maxTagsPerIdentity ?? Infinity
  }

  lookup (query: string): Array<{ tag: string, identityKey: string }> {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    const entries = this.store.load()
    return entries
      .filter(e => e.tag.toLowerCase().includes(q))
      .map(e => ({ tag: e.tag, identityKey: e.identityKey }))
  }

  list (identityKey: string): Array<{ tag: string, createdAt: string }> {
    const entries = this.store.load()
    return entries
      .filter(e => e.identityKey === identityKey)
      .map(e => ({ tag: e.tag, createdAt: e.createdAt }))
  }

  register (tag: string, identityKey: string): RegistryResult {
    const normalizedTag = tag.trim()
    if (normalizedTag === '') {
      return { success: false, message: 'Tag cannot be empty', tag: normalizedTag, error: 'Tag cannot be empty' }
    }

    // Custom validation
    if (this.validateTag != null) {
      const err = this.validateTag(normalizedTag, identityKey)
      if (err != null) {
        return { success: false, message: err, tag: normalizedTag, error: err }
      }
    }

    const entries = this.store.load()

    // Check tag ownership
    const existing = entries.find(e => e.tag.toLowerCase() === normalizedTag.toLowerCase())
    if ((existing != null) && existing.identityKey !== identityKey) {
      return { success: false, message: `Tag "${normalizedTag}" is already registered to another identity`, tag: normalizedTag, error: `Tag "${normalizedTag}" is already registered to another identity` }
    }
    if ((existing != null) && existing.identityKey === identityKey) {
      return { success: true, message: 'Tag already registered', tag: normalizedTag }
    }

    // Check max tags
    if (this.maxTagsPerIdentity !== Infinity) {
      const count = entries.filter(e => e.identityKey === identityKey).length
      if (count >= this.maxTagsPerIdentity) {
        return { success: false, message: `Maximum ${this.maxTagsPerIdentity} tags per identity`, tag: normalizedTag, error: `Maximum ${this.maxTagsPerIdentity} tags per identity` }
      }
    }

    entries.push({ tag: normalizedTag, identityKey, createdAt: new Date().toISOString() })
    this.store.save(entries)
    return { success: true, message: 'Tag registered', tag: normalizedTag }
  }

  revoke (tag: string, identityKey: string): RegistryResult {
    const normalizedTag = tag.trim()
    const entries = this.store.load()
    const idx = entries.findIndex(
      e => e.tag.toLowerCase() === normalizedTag.toLowerCase() && e.identityKey === identityKey
    )
    if (idx === -1) {
      return { success: false, message: 'Tag not found or does not belong to this identity', tag: normalizedTag, error: 'Tag not found or does not belong to this identity' }
    }
    entries.splice(idx, 1)
    this.store.save(entries)
    return { success: true, message: 'Tag revoked', tag: normalizedTag }
  }
}

// ============================================================================
// Next.js handler factory
// ============================================================================

export function createIdentityRegistryHandler (config?: IdentityRegistryConfig): ReturnType<typeof toNextHandlers> {
  const registry = new IdentityRegistry(config)

  const coreHandlers = {
    async GET (req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const action = params.get('action')

      try {
        if (action === 'lookup') {
          const query = (params.get('query') ?? '').trim()
          if (query === '') return jsonResponse({ success: false, error: 'Missing query parameter' }, 400)
          const results = registry.lookup(query)
          return jsonResponse({ success: true, query, results })
        }
        if (action === 'list') {
          const identityKey = params.get('identityKey')
          if (identityKey == null || identityKey === '') return jsonResponse({ success: false, error: 'Missing identityKey parameter' }, 400)
          const tags = registry.list(identityKey)
          return jsonResponse({ success: true, tags })
        }
        return jsonResponse({ success: false, error: `Unknown action: ${String(action)}` }, 400)
      } catch (error) {
        return jsonResponse({ success: false, error: `${String(action)} failed: ${(error as Error).message}` }, 500)
      }
    },

    async POST (req: HandlerRequest): Promise<HandlerResponse> {
      const params = getSearchParams(req.url)
      const action = params.get('action')

      try {
        const body = await req.json()
        const { tag, identityKey } = body as { tag?: string, identityKey?: string }
        if ((tag == null || tag === '') || (identityKey == null || identityKey === '')) {
          return jsonResponse({ success: false, error: 'Missing required fields: tag, identityKey' }, 400)
        }

        if (action === 'register') {
          const result = registry.register(tag, identityKey)
          return jsonResponse(
            (result.error != null) ? { success: false, error: result.error } : { success: true, message: result.message, tag: result.tag },
            result.success ? 200 : 409
          )
        }
        if (action === 'revoke') {
          const result = registry.revoke(tag, identityKey)
          return jsonResponse(
            (result.error != null) ? { success: false, error: result.error } : { success: true, message: result.message, tag: result.tag },
            result.success ? 200 : 404
          )
        }
        return jsonResponse({ success: false, error: `Unknown action: ${String(action)}` }, 400)
      } catch (error) {
        return jsonResponse({ success: false, error: `${String(action)} failed: ${(error as Error).message}` }, 500)
      }
    }
  }

  return toNextHandlers(coreHandlers)
}
