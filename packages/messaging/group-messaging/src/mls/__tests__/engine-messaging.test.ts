import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { GroupMessagingError } from '../../errors.js'
import { IdentityService } from '../../identity/index.js'
import type { Member } from '../../types.js'
import { MlsEngine } from '../engine.js'

const newEngine = async () =>
  new MlsEngine({ identity: await IdentityService.open(new KeyDeriver(PrivateKey.fromRandom())) })

/** Alice and Bob in a two-member group at epoch 1. */
const pair = async () => {
  const alice = await newEngine()
  const bob = await newEngine()
  const aliceKp = await alice.createKeyPackage()
  const bobKp = await bob.createKeyPackage()

  const created = await alice.createGroup({
    keyPackage: aliceKp.keyPackage,
    privateKeyPackage: aliceKp.privateKeyPackage
  })
  const added = await alice.addMembers({ state: created.state, keyPackages: [bobKp.keyPackage] })
  const joined = await bob.joinFromWelcome({
    welcome: added.welcome,
    keyPackage: bobKp.keyPackage,
    privateKeyPackage: bobKp.privateKeyPackage
  })
  return { alice, bob, aliceState: added.state, bobState: joined.state }
}

/** Alice, Bob, Carol and Dave on leaves 0..3 of one group at epoch 1. */
const quartet = async () => {
  const alice = await newEngine()
  const bob = await newEngine()
  const carol = await newEngine()
  const dave = await newEngine()

  const aliceKp = await alice.createKeyPackage()
  const bobKp = await bob.createKeyPackage()
  const carolKp = await carol.createKeyPackage()
  const daveKp = await dave.createKeyPackage()

  const created = await alice.createGroup({
    keyPackage: aliceKp.keyPackage,
    privateKeyPackage: aliceKp.privateKeyPackage
  })
  const added = await alice.addMembers({
    state: created.state,
    keyPackages: [bobKp.keyPackage, carolKp.keyPackage, daveKp.keyPackage]
  })
  const bobJoined = await bob.joinFromWelcome({
    welcome: added.welcome,
    keyPackage: bobKp.keyPackage,
    privateKeyPackage: bobKp.privateKeyPackage
  })
  const carolJoined = await carol.joinFromWelcome({
    welcome: added.welcome,
    keyPackage: carolKp.keyPackage,
    privateKeyPackage: carolKp.privateKeyPackage
  })
  return {
    alice,
    bob,
    carol,
    dave,
    aliceState: added.state,
    bobState: bobJoined.state,
    carolState: carolJoined.state
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text)

const memberAt = (members: Member[], position: number): Member => {
  const member = members[position]
  if (member === undefined) throw new Error(`No member at position ${position}`)
  return member
}

describe('MlsEngine messaging', () => {
  it('encrypts a message Bob can decrypt', async () => {
    const { alice, bob, aliceState, bobState } = await pair()

    const sent = await alice.encrypt({ state: aliceState, plaintext: utf8('hello Bob') })
    const result = await bob.process({ state: bobState, message: sent.message })

    expect(result.kind).toBe('application')
    if (result.kind !== 'application') throw new Error('wrong kind')
    expect(new TextDecoder().decode(result.plaintext)).toBe('hello Bob')
    expect(result.sender).toBe(alice.identity.identityKey)
    expect(result.epoch).toBe(1n)
  })

  it('exposes the group and epoch of a message without decrypting it', async () => {
    const { alice, aliceState } = await pair()
    const sent = await alice.encrypt({ state: aliceState, plaintext: utf8('hi') })

    const framing = alice.epochOf(sent.message)

    expect(framing?.epoch).toBe(1n)
    expect(framing?.mlsGroupId).toBe((await alice.info(aliceState)).mlsGroupId)
  })

  it('reports framing for a handshake message and none for anything else', async () => {
    const { alice, aliceState } = await pair()
    const carol = await newEngine()
    const carolKp = await carol.createKeyPackage()
    const added = await alice.addMembers({ state: aliceState, keyPackages: [carolKp.keyPackage] })

    // Commits are framed as private messages too, so they can be queued by epoch.
    expect(alice.epochOf(added.commit)?.epoch).toBe(1n)
    // A Welcome is not an MLSMessage frame, and neither is noise.
    expect(alice.epochOf(added.welcome)).toBeUndefined()
    expect(alice.epochOf(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })

  it('reports nothing for a truncated frame instead of throwing', async () => {
    const { alice, aliceState } = await pair()
    const sent = await alice.encrypt({ state: aliceState, plaintext: utf8('hi') })

    // A frame cut off after its version and wire format is structurally
    // plausible, which is where the decoder throws rather than declining.
    for (let length = 0; length < sent.message.length; length++) {
      const truncated = sent.message.subarray(0, length)
      expect(() => alice.epochOf(truncated)).not.toThrow()
      expect(alice.epochOf(truncated)).toBeUndefined()
    }
  })

  it('rejects a truncated frame as a GroupMessagingError', async () => {
    const { alice, bob, aliceState, bobState } = await pair()
    const sent = await alice.encrypt({ state: aliceState, plaintext: utf8('hi') })

    await expect(
      bob.process({ state: bobState, message: sent.message.subarray(0, 8) })
    ).rejects.toThrow(GroupMessagingError)
  })

  it("advances Bob's epoch when he processes a Commit", async () => {
    const { alice, bob, aliceState, bobState } = await pair()
    const carol = await newEngine()
    const carolKp = await carol.createKeyPackage()

    const added = await alice.addMembers({ state: aliceState, keyPackages: [carolKp.keyPackage] })
    const result = await bob.process({ state: bobState, message: added.commit })

    expect(result.kind).toBe('commit')
    if (result.kind !== 'commit') throw new Error('wrong kind')
    expect((await bob.info(result.state)).epoch).toBe(2n)
    expect(result.added).toEqual([carol.identity.identityKey])
  })

  it('attributes a message to the right sender in a three-member group', async () => {
    const { alice, bob, aliceState, bobState } = await pair()
    const carol = await newEngine()
    const carolKp = await carol.createKeyPackage()

    const added = await alice.addMembers({ state: aliceState, keyPackages: [carolKp.keyPackage] })
    const carolJoined = await carol.joinFromWelcome({
      welcome: added.welcome,
      keyPackage: carolKp.keyPackage,
      privateKeyPackage: carolKp.privateKeyPackage
    })
    const bobAdvanced = await bob.process({ state: bobState, message: added.commit })
    if (bobAdvanced.kind !== 'commit') throw new Error('wrong kind')

    // Carol speaks; Bob must attribute it to Carol, not to Alice.
    const sent = await carol.encrypt({ state: carolJoined.state, plaintext: utf8('from Carol') })
    const heard = await bob.process({ state: bobAdvanced.state, message: sent.message })

    if (heard.kind !== 'application') throw new Error('wrong kind')
    expect(heard.sender).toBe(carol.identity.identityKey)
  })

  it('lets a member removed from the group no longer decrypt', async () => {
    const { alice, bob, aliceState, bobState } = await pair()

    const removed = await alice.removeMembers({
      state: aliceState,
      identityKeys: [bob.identity.identityKey]
    })
    const after = await alice.encrypt({ state: removed.state, plaintext: utf8('private now') })

    expect((await alice.info(removed.state)).members).toHaveLength(1)
    await expect(bob.process({ state: bobState, message: after.message })).rejects.toThrow()
  })

  it('refuses to remove an identity that is not a member', async () => {
    const { alice, aliceState } = await pair()
    const stranger = await newEngine()

    await expect(
      alice.removeMembers({ state: aliceState, identityKeys: [stranger.identity.identityKey] })
    ).rejects.toThrow(stranger.identity.identityKey)
  })

  it('rotates the leaf key on update without changing the roster', async () => {
    const { alice, aliceState } = await pair()

    const updated = await alice.update({ state: aliceState })

    const before = await alice.info(aliceState)
    const after = await alice.info(updated.state)
    expect(after.epoch).toBe(before.epoch + 1n)
    expect(after.members.map(m => m.identityKey).sort()).toEqual(
      before.members.map(m => m.identityKey).sort()
    )
  })

  /**
   * Blanking a leaf must not renumber the leaves after it.
   *
   * `getGroupMembers()` returns a filtered list, so a position in it stops
   * matching the true leaf index the moment any leaf is blank — and removals
   * are addressed by leaf index. The second removal is the part that matters:
   * it proves the reported index is the one actually committed, not merely a
   * number that happens to look right.
   */
  it('keeps leaf indices stable when a middle member is removed', async () => {
    const { alice, bob, carol, dave, aliceState, bobState } = await quartet()

    const before = (await alice.info(aliceState)).members
    expect(before.map(member => member.leafIndex)).toEqual([0, 1, 2, 3])
    const middle = memberAt(before, 2)
    const last = memberAt(before, 3)
    expect(middle.identityKey).toBe(carol.identity.identityKey)
    expect(last.identityKey).toBe(dave.identity.identityKey)

    const withoutMiddle = await alice.removeMembers({
      state: aliceState,
      identityKeys: [middle.identityKey]
    })

    // Leaf 2 is blank now; leaf 3 must still be leaf 3, not shuffled down to 2.
    const survivors = (await alice.info(withoutMiddle.state)).members
    expect(survivors.map(member => member.leafIndex)).toEqual([0, 1, 3])
    expect(survivors.map(member => member.identityKey)).toEqual([
      alice.identity.identityKey,
      bob.identity.identityKey,
      dave.identity.identityKey
    ])

    // Now remove by identity across the blank. A filtered-list index would name
    // leaf 2 — the blank — and take out the wrong member, or none at all.
    const withoutLast = await alice.removeMembers({
      state: withoutMiddle.state,
      identityKeys: [last.identityKey]
    })

    expect((await alice.info(withoutLast.state)).members.map(member => member.identityKey)).toEqual(
      [alice.identity.identityKey, bob.identity.identityKey]
    )

    // Bob's own view of both commits must agree about who left.
    const first = await bob.process({ state: bobState, message: withoutMiddle.commit })
    if (first.kind !== 'commit') throw new Error('wrong kind')
    expect(first.removed).toEqual([carol.identity.identityKey])

    const second = await bob.process({ state: first.state, message: withoutLast.commit })
    if (second.kind !== 'commit') throw new Error('wrong kind')
    expect(second.removed).toEqual([dave.identity.identityKey])
  })

  /**
   * A message that arrives late belongs to the roster of its own epoch.
   *
   * `ts-mls` fills the first blank leaf before extending the tree, so a member
   * who joins after a removal inherits the removed member's leaf index. Naming
   * an older message's sender against the live roster hands the newcomer
   * authorship of words they never wrote.
   */
  it('attributes a late message to its author, not to whoever took their leaf', async () => {
    const { alice, bob, carol, aliceState, bobState, carolState } = await quartet()

    // Carol speaks at epoch 1; the transport delays it.
    const delayed = await carol.encrypt({ state: carolState, plaintext: utf8('from Carol') })

    const withoutCarol = await alice.removeMembers({
      state: aliceState,
      identityKeys: [carol.identity.identityKey]
    })
    const eve = await newEngine()
    const eveKp = await eve.createKeyPackage()
    const withEve = await alice.addMembers({
      state: withoutCarol.state,
      keyPackages: [eveKp.keyPackage]
    })

    // Eve landed on the leaf Carol was removed from.
    const roster = (await alice.info(withEve.state)).members
    const eveMember = roster.find(member => member.identityKey === eve.identity.identityKey)
    expect(eveMember?.leafIndex).toBe(2)

    const atEpochTwo = await bob.process({ state: bobState, message: withoutCarol.commit })
    if (atEpochTwo.kind !== 'commit') throw new Error('wrong kind')
    const atEpochThree = await bob.process({ state: atEpochTwo.state, message: withEve.commit })
    if (atEpochThree.kind !== 'commit') throw new Error('wrong kind')
    expect((await bob.info(atEpochThree.state)).epoch).toBe(3n)

    // Two epochs later, the delayed message finally arrives.
    const heard = await bob.process({ state: atEpochThree.state, message: delayed.message })

    if (heard.kind !== 'application') throw new Error('wrong kind')
    expect(new TextDecoder().decode(heard.plaintext)).toBe('from Carol')
    expect(heard.epoch).toBe(1n)
    expect(heard.sender).toBe(carol.identity.identityKey)
    expect(heard.sender).not.toBe(eve.identity.identityKey)
  })
})
