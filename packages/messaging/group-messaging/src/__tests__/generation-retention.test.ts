import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { GroupMessagingClient } from '../client.js'
import { decodeFrames } from '../storage/frames.js'
import { InProcessTransportHub } from '../transport/index.js'

/**
 * What out-of-order delivery costs inside one epoch.
 *
 * `ts-mls`'s `retainKeysForGenerations` is 10 and this library takes that
 * default, so a message more than ten generations behind the highest one
 * already seen from the same sender is refused for good: its key was evicted
 * from `unusedGenerations` to make room. Volume is not the risk — a hundred
 * messages in order stash nothing. The gap is.
 *
 * The ratchet is per sender, keyed by leaf, so several senders interleaving
 * costs nothing. What matters is one sender's own stream arriving out of order,
 * which a live socket running ahead of a backstop poll can produce.
 *
 * There is a second bound this does not exercise: `maximumForwardRatchetSteps`
 * is 200, so a first-seen message more than that far ahead is refused outright
 * rather than ratcheted to.
 *
 * Asserted rather than described so that a change to either default, or to our
 * config, is a failing test rather than a silent narrowing.
 */
describe('reordering inside an epoch', () => {
  it('loses only what falls more than ten generations behind', async () => {
    const queues = new Map<string, Uint8Array>()
    const hub = new InProcessTransportHub(queues)
    const open = async (wallet: KeyDeriver) =>
      GroupMessagingClient.create({
        wallet,
        storage: new Map(),
        transport: hub.endpoint(wallet.identityKey)
      })
    const aliceWallet = new KeyDeriver(PrivateKey.fromRandom())
    const bobWallet = new KeyDeriver(PrivateKey.fromRandom())
    const alice = await open(aliceWallet)
    const bob = await open(bobWallet)

    const bobKp = await bob.keyPackages.create()
    const aliceKp = await alice.keyPackages.create()
    const welcomed = new Promise<{ inviteId: string }>(resolve => {
      const stop = bob.on('welcomeReceived', payload => {
        stop()
        resolve(payload)
      })
    })
    const group = await alice.createGroup({
      chatId: 'c',
      members: [bobKp.keyPackage],
      privateKeyPackage: aliceKp.privateKeyPackage
    })
    const welcome = await welcomed
    await bob.joinFromWelcome({
      inviteId: welcome.inviteId,
      chatId: 'c',
      privateKeyPackage: bobKp.privateKeyPackage
    })

    const TOTAL = 15
    hub.goOffline(bob.identityKey)
    for (let index = 0; index < TOTAL; index++) await group.sendText(`#${index}`)

    const payloads = decodeFrames(queues.get(bob.identityKey)).map(frame => decodeFrames(frame)[1]!)
    expect(payloads).toHaveLength(TOTAL)

    const delivered: string[] = []
    bob.on('message', ({ content }) => delivered.push(String(content.body)))
    const refused: number[] = []
    // Newest first, the worst realistic reordering.
    for (let index = TOTAL - 1; index >= 0; index--) {
      try {
        await bob.processIncoming(payloads[index]!, alice.identityKey)
      } catch {
        refused.push(index)
      }
    }

    // Newest first: #14 ratchets to generation 15 and stashes the fourteen it
    // skipped, of which ten are kept. #0 to #3 are the four that fall off.
    expect(delivered).toHaveLength(11)
    expect(refused).toEqual([3, 2, 1, 0])

    await alice.close()
    await bob.close()
  })
})
