import type { IdentityRegistryStore, RegistryEntry } from '../../core/types'
import { createIdentityRegistryHandler, IdentityRegistry } from '../identity-registry'

const KEY_A = '020000000000000000000000000000000000000000000000000000000000000001'
const KEY_B = '030000000000000000000000000000000000000000000000000000000000000002'

class MemoryRegistryStore implements IdentityRegistryStore {
  constructor(public entries: RegistryEntry[] = []) {}

  load(): RegistryEntry[] {
    return this.entries
  }

  save(entries: RegistryEntry[]): void {
    this.entries = entries
  }
}

function entry(tag: string, identityKey = KEY_A): RegistryEntry {
  return { tag, identityKey, createdAt: '2026-09-17T00:00:00.000Z' }
}

describe('IdentityRegistry security boundaries', () => {
  it('ignores inherited store, policy, and work-limit configuration', () => {
    const ambientStore = new MemoryRegistryStore()
    const ambientValidator = jest.fn(() => 'ambient rejection')
    Object.defineProperties(Object.prototype, {
      store: { value: ambientStore, configurable: true, writable: true },
      validateTag: { value: ambientValidator, configurable: true, writable: true },
      maxTagsPerIdentity: { value: 1, configurable: true, writable: true },
      maxEntries: { value: 1, configurable: true, writable: true },
      maxLookupResults: { value: 1, configurable: true, writable: true }
    })
    try {
      const registry = new IdentityRegistry({}) as unknown as {
        store: IdentityRegistryStore
        validateTag?: unknown
        maxTagsPerIdentity: number
        maxEntries: number
        maxLookupResults: number
      }
      expect(registry.store).not.toBe(ambientStore)
      expect(registry.validateTag).toBeUndefined()
      expect(registry.maxTagsPerIdentity).toBe(32)
      expect(registry.maxEntries).toBe(10_000)
      expect(registry.maxLookupResults).toBe(100)
      expect(ambientValidator).not.toHaveBeenCalled()
    } finally {
      for (const property of [
        'store',
        'validateTag',
        'maxTagsPerIdentity',
        'maxEntries',
        'maxLookupResults'
      ]) {
        Reflect.deleteProperty(Object.prototype, property)
      }
    }
  })

  it('validates configured work limits', () => {
    expect(() => new IdentityRegistry({ maxTagsPerIdentity: Number.POSITIVE_INFINITY })).toThrow(
      'maxTagsPerIdentity must be a safe integer'
    )
    expect(() => new IdentityRegistry({ maxEntries: 0 })).toThrow(
      'maxEntries must be a safe integer'
    )
    expect(() => new IdentityRegistry({ maxLookupResults: 1.5 })).toThrow(
      'maxLookupResults must be a safe integer'
    )
  })

  it('normalizes compressed keys and enforces tag, identity, and capacity bounds', () => {
    const store = new MemoryRegistryStore()
    const registry = new IdentityRegistry({
      store,
      maxTagsPerIdentity: 1,
      maxEntries: 2
    })

    expect(registry.register(' Alice ', KEY_A.toUpperCase())).toMatchObject({
      success: true,
      tag: 'Alice'
    })
    expect(store.entries[0]).toMatchObject({ tag: 'Alice', identityKey: KEY_A })
    expect(registry.register('second', KEY_A)).toMatchObject({ success: false })
    expect(registry.register('Bob', KEY_B)).toMatchObject({ success: true })
    expect(
      registry.register(
        'third',
        '020000000000000000000000000000000000000000000000000000000000000003'
      )
    ).toMatchObject({ success: false, error: 'Registry capacity reached' })

    expect(() => registry.register('bad\nname', KEY_A)).toThrow('control-free')
    expect(() => registry.register('bad-key', 'not-a-key')).toThrow('compressed public key')
  })

  it('caps lookup results and rejects malformed or ambiguous persisted state', () => {
    const registry = new IdentityRegistry({
      store: new MemoryRegistryStore([entry('alice'), entry('alicia', KEY_B)]),
      maxLookupResults: 1
    })
    expect(registry.lookup('ali')).toEqual([{ tag: 'alice', identityKey: KEY_A }])

    const duplicate = new IdentityRegistry({
      store: new MemoryRegistryStore([entry('Alice'), entry('alice', KEY_B)])
    })
    expect(() => duplicate.lookup('alice')).toThrow('duplicate tag')

    const malformed = new IdentityRegistry({
      store: new MemoryRegistryStore([entry('alice', 'not-a-key')])
    })
    expect(() => malformed.list(KEY_A)).toThrow('compressed public key')
  })

  it('fails closed at the handler for malformed requests without reflecting internals', async () => {
    const handler = createIdentityRegistryHandler({ store: new MemoryRegistryStore() })
    const malformed = await handler.POST?.(
      new Request('https://registry.example/?action=register', {
        method: 'POST',
        body: JSON.stringify({ tag: 'alice', identityKey: 'not-a-key' })
      })
    )
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toEqual({
      success: false,
      error: 'Registry request failed'
    })

    const unknown = await handler.POST?.(
      new Request('https://registry.example/?action=erase', {
        method: 'POST',
        body: JSON.stringify({ tag: 'alice', identityKey: KEY_A })
      })
    )
    expect(unknown.status).toBe(400)
    await expect(unknown.json()).resolves.toEqual({ success: false, error: 'Unknown action' })
  })
})
