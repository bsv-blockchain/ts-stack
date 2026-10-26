import { afterAll, afterEach, describe, expect, it } from '@jest/globals'
import { turnCredentials } from '../server/index.js'
import { PeerLink } from '../src/channel/PeerLink.js'
import { DirectPayClient } from '../src/client/DirectPayClient.js'
import { acceptDirectPayment } from '../src/payments/accept.js'
import { RelaySignaler } from '../src/signaling/RelaySignaler.js'
import { WebRTPayError } from '../src/util/errors.js'
import { relayFixtures } from './helpers/relay.js'
import { cleanupRtc, turnRtc } from './helpers/rtc.js'
import type { NodePeerConnection } from './helpers/rtc.js'
import { makeToken, makeWallet } from './helpers/wallet.js'
import type { TestWallet } from './helpers/wallet.js'

/*
 * Relayed connections through the coturn of docker/docker-compose.yml. They need Docker and
 * a relay built from this package listening on 127.0.0.1:8787, so they run only with
 * RUN_TURN_TESTS=1:
 *
 *   docker compose -f docker/docker-compose.yml up -d
 *   pnpm build && HOST=127.0.0.1 STUN_URLS=stun:127.0.0.1:3478 TURN_SECRET=webrtpay-dev-secret \
 *     TURN_URLS=turn:127.0.0.1:3478 TURN_PER_IP_PER_HOUR=600 node dist/server/cli.js
 *   pnpm test:turn
 *   docker compose -f docker/docker-compose.yml down
 *
 * Peers bind to 127.0.0.1 and talk only to coturn on 127.0.0.1:3478; coturn relays between
 * their allocations inside its container (see docker/turnserver.conf).
 */
const RUN = process.env.RUN_TURN_TESTS === '1'
/** `static-auth-secret` in docker/turnserver.conf, and the dev relay's TURN_SECRET. */
const SECRET = 'webrtpay-dev-secret'
const TURN_URL = 'turn:127.0.0.1:3478'
/** The dev relay started as above: the CLI with the dev environment. */
const DEV_RELAY = 'ws://127.0.0.1:8787'
/** Cap on a link before authentication, as DirectPayClient sets it. */
const PRE_AUTH_BYTES = 65536

;(RUN ? describe : describe.skip)('TURN through the local coturn (RUN_TURN_TESTS=1)', () => {
  const fixtures = relayFixtures()
  const links: PeerLink[] = []

  afterEach(async () => {
    for (const link of links.splice(0)) link.close()
    await fixtures.cleanup()
  })
  afterAll(cleanupRtc)

  /** Both ends gathered relayed candidates only, and the pair in use is relayed on both. */
  function expectRelayed(peers: NodePeerConnection[]): void {
    expect(peers).toHaveLength(2)
    for (const pc of peers) {
      const sdp = pc.localDescription.sdp
      expect(sdp).toContain(' typ relay')
      expect(sdp).not.toMatch(/ typ (host|srflx|prflx)/)
      expect(pc.selectedCandidatePair()).toMatchObject({
        local: { type: 'relay' },
        remote: { type: 'relay' }
      })
    }
  }

  it('connects two relay-only peers with turnCredentials and carries a message', async () => {
    const { rtc, peers } = await turnRtc()
    // REST usernames are "<expiry>:<pseudonym>": the colon is what the polyfill mangles
    const viaTurn = (identityKey: string): RTCIceServer[] => {
      const { username, credential } = turnCredentials({ secret: SECRET, identityKey })
      return [{ urls: TURN_URL, username, credential }]
    }
    const offered = await PeerLink.createOffer({
      ...rtc,
      iceServers: viaTurn('alice'),
      iceTransportPolicy: 'relay',
      maxMessageBytes: PRE_AUTH_BYTES
    })
    links.push(offered.link)
    const answered = await PeerLink.acceptOffer(offered.sdp, {
      ...rtc,
      iceServers: viaTurn('bob'),
      iceTransportPolicy: 'relay',
      maxMessageBytes: PRE_AUTH_BYTES
    })
    links.push(answered.link)
    const received = new Promise<unknown>(resolve => answered.link.onMessage(resolve))

    await offered.link.acceptAnswer(answered.sdp)
    await Promise.all([offered.link.waitOpen(15000), answered.link.waitOpen(15000)])
    await offered.link.send({ t: 'hello', via: 'turn' })

    expect(await received).toEqual({ t: 'hello', via: 'turn' })
    expectRelayed(peers)
  })

  it('pays through RelaySignalers over TURN with RelaySignaler.turnProvider as iceServersProvider', async () => {
    const relay = await fixtures.relay({
      turn: { kind: 'coturn-rest', secret: SECRET, urls: [TURN_URL] }
    })
    const { rtc, peers } = await turnRtc()
    let provided = 0
    const party = (w: TestWallet): DirectPayClient => {
      const signaler = new RelaySignaler({ url: relay.url, wallet: w.wallet })
      const turn = signaler.turnProvider()
      const c = new DirectPayClient({
        wallet: w.wallet,
        signaler,
        rtc: { ...rtc, iceTransportPolicy: 'relay' },
        iceServersProvider: () => {
          provided++
          return turn()
        }
      })
      fixtures.defer(() => signaler.close())
      fixtures.defer(() => c.close())
      return c
    }
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = party(payee)
    await receiver.startReceiving({
      onPayment: async p => {
        await acceptDirectPayment(payee.wallet, p)
        return 'accepted'
      }
    })
    const sender = party(payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)

    const peer = await sender.connect(payee.identityKey)
    // the dial and the answer each gathered with credentials the provider fetched
    expect(provided).toBe(2)
    expectRelayed(peers)
    const ack = await sender.sendPayment(peer, token)

    expect(ack).toEqual({ t: 'payment.ack', id: ack.id, status: 'accepted', txid })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('gets TURN credentials from the dev relay that the compose coturn accepts', async () => {
    const health = await fetch('http://127.0.0.1:8787/health')
    expect(await health.json()).toEqual({ status: 'ok' })
    const w = await makeWallet()
    const signaler = new RelaySignaler({ url: DEV_RELAY, wallet: w.wallet })
    fixtures.defer(() => signaler.close())
    let servers: RTCIceServer[]
    try {
      servers = await signaler.requestTurn()
    } catch (e) {
      if (e instanceof WebRTPayError && e.code === 'rate_limited') {
        throw new Error(
          'The dev relay issues TURN_PER_IP_PER_HOUR sets of TURN credentials per hour to ' +
            'one address; restart it to start over, with TURN_PER_IP_PER_HOUR=600 as the ' +
            'test header shows',
          { cause: e }
        )
      }
      throw e
    }
    expect(servers).toEqual([
      { urls: ['stun:127.0.0.1:3478'] },
      {
        urls: [TURN_URL],
        username: expect.stringMatching(/^\d+:[A-Za-z0-9_-]{22}$/),
        credential: expect.any(String)
      }
    ])

    // coturn allocates a relayed address with them
    const { rtc } = await turnRtc()
    const { link, sdp } = await PeerLink.createOffer({
      ...rtc,
      iceServers: servers,
      iceTransportPolicy: 'relay',
      maxMessageBytes: PRE_AUTH_BYTES
    })
    links.push(link)
    expect(sdp).toContain(' typ relay')
  })
})
