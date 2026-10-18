import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { DEFAULT_RELAY_LIMITS } from '../server/index.js'
import type { RelayServer } from '../server/index.js'
import { addressGroup, ipv6Block48 } from '../server/ip.js'
import {
  authenticate,
  env,
  hmacBase64,
  inbox,
  party,
  relayFixtures,
  upgradeError,
  waitFor,
  within
} from './helpers/relay.js'
import type { Party, Raw } from './helpers/relay.js'

describe('relay limits', () => {
  let alice: Party
  let bob: Party
  let carol: Party
  let dave: Party
  let erin: Party
  const { relay, signaler, rawAt, defer, cleanup } = relayFixtures()

  beforeAll(async () => {
    ;[alice, bob, carol, dave, erin] = await Promise.all([
      party(),
      party(),
      party(),
      party(),
      party()
    ])
  })

  afterEach(async () => {
    // a test that mocks Date.now and fails must not leave the clock frozen for the next one
    jest.restoreAllMocks()
    await cleanup()
  })

  /** A raw socket authenticated as `p`, past its `ready` and `ice` frames. */
  async function authed(r: RelayServer, p: Party, headers?: Record<string, string>): Promise<Raw> {
    const c = rawAt(r.url, { headers })
    await authenticate(c, p, r.url)
    expect(await c.next()).toEqual({ t: 'ready', identityKey: p.key })
    expect((await c.next()).t).toBe('ice')
    return c
  }

  /**
   * Resume `c`, which the relay terminated while `c` was paused, and return its close code.
   * The relay's side closed with data still queued against `c`'s full receive window, and
   * some kernels (macOS) then never deliver its FIN once `c` reads again; a ping reaches the
   * closed side, which answers with a reset.
   */
  function closeCode(c: Raw): Promise<number> {
    c.ws.resume()
    c.ws.ping()
    return c.closed
  }

  /** Open a raw socket and wait for its challenge, i.e. until the relay accepted it. */
  async function accepted(r: RelayServer, headers?: Record<string, string>): Promise<Raw> {
    const c = rawAt(r.url, { headers })
    expect((await c.next()).t).toBe('challenge')
    return c
  }

  /** Every frame `c` receives from now on, parsed, besides what `c.next()` hands out. */
  function record(c: Raw): Array<Record<string, unknown>> {
    const got: Array<Record<string, unknown>> = []
    c.ws.on('message', data => got.push(JSON.parse(String(data)) as Record<string, unknown>))
    return got
  }

  /** The headers that make a relay with `trustedIpHeader: 'x-client-ip'` see `ip`. */
  function fromIp(ip: string): Record<string, string> {
    return { 'x-client-ip': ip }
  }

  /** Send `to` a signal over `c` and return the relay's reply to it. */
  async function deliver(c: Raw, to: Party): Promise<Record<string, unknown>> {
    const e = env()
    c.send({ t: 'signal', to: to.key, envelope: e })
    const reply = await c.next()
    expect(reply.ref).toBe(e.sid)
    return reply
  }

  describe('frames over the rate (R3)', () => {
    it('gives up a wait on time even while Date.now is frozen', async () => {
      // the next test freezes the relay's clock; its waits must still fail, not hang
      jest.spyOn(Date, 'now').mockReturnValue(0)
      await expect(waitFor(() => false, 100)).rejects.toThrow('condition not met in time')
    }, 3000)

    it('answers each frame over the rate until maxOverRateFrames in a row, then closes with 1008', async () => {
      const r = await relay({ limits: { rateMessages: 5, maxOverRateFrames: 3 } })
      const a = await authed(r, alice)
      const got = record(a)
      // the auth frame took one of the 5 frames
      for (let i = 0; i < 12; i++) a.send({})
      expect(await a.closed).toBe(1008)
      expect(got.map(f => f.code)).toEqual([
        ...Array.from({ length: 4 }, () => 'bad_request'),
        ...Array.from({ length: 3 }, () => 'rate_limited')
      ])
      await waitFor(() => r.stats().sockets === 0)
    })

    it('counts only frames over the rate in a row', async () => {
      // The relay's clock is the test's, so only what the test advances refills a bucket and
      // no real delay can matter. One frame a second, 3 at most; the auth frame took one.
      // afterEach restores Date.now; the waits keep real time, so a failure cannot hang.
      let now = Date.now()
      jest.spyOn(Date, 'now').mockImplementation(() => now)
      const r = await relay({
        limits: { rateMessages: 3, rateWindowMs: 3000, maxOverRateFrames: 2 }
      })
      const a = await authed(r, alice)
      const got = record(a)
      const codes = async (n: number): Promise<unknown[]> => {
        await waitFor(() => got.length >= n)
        return got.splice(0, n).map(f => f.code)
      }
      for (let i = 0; i < 4; i++) a.send({})
      expect(await codes(4)).toEqual(['bad_request', 'bad_request', 'rate_limited', 'rate_limited'])
      now += 1100
      a.send({}) // within the rate again: the count starts over
      a.send({})
      a.send({})
      expect(await codes(3)).toEqual(['bad_request', 'rate_limited', 'rate_limited'])
      expect(a.ws.readyState).toBe(a.ws.OPEN)
      a.send({})
      expect(await within(a.closed, 'the close after the next frame over the rate')).toBe(1008)
    })

    it('charges pings to the rate: pongs within it, closes a socket that keeps pinging', async () => {
      const r = await relay({ limits: { rateMessages: 4, maxOverRateFrames: 2 } })
      let pongs = 0
      // before authenticating
      const early = rawAt(r.url)
      expect((await early.next()).t).toBe('challenge')
      early.ws.on('pong', () => pongs++)
      for (let i = 0; i < 20; i++) early.ws.ping()
      expect(await early.closed).toBe(1008)
      expect(pongs).toBe(4)

      // after authenticating (the auth frame took one)
      pongs = 0
      const a = await authed(r, alice)
      a.ws.on('pong', () => pongs++)
      for (let i = 0; i < 20; i++) a.ws.ping()
      expect(await a.closed).toBe(1008)
      expect(pongs).toBe(3)
    })

    it('closes a flooder that reads its replies while another client authenticates', async () => {
      const r = await relay()
      const a = await authed(r, alice)
      const got = record(a)
      for (let i = 0; i < 2000; i++) a.send({})
      const pinger = rawAt(r.url)
      expect((await pinger.next()).t).toBe('challenge')
      for (let i = 0; i < 2000; i++) pinger.ws.ping()
      const started = Date.now()
      await authed(r, carol)
      expect(Date.now() - started).toBeLessThan(2000)
      expect(await a.closed).toBe(1008)
      expect(await pinger.closed).toBe(1008)
      // 19 frames within the rate, then the default 20 over it are answered
      expect(got).toHaveLength(39)
      expect(DEFAULT_RELAY_LIMITS.maxOverRateFrames).toBe(20)
    })
  })

  describe('write buffers and liveness', () => {
    it('terminates a recipient that stops reading and reports the signal it could not take as not delivered', async () => {
      const r = await relay({
        limits: {
          maxBufferedBytes: 64 * 1024,
          rateMessages: 100000,
          signalsPerPairPerMinute: 100000,
          signalsPerRecipientPerMinute: 100000
        }
      })
      const b = await authed(r, bob)
      b.ws.pause()
      const a = await authed(r, alice)

      // The kernel's socket buffers take the first few hundred KiB; then the relay's own grows.
      const ciphertext = 'A'.repeat(16000)
      let delivered = 0
      let reply: Record<string, unknown> = {}
      while (delivered < 4000) {
        const e = env(ciphertext)
        a.send({ t: 'signal', to: bob.key, envelope: e })
        reply = await a.next()
        if (reply.t !== 'sent') {
          expect(reply).toEqual({ t: 'error', code: 'offline', ref: e.sid })
          break
        }
        delivered++
      }
      expect(reply.t).toBe('error')
      expect(delivered).toBeGreaterThan(0)
      await waitFor(() => r.stats().identities === 1)
      expect(r.stats()).toEqual({ sockets: 1, identities: 1 })
      expect(await closeCode(b)).toBe(1006)
    })

    it('stops answering a client that stops reading and terminates it', async () => {
      // Each `turn` frame (no TURN configured) is answered with this ~16 KiB STUN list.
      // Large replies reach the relay's own buffer quickly; tiny ones (an error per
      // junk frame) work the same way, but some kernels absorb a hundred megabytes of
      // them on loopback first.
      const stunUrls = Array.from({ length: 16 }, (_, i) => `stun:${'s'.repeat(1000)}${i}.example`)
      const r = await relay({
        stunUrls,
        limits: { maxBufferedBytes: 64 * 1024, rateMessages: 100000 }
      })
      const a = await authed(r, alice)
      a.ws.pause()
      let frames = 0
      while (r.stats().sockets === 1 && frames < 10000) {
        a.send({ t: 'turn' })
        if (++frames % 20 === 0) await new Promise(res => setTimeout(res, 1))
      }
      await waitFor(() => r.stats().sockets === 0)
      expect(frames).toBeLessThan(10000)
      expect(await closeCode(a)).toBe(1006)
    })

    it('drops a socket that sends pongs it was not asked for or with the wrong payload', async () => {
      const r = await relay({ limits: { pingIntervalMs: 250 } })
      const healthy = await authed(r, carol)

      const unsolicited = rawAt(r.url, { autoPong: false })
      await authenticate(unsolicited, alice, r.url)
      expect(await unsolicited.next()).toEqual({ t: 'ready', identityKey: alice.key })
      const pongs = setInterval(() => unsolicited.ws.pong(), 50)
      defer(() => clearInterval(pongs))

      const wrong = rawAt(r.url, { autoPong: false })
      wrong.ws.on('ping', () => wrong.ws.pong(Buffer.from('not your payload')))
      await authenticate(wrong, bob, r.url)
      expect(await wrong.next()).toEqual({ t: 'ready', identityKey: bob.key })

      expect(await unsolicited.closed).toBe(1006)
      expect(await wrong.closed).toBe(1006)
      await waitFor(() => r.stats().sockets === 1)
      expect(healthy.ws.readyState).toBe(healthy.ws.OPEN)
      expect(r.stats()).toEqual({ sockets: 1, identities: 1 })
    })
  })

  describe('admission', () => {
    it('validates the trusted address header and the new limits', async () => {
      await expect(relay({ trustedIpHeader: 'not a header' })).rejects.toThrow(TypeError)
      for (const limits of [
        { maxBufferedBytes: 0 },
        { maxSocketsPerIp: -1 },
        { turnPerHour: Number.NaN }
      ]) {
        await expect(relay({ limits })).rejects.toThrow(RangeError)
      }
    })

    it('refuses the 21st socket from one address before upgrading it', async () => {
      const r = await relay()
      const twenty: Raw[] = []
      for (let i = 0; i < 20; i++) twenty.push(await accepted(r))
      expect(await upgradeError(r.url)).toContain('429')
      expect(r.stats().sockets).toBe(20)

      twenty[0].ws.close()
      await waitFor(() => r.stats().sockets === 19)
      await accepted(r)
    })

    it('limits new connections per address per minute', async () => {
      const r = await relay({ limits: { connectionsPerIpPerMinute: 3 } })
      for (let i = 0; i < 3; i++) (await accepted(r)).ws.close()
      await waitFor(() => r.stats().sockets === 0)
      expect(await upgradeError(r.url)).toContain('429')
    })

    it('takes the client address from a header only when that header is configured', async () => {
      const limits = { maxSocketsPerIp: 1 }
      const plain = await relay({ limits })
      await accepted(plain, { 'cf-connecting-ip': '203.0.113.1' })
      // Without trustedIpHeader both come from 127.0.0.1, whatever the header says.
      expect(await upgradeError(plain.url, { 'cf-connecting-ip': '203.0.113.2' })).toContain('429')

      const logs: string[] = []
      const warnings = (): string[] => logs.filter(m => m.includes('cf-connecting-ip'))
      const proxied = await relay({
        trustedIpHeader: 'CF-Connecting-IP',
        limits,
        log: m => logs.push(m)
      })
      await accepted(proxied, { 'cf-connecting-ip': '203.0.113.1' })
      await accepted(proxied, { 'cf-connecting-ip': '203.0.113.2' })
      for (const ip of ['203.0.113.1', '::ffff:203.0.113.1']) {
        expect(await upgradeError(proxied.url, { 'cf-connecting-ip': ip })).toContain('429')
      }
      expect(warnings()).toEqual([])

      // A missing value, a list or anything but one address counts under the peer address:
      // no entry of a list is taken, because behind proxies that append to it, as they do to
      // x-forwarded-for, the last entry can be a proxy's address for every client.
      await accepted(proxied)
      for (const value of ['nonsense', '203.0.113.3, 203.0.113.4', '203.0.113.5,']) {
        expect(await upgradeError(proxied.url, { 'cf-connecting-ip': value })).toContain('429')
      }
      // each address in that list was free
      await accepted(proxied, { 'cf-connecting-ip': '203.0.113.3' })
      await accepted(proxied, { 'cf-connecting-ip': '203.0.113.4' })
      // the operator is told once that the header did not carry one address
      expect(warnings()).toHaveLength(1)
    })

    it('groups IPv6 clients by /64', async () => {
      const r = await relay({ trustedIpHeader: 'x-client-ip', limits: { maxSocketsPerIp: 1 } })
      await accepted(r, { 'x-client-ip': '2001:db8:1:2::1' })
      for (const ip of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:DB8:1:2:0:0:0:9']) {
        expect(await upgradeError(r.url, { 'x-client-ip': ip })).toContain('429')
      }
      await accepted(r, { 'x-client-ip': '2001:db8:1:3::1' })
    })

    it('caps unauthenticated sockets across all addresses', async () => {
      const r = await relay({
        trustedIpHeader: 'x-client-ip',
        limits: { maxUnauthenticatedSockets: 2 }
      })
      const a = rawAt(r.url, { headers: { 'x-client-ip': '203.0.113.1' } })
      await accepted(r, { 'x-client-ip': '203.0.113.2' })
      await waitFor(() => r.stats().sockets === 2)
      expect(await upgradeError(r.url, { 'x-client-ip': '203.0.113.3' })).toContain('503')

      await authenticate(a, alice, r.url)
      expect(await a.next()).toEqual({ t: 'ready', identityKey: alice.key })
      await accepted(r, { 'x-client-ip': '203.0.113.3' })
    })

    it('limits signals per sender address to a recipient, and to a recipient in total (R4)', async () => {
      const r = await relay({
        trustedIpHeader: 'x-client-ip',
        limits: { signalsPerPairPerMinute: 2, signalsPerRecipientPerMinute: 3 }
      })
      const bobBox = inbox()
      await signaler(r, bob).listen(bobBox.fn)
      const carolBox = inbox()
      await signaler(r, carol).listen(carolBox.fn)
      const a = await authed(r, alice, fromIp('203.0.113.1'))
      expect((await deliver(a, bob)).t).toBe('sent')
      expect((await deliver(a, bob)).t).toBe('sent')
      // alice's address has spent its share of bob's budget, and only its own
      expect(await deliver(a, bob)).toMatchObject({ t: 'error', code: 'rate_limited' })
      // carol's signaler connects from the loopback address, which has a share of its own
      await signaler(r, carol).send(bob.key, env())
      // bob's total of 3 is spent: anyone else is told he is not reachable
      const d = await authed(r, dave, fromIp('203.0.113.2'))
      expect(await deliver(d, bob)).toMatchObject({ t: 'error', code: 'offline' })
      // alice's address has its own share of carol's budget
      expect((await deliver(a, carol)).t).toBe('sent')
      await waitFor(() => carolBox.got.length === 1)
      expect(bobBox.got).toHaveLength(3)
      expect(DEFAULT_RELAY_LIMITS.signalsPerPairPerMinute).toBe(6)
      expect(DEFAULT_RELAY_LIMITS.signalsPerRecipientPerMinute).toBe(120)
    })

    it('checks the sender address share before the recipient total', async () => {
      const r = await relay({
        trustedIpHeader: 'x-client-ip',
        limits: { signalsPerPairPerMinute: 1, signalsPerRecipientPerMinute: 1 }
      })
      const bobBox = inbox()
      await signaler(r, bob).listen(bobBox.fn)
      const a = await authed(r, alice, fromIp('203.0.113.1'))
      expect((await deliver(a, bob)).t).toBe('sent')
      // both are spent now: alice's address hears of its own share first
      expect(await deliver(a, bob)).toMatchObject({ t: 'error', code: 'rate_limited' })
      // another address still has its share, but bob's total is gone
      const d = await authed(r, dave, fromIp('203.0.113.2'))
      expect(await deliver(d, bob)).toMatchObject({ t: 'error', code: 'offline' })
      await waitFor(() => bobBox.got.length === 1)
    })

    it('lets one address at the default rate no longer lock other senders out (R4)', async () => {
      const r = await relay({ trustedIpHeader: 'x-client-ip' })
      const bobBox = inbox()
      await signaler(r, bob).listen(bobBox.fn)
      const mallory = await authed(r, alice, fromIp('203.0.113.1'))
      // one junk signal every frame mallory may send: her share is gone after 6
      const replies: unknown[] = []
      for (let i = 0; i < 15; i++) {
        mallory.send({ t: 'signal', to: bob.key, envelope: env() })
        replies.push((await mallory.next()).t)
      }
      expect(replies.filter(t => t === 'sent')).toHaveLength(6)
      for (const p of [carol, dave]) await signaler(r, p).send(bob.key, env())
      expect(bobBox.got).toHaveLength(8)
    })

    it('shares one pair budget among the identities of one address group (Ruling 34)', async () => {
      const r = await relay({
        trustedIpHeader: 'x-client-ip',
        limits: { signalsPerPairPerMinute: 2 }
      })
      const bobBox = inbox()
      await signaler(r, bob).listen(bobBox.fn)
      const erinBox = inbox()
      await signaler(r, erin).listen(erinBox.fn)
      // alice and carol are two identities behind one IPv4 address; dave is elsewhere
      const a = await authed(r, alice, fromIp('203.0.113.1'))
      const c = await authed(r, carol, fromIp('203.0.113.1'))
      const d = await authed(r, dave, fromIp('203.0.113.2'))
      expect((await deliver(a, bob)).t).toBe('sent')
      expect((await deliver(c, bob)).t).toBe('sent')
      // the fresh identity does not bring a share of its own
      expect(await deliver(c, bob)).toMatchObject({ t: 'error', code: 'rate_limited' })
      expect(await deliver(a, bob)).toMatchObject({ t: 'error', code: 'rate_limited' })
      // another address has its own share of bob, and this address one of every recipient
      expect((await deliver(d, bob)).t).toBe('sent')
      expect((await deliver(c, erin)).t).toBe('sent')
      expect(bobBox.got).toHaveLength(3)
      await waitFor(() => erinBox.got.length === 1)
    })

    it('groups IPv6 sources by /64, not by /48, for the pair budget (Ruling 34)', async () => {
      const r = await relay({
        trustedIpHeader: 'x-client-ip',
        limits: { signalsPerPairPerMinute: 1 }
      })
      await signaler(r, bob).listen(inbox().fn)
      const a = await authed(r, alice, fromIp('2001:db8:aa:1::1'))
      const c = await authed(r, carol, fromIp('2001:db8:aa:1:ffff::9'))
      const d = await authed(r, dave, fromIp('2001:db8:aa:2::1'))
      expect((await deliver(a, bob)).t).toBe('sent')
      // same /64 as alice: her share
      expect(await deliver(c, bob)).toMatchObject({ t: 'error', code: 'rate_limited' })
      // another /64 of the same /48: a share of its own
      expect((await deliver(d, bob)).t).toBe('sent')
    })

    it('keeps an address group share when its sockets close and its source is swept (Ruling 34)', async () => {
      // The relay sweeps on its ping timer: right after each ping round it forgets the sources
      // that hold no socket and whose connection token is back (10 ms at 6000 a minute). A
      // socket whose pong has not been read by the next round is dropped, and bob's shares
      // with it, so rounds are 1 s apart: only an event-loop stall longer than that could drop
      // bob's listener (200 ms rounds lost it to a 500 ms stall).
      const pingIntervalMs = 1000
      const r = await relay({
        trustedIpHeader: 'x-client-ip',
        limits: { signalsPerPairPerMinute: 2, pingIntervalMs, connectionsPerIpPerMinute: 6000 }
      })
      await signaler(r, bob).listen(inbox().fn)
      const a = await authed(r, alice, fromIp('203.0.113.1'))
      expect((await deliver(a, bob)).t).toBe('sent')
      expect((await deliver(a, bob)).t).toBe('sent')
      a.ws.close()
      await within(a.closed, "alice's close")
      await waitFor(() => r.stats().sockets === 1)
      await new Promise(resolve => setTimeout(resolve, 20)) // the connection token is back
      // A socket that connects now gets its first ping from a round that starts later, which
      // sweeps once it has pinged: by the time that ping arrives, the source is gone.
      const probe = await authed(r, dave, fromIp('203.0.113.9'))
      await within(
        new Promise(resolve => probe.ws.once('ping', resolve)),
        'a ping round after the source emptied',
        3 * pingIntervalMs
      )
      // a new identity from the same address finds the share still spent
      const c = await authed(r, carol, fromIp('203.0.113.1'))
      expect(await deliver(c, bob)).toMatchObject({ t: 'error', code: 'rate_limited' })
    })

    it('also counts IPv6 sources by /48, at 4 times the /64 limits by default (R5)', async () => {
      expect(DEFAULT_RELAY_LIMITS).toMatchObject({
        maxSocketsPer48: 4 * DEFAULT_RELAY_LIMITS.maxSocketsPerIp,
        connectionsPer48PerMinute: 4 * DEFAULT_RELAY_LIMITS.connectionsPerIpPerMinute,
        turnPer48PerHour: 4 * DEFAULT_RELAY_LIMITS.turnPerIpPerHour
      })
      const r = await relay({
        trustedIpHeader: 'x-client-ip',
        limits: { maxSocketsPerIp: 2, maxSocketsPer48: 3 }
      })
      const from = (ip: string): Record<string, string> => ({ 'x-client-ip': ip })
      await accepted(r, from('2001:db8:aa:1::1'))
      await accepted(r, from('2001:db8:aa:1::2'))
      expect(await upgradeError(r.url, from('2001:db8:aa:1::3'))).toContain('429')
      await accepted(r, from('2001:db8:aa:2::1'))
      // the /48 is full, whichever /64 inside it asks
      expect(await upgradeError(r.url, from('2001:db8:aa:3::1'))).toContain('429')
      expect(await upgradeError(r.url, from('2001:db8:aa:ffff::1'))).toContain('429')
      // another /48, and IPv4, are not affected
      await accepted(r, from('2001:db8:bb:1::1'))
      for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) await accepted(r, from(ip))
    })

    it('limits new connections per /48 per minute (R5)', async () => {
      const r = await relay({
        trustedIpHeader: 'x-client-ip',
        limits: { connectionsPer48PerMinute: 3 }
      })
      for (let i = 1; i <= 3; i++) {
        ;(await accepted(r, { 'x-client-ip': `2001:db8:aa:${i}::1` })).ws.close()
      }
      expect(await upgradeError(r.url, { 'x-client-ip': '2001:db8:aa:4::1' })).toContain('429')
      await accepted(r, { 'x-client-ip': '2001:db8:bb:1::1' })
    })
  })

  describe('TURN issuance', () => {
    const turn = {
      kind: 'coturn-rest' as const,
      secret: 'turn-secret',
      urls: ['turn:127.0.0.1:3478']
    }
    const stun = { urls: ['stun:127.0.0.1:3478'] }

    /** Deliver one signal from `c` to bob, who must be listening. */
    async function deliver(c: Raw): Promise<void> {
      const e = env()
      c.send({ t: 'signal', to: bob.key, envelope: e })
      expect(await c.next()).toEqual({ t: 'sent', ref: e.sid })
    }

    async function requestTurn(c: Raw): Promise<Record<string, unknown>> {
      c.send({ t: 'turn' })
      return c.next()
    }

    it('issues TURN credentials to an authenticated socket that has sent no signal (Ruling 27)', async () => {
      const r = await relay({ stunUrls: stun.urls, turn })
      const a = await authed(r, alice)
      const before = Math.floor(Date.now() / 1000)
      const reply = await requestTurn(a)
      const after = Math.floor(Date.now() / 1000)
      expect(reply.t).toBe('ice')
      const servers = reply.iceServers as RTCIceServer[]
      expect(servers).toHaveLength(2)
      expect(servers[0]).toEqual(stun)
      expect(servers[1].urls).toEqual(turn.urls)
      const username = servers[1].username as string
      const [expiry, pseudonym] = username.split(':')
      expect(pseudonym).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(username).not.toContain(alice.key)
      // the relay's default lifetime is 10 minutes
      expect(Number(expiry)).toBeGreaterThanOrEqual(before + 600)
      expect(Number(expiry)).toBeLessThanOrEqual(after + 600)
      expect(servers[1].credential).toBe(hmacBase64(turn.secret, username))
      // the frame says when they expire, as the username does
      expect(reply.expiresAt).toBe(Number(expiry) * 1000)
    })

    it('hands RelaySignaler the full list on requestTurn and keeps it as iceServers()', async () => {
      const r = await relay({ stunUrls: stun.urls, turn: { ...turn, ttlSeconds: 120 } })
      await signaler(r, bob).listen(() => {})
      const seen: RTCIceServer[][] = []
      const a = signaler(r, alice, { onIceServers: s => seen.push(s) })
      await a.connect()
      // no signal has been delivered on this connection yet
      const first = await a.requestTurn()
      expect(first).toHaveLength(2)
      expect(first[1]).toMatchObject({ urls: turn.urls, username: expect.any(String) })

      // replies stay matched to requests when a turn request sits between sends
      const [, servers] = await Promise.all([
        a.send(bob.key, env()),
        a.requestTurn(),
        a.send(bob.key, env())
      ])
      expect(servers).toHaveLength(2)
      expect(a.iceServers()).toEqual(servers)
      expect(seen).toEqual([[stun], first, servers])
    })

    it('limits issuance per source address and in total', async () => {
      const r = await relay({
        turn,
        trustedIpHeader: 'x-client-ip',
        limits: { turnPerIpPerHour: 2, turnPerHour: 3 }
      })
      await signaler(r, bob).listen(() => {})
      const from = (ip: string): Promise<Raw> => authed(r, alice, { 'x-client-ip': ip })
      const one = await from('203.0.113.1')
      expect((await requestTurn(one)).t).toBe('ice')
      expect((await requestTurn(one)).t).toBe('ice')
      expect(await requestTurn(one)).toEqual({ t: 'error', code: 'rate_limited' })
      // another socket from the same address shares its budget, and a signal earns nothing
      const sameAddress = await from('203.0.113.1')
      await deliver(sameAddress)
      expect(await requestTurn(sameAddress)).toEqual({ t: 'error', code: 'rate_limited' })

      const two = await from('203.0.113.2')
      expect((await requestTurn(two)).t).toBe('ice')
      // the relay-wide budget of 3 is spent
      const three = await from('203.0.113.3')
      expect(await requestTurn(three)).toEqual({ t: 'error', code: 'rate_limited' })
    })

    it('limits issuance per /48 too (R5)', async () => {
      const r = await relay({
        turn,
        trustedIpHeader: 'x-client-ip',
        limits: { turnPerIpPerHour: 6, turnPer48PerHour: 2 }
      })
      const from = (ip: string): Promise<Raw> => authed(r, alice, { 'x-client-ip': ip })
      expect((await requestTurn(await from('2001:db8:aa:1::1'))).t).toBe('ice')
      expect((await requestTurn(await from('2001:db8:aa:2::1'))).t).toBe('ice')
      expect(await requestTurn(await from('2001:db8:aa:3::1'))).toEqual({
        t: 'error',
        code: 'rate_limited'
      })
      expect((await requestTurn(await from('2001:db8:bb:1::1'))).t).toBe('ice')
    })

    it('answers turn with the STUN servers when no TURN is configured', async () => {
      const r = await relay({ stunUrls: stun.urls })
      const a = await authed(r, alice)
      expect(await requestTurn(a)).toEqual({ t: 'ice', iceServers: [stun] })
    })
  })
})

describe('ipv6Block48', () => {
  it('names the /48 of an IPv6 address, and nothing for IPv4 or IPv4-mapped addresses', () => {
    const cases: Array<[string, string | undefined]> = [
      ['2001:db8:1:2::1', '2001:db8:1::/48'],
      ['2001:DB8:1:ffff:ffff:ffff:ffff:ffff', '2001:db8:1::/48'],
      ['[2001:db8::5]', '2001:db8:0::/48'],
      ['::1', '0:0:0::/48'],
      ['203.0.113.7', undefined],
      ['::ffff:203.0.113.7', undefined],
      ['not an address', undefined]
    ]
    for (const [address, block] of cases)
      expect([address, ipv6Block48(address)]).toEqual([address, block])
  })
})

describe('addressGroup', () => {
  it('keeps IPv4 addresses, unmaps IPv4-mapped IPv6 and groups other IPv6 by /64', () => {
    const cases: Array<[string, string]> = [
      ['203.0.113.7', '203.0.113.7'],
      ['::ffff:203.0.113.7', '203.0.113.7'],
      ['::ffff:cb00:7107', '203.0.113.7'],
      ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
      ['2001:DB8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
      ['2001:db8::1', '2001:db8:0:0::/64'],
      ['[2001:db8:0:1::5]', '2001:db8:0:1::/64'],
      ['fe80::1%en0', 'fe80:0:0:0::/64'],
      ['::1', '0:0:0:0::/64'],
      ['::', '0:0:0:0::/64'],
      ['2001:db8:3:4:5:6:192.0.2.4', '2001:db8:3:4::/64'],
      ['not an address', 'not an address'],
      ['', '']
    ]
    for (const [address, group] of cases)
      expect([address, addressGroup(address)]).toEqual([address, group])
  })
})
