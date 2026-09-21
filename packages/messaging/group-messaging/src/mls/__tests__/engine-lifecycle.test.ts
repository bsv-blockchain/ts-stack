import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { GroupMessagingError } from '../../errors.js'
import { IdentityService } from '../../identity/index.js'
import { DEFAULT_CIPHERSUITE, type MlsCiphersuiteName } from '../../types.js'
import { MlsEngine } from '../engine.js'

const OTHER_CIPHERSUITE: MlsCiphersuiteName = 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'

const newEngine = async (ciphersuite: MlsCiphersuiteName = DEFAULT_CIPHERSUITE) =>
  new MlsEngine({
    identity: await IdentityService.open(new KeyDeriver(PrivateKey.fromRandom())),
    ciphersuite
  })

describe('MlsEngine group lifecycle', () => {
  it('creates a group at epoch 0 with one member', async () => {
    const alice = await newEngine()
    const minted = await alice.createKeyPackage()

    const { mlsGroupId, state } = await alice.createGroup({
      keyPackage: minted.keyPackage,
      privateKeyPackage: minted.privateKeyPackage
    })

    expect(mlsGroupId).toMatch(/^[0-9a-f]+$/)
    const info = await alice.info(state)
    expect(info.epoch).toBe(0n)
    expect(info.members.map(member => member.identityKey)).toEqual([alice.identity.identityKey])
  })

  it('adds a member, and both sides land on the same epoch and roster', async () => {
    const alice = await newEngine()
    const bob = await newEngine()

    const aliceKp = await alice.createKeyPackage()
    const bobKp = await bob.createKeyPackage()

    const created = await alice.createGroup({
      keyPackage: aliceKp.keyPackage,
      privateKeyPackage: aliceKp.privateKeyPackage
    })
    const added = await alice.addMembers({
      state: created.state,
      keyPackages: [bobKp.keyPackage]
    })

    const joined = await bob.joinFromWelcome({
      welcome: added.welcome,
      keyPackage: bobKp.keyPackage,
      privateKeyPackage: bobKp.privateKeyPackage
    })

    const aliceInfo = await alice.info(added.state)
    const bobInfo = await bob.info(joined.state)

    expect(joined.mlsGroupId).toBe(created.mlsGroupId)
    expect(bobInfo.epoch).toBe(aliceInfo.epoch)
    expect(aliceInfo.epoch).toBe(1n)
    expect(new Set(bobInfo.members.map(m => m.identityKey))).toEqual(
      new Set([alice.identity.identityKey, bob.identity.identityKey])
    )
  })

  it("reports each member's BRC-43 key ID alongside their identity", async () => {
    const alice = await newEngine()
    const minted = await alice.createKeyPackage()
    const { state } = await alice.createGroup({
      keyPackage: minted.keyPackage,
      privateKeyPackage: minted.privateKeyPackage
    })

    expect((await alice.info(state)).members[0]!.keyId).toBe(minted.keyId)
  })

  it('refuses a Welcome the private KeyPackage does not match', async () => {
    const alice = await newEngine()
    const bob = await newEngine()

    const aliceKp = await alice.createKeyPackage()
    const bobKp = await bob.createKeyPackage()
    const otherKp = await bob.createKeyPackage()

    const created = await alice.createGroup({
      keyPackage: aliceKp.keyPackage,
      privateKeyPackage: aliceKp.privateKeyPackage
    })
    const added = await alice.addMembers({ state: created.state, keyPackages: [bobKp.keyPackage] })

    await expect(
      bob.joinFromWelcome({
        welcome: added.welcome,
        keyPackage: otherKp.keyPackage,
        privateKeyPackage: otherKp.privateKeyPackage
      })
    ).rejects.toThrow()
  })

  it('refuses a KeyPackage minted for another ciphersuite', async () => {
    const alice = await newEngine()
    const minted = await alice.createKeyPackage({ ciphersuite: OTHER_CIPHERSUITE })

    await expect(
      alice.createGroup({
        keyPackage: minted.keyPackage,
        privateKeyPackage: minted.privateKeyPackage
      })
    ).rejects.toThrow(GroupMessagingError)
  })

  it('refuses to add a member whose KeyPackage is for another ciphersuite', async () => {
    const alice = await newEngine()
    const bob = await newEngine(OTHER_CIPHERSUITE)

    const aliceKp = await alice.createKeyPackage()
    const bobKp = await bob.createKeyPackage()
    const created = await alice.createGroup({
      keyPackage: aliceKp.keyPackage,
      privateKeyPackage: aliceKp.privateKeyPackage
    })

    await expect(
      alice.addMembers({ state: created.state, keyPackages: [bobKp.keyPackage] })
    ).rejects.toThrow(GroupMessagingError)
  })

  it('refuses a Welcome for a ciphersuite this client does not use', async () => {
    const alice = await newEngine(OTHER_CIPHERSUITE)
    const bob = await newEngine(OTHER_CIPHERSUITE)
    const stranger = await newEngine()

    const aliceKp = await alice.createKeyPackage()
    const bobKp = await bob.createKeyPackage()
    const strangerKp = await stranger.createKeyPackage()

    const created = await alice.createGroup({
      keyPackage: aliceKp.keyPackage,
      privateKeyPackage: aliceKp.privateKeyPackage
    })
    const added = await alice.addMembers({ state: created.state, keyPackages: [bobKp.keyPackage] })

    await expect(
      stranger.joinFromWelcome({
        welcome: added.welcome,
        keyPackage: strangerKp.keyPackage,
        privateKeyPackage: strangerKp.privateKeyPackage
      })
    ).rejects.toThrow(GroupMessagingError)
  })
})
