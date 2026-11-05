/**
 * The owner against the three defects `host-lifecycle.test.ts` reproduces.
 *
 * Each test here is the counterfactual of one there: same scenario, right
 * answer. If a change makes one of these pass for the wrong reason, the
 * matching characterisation in that file is the control.
 */
import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { GroupMessagingClient } from '../../src/client.js'
import { InProcessTransportHub } from '../../src/transport/backends/in-process.js'
import { ClientOwner, type ClientKey, type ClientRecipe } from '../client-lifecycle.js'

const hub = () => new InProcessTransportHub()

/** Tracks every acquire and release, so a leak is visible rather than implied. */
const resources = () => {
  const log: string[] = []
  let serial = 0
  return {
    log,
    get outstanding() {
      return (
        log.filter(entry => entry.startsWith('acquire')).length -
        log.filter(entry => entry.startsWith('release')).length
      )
    },
    acquire: async () => {
      const id = `r${++serial}`
      log.push(`acquire ${id}`)
      return id
    },
    release: async (id: string) => {
      log.push(`release ${id}`)
    }
  }
}

const recipeFor =
  (
    transport: InProcessTransportHub,
    keys: Map<string, PrivateKey>,
    pool: ReturnType<typeof resources>
  ) =>
  (key: ClientKey): ClientRecipe<string> => ({
    acquire: pool.acquire,
    release: pool.release,
    create: async () => {
      const secret = keys.get(key.identityKey)
      if (secret === undefined) throw new Error(`no wallet for ${key.identityKey}`)
      return GroupMessagingClient.create({
        wallet: secret,
        storage: new Map(),
        transport: transport.endpoint(key.identityKey)
      })
    }
  })

const twoIdentities = () => {
  const alice = PrivateKey.fromRandom()
  const bob = PrivateKey.fromRandom()
  const keys = new Map([
    [new KeyDeriver(alice).identityKey, alice],
    [new KeyDeriver(bob).identityKey, bob]
  ])
  return {
    keys,
    aliceKey: new KeyDeriver(alice).identityKey,
    bobKey: new KeyDeriver(bob).identityKey
  }
}

describe('ClientOwner', () => {
  it("gives each identity its own client, and never one identity another's", async () => {
    const { keys, aliceKey, bobKey } = twoIdentities()
    const pool = resources()
    const owner = new ClientOwner(recipeFor(hub(), keys, pool))

    const alice = await owner.get({ identityKey: aliceKey })
    const minted = await alice.keyPackages.create()
    await alice.createGroup({
      chatId: 'alices-chat',
      members: [],
      privateKeyPackage: minted.privateKeyPackage
    })

    const bob = await owner.get({ identityKey: bobKey })

    expect(bob).not.toBe(alice)
    expect(bob.identityKey).toBe(bobKey)
    expect(await bob.listGroups()).toEqual([])

    await owner.close()
  })

  it('returns the same client while the key is unchanged', async () => {
    const { keys, aliceKey } = twoIdentities()
    const pool = resources()
    const owner = new ClientOwner(recipeFor(hub(), keys, pool))

    const first = await owner.get({ identityKey: aliceKey })
    const second = await owner.get({ identityKey: aliceKey })

    expect(second).toBe(first)
    expect(pool.log.filter(e => e.startsWith('acquire'))).toHaveLength(1)

    await owner.close()
  })

  it('treats any other dimension as part of the key', async () => {
    const { keys, aliceKey } = twoIdentities()
    const pool = resources()
    const owner = new ClientOwner(recipeFor(hub(), keys, pool))

    const first = await owner.get({ identityKey: aliceKey, host: 'https://one.example' })
    const second = await owner.get({ identityKey: aliceKey, host: 'https://two.example' })

    expect(second).not.toBe(first)
    await owner.close()
  })

  it("does not care what order the key's properties are written in", async () => {
    const { keys, aliceKey } = twoIdentities()
    const owner = new ClientOwner(recipeFor(hub(), keys, resources()))

    const first = await owner.get({ identityKey: aliceKey, chain: 'main', host: 'h' })
    const second = await owner.get({ host: 'h', chain: 'main', identityKey: aliceKey })

    expect(second).toBe(first)
    await owner.close()
  })

  it('does not confuse two keys that would collide when joined', async () => {
    // `relay=a` + `zone=b` versus a relay URL that happens to contain
    // `&zone=b`. A separator-joined key makes those one key, which is the
    // original defect one dimension over from the identity it does guard.
    const { keys, aliceKey } = twoIdentities()
    const pool = resources()
    const owner = new ClientOwner(recipeFor(hub(), keys, pool))

    const first = await owner.get({ identityKey: aliceKey, relay: 'a', zone: 'b' })
    const second = await owner.get({ identityKey: aliceKey, relay: 'a&zone=b' })

    expect(second).not.toBe(first)
    await owner.close()
  })

  it('treats an absent dimension and an empty one as different keys', async () => {
    const { keys, aliceKey } = twoIdentities()
    const owner = new ClientOwner(recipeFor(hub(), keys, resources()))

    const first = await owner.get({ identityKey: aliceKey, relay: 'x' })
    const second = await owner.get({ identityKey: aliceKey, relay: '' })

    expect(second).not.toBe(first)
    await owner.close()
  })

  it('releases with the recipe that acquired, not a freshly derived one', async () => {
    // The recipe varies by `host`, not only by identity — which is the case
    // the stored reference protects. Re-deriving from the held client's
    // identity alone loses that dimension and releases through the wrong
    // closure, so the resource is never freed.
    const { keys, aliceKey } = twoIdentities()
    const released: string[] = []
    const inner = recipeFor(hub(), keys, resources())
    const owner = new ClientOwner<string>(key => {
      const recipe = inner(key)
      const host = key.host ?? 'none'
      return {
        acquire: async () => `${host}-resource`,
        release: async resource => {
          released.push(`${host} released ${resource}`)
        },
        create: recipe.create
      }
    })

    await owner.get({ identityKey: aliceKey, host: 'first' })
    await owner.get({ identityKey: aliceKey, host: 'second' })

    expect(released).toEqual(['first released first-resource'])
    await owner.close()
    expect(released).toEqual(['first released first-resource', 'second released second-resource'])
  })

  it('releases what it acquired when create throws', async () => {
    const { keys, aliceKey } = twoIdentities()
    const pool = resources()
    const owner = new ClientOwner<string>(() => ({
      acquire: pool.acquire,
      release: pool.release,
      create: async () => {
        throw new Error('database is locked')
      }
    }))

    await expect(owner.get({ identityKey: aliceKey })).rejects.toThrow(/locked/)

    expect(pool.outstanding).toBe(0)
    expect(pool.log).toEqual(['acquire r1', 'release r1'])
    void keys
  })

  it('stays usable after a failed open', async () => {
    const { keys, aliceKey } = twoIdentities()
    const pool = resources()
    let fail = true
    const inner = recipeFor(hub(), keys, pool)
    const owner = new ClientOwner<string>(key => {
      const recipe = inner(key)
      return {
        ...recipe,
        create: async resource => {
          if (fail) throw new Error('database is locked')
          return recipe.create(resource)
        }
      }
    })

    await expect(owner.get({ identityKey: aliceKey })).rejects.toThrow(/locked/)
    fail = false
    const client = await owner.get({ identityKey: aliceKey })

    expect(client.identityKey).toBe(aliceKey)
    await owner.close()
  })

  it('closes the old client before the new one is created', async () => {
    const { keys, aliceKey, bobKey } = twoIdentities()
    const order: string[] = []
    const inner = recipeFor(hub(), keys, resources())
    const owner = new ClientOwner<string>(key => {
      const recipe = inner(key)
      return {
        acquire: recipe.acquire,
        release: async resource => {
          order.push(`release ${key.identityKey.slice(0, 6)}`)
          return recipe.release(resource)
        },
        create: async resource => {
          order.push(`create ${key.identityKey.slice(0, 6)}`)
          return recipe.create(resource)
        }
      }
    })

    await owner.get({ identityKey: aliceKey })
    await owner.get({ identityKey: bobKey })

    // The old release must land before the new create, or the two clients
    // overlap on one identity's storage — invariant 8.
    expect(order).toEqual([
      `create ${aliceKey.slice(0, 6)}`,
      `release ${aliceKey.slice(0, 6)}`,
      `create ${bobKey.slice(0, 6)}`
    ])

    await owner.close()
  })

  it('opens once when two callers ask at the same time', async () => {
    const { keys, aliceKey } = twoIdentities()
    const pool = resources()
    const owner = new ClientOwner(recipeFor(hub(), keys, pool))

    const [first, second] = await Promise.all([
      owner.get({ identityKey: aliceKey }),
      owner.get({ identityKey: aliceKey })
    ])

    expect(second).toBe(first)
    expect(pool.log.filter(e => e.startsWith('acquire'))).toHaveLength(1)

    await owner.close()
  })

  it('serialises two callers asking for different identities', async () => {
    const { keys, aliceKey, bobKey } = twoIdentities()
    const pool = resources()
    const owner = new ClientOwner(recipeFor(hub(), keys, pool))

    const [alice, bob] = await Promise.all([
      owner.get({ identityKey: aliceKey }),
      owner.get({ identityKey: bobKey })
    ])

    // Whoever won, exactly one survives and nothing leaked.
    expect(alice.identityKey).toBe(aliceKey)
    expect(bob.identityKey).toBe(bobKey)
    expect(owner.identityKey).toBe(bobKey)
    expect(pool.outstanding).toBe(1)

    await owner.close()
    expect(pool.outstanding).toBe(0)
  })

  it('releases on close and is idempotent', async () => {
    const { keys, aliceKey } = twoIdentities()
    const pool = resources()
    const owner = new ClientOwner(recipeFor(hub(), keys, pool))

    await owner.get({ identityKey: aliceKey })
    await owner.close()
    await owner.close()

    expect(pool.outstanding).toBe(0)
    expect(owner.identityKey).toBeUndefined()
  })

  it('releases the resource even when the client close throws', async () => {
    const { keys, aliceKey } = twoIdentities()
    const pool = resources()
    const inner = recipeFor(hub(), keys, pool)
    const owner = new ClientOwner<string>(key => {
      const recipe = inner(key)
      return {
        ...recipe,
        create: async resource => {
          const client = await recipe.create(resource)
          client.close = async () => {
            throw new Error('transport already gone')
          }
          return client
        }
      }
    })

    await owner.get({ identityKey: aliceKey })
    await expect(owner.close()).rejects.toThrow(/already gone/)

    // The handle is still released, and the owner is not wedged.
    expect(pool.outstanding).toBe(0)
    expect(owner.identityKey).toBeUndefined()
    const next = await owner.get({ identityKey: aliceKey })
    expect(next.identityKey).toBe(aliceKey)
  })
})
