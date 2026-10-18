import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import fc from 'fast-check'
import { ProtoWallet } from '@bsv/sdk'
import { DEFAULT_RELAY_LIMITS, createRelayServer, turnCredentials } from '../server/index.js'
import type { CloudflareTurnProvider } from '../server/index.js'
import { DEFAULT_HOST, relayOptionsFromEnv, relayUsage } from '../server/env.js'
import { DEFAULT_RELAY_PORT, isLoopbackHost } from '../server/relay.js'
import { DEFAULT_TURN_TTL_SECONDS } from '../server/turn.js'
import { RelaySignaler, normalizeRelayUrl, relayAuthData } from '../src/signaling/RelaySignaler.js'
import type { RelaySignalerOptions } from '../src/signaling/RelaySignaler.js'
import {
  MAX_SIGNAL_CIPHERTEXT_CHARS,
  MAX_SIGNAL_SDP_CHARS,
  ReplayCache,
  openSignal,
  sealSignal
} from '../src/signaling/envelope.js'
import type { SignalEnvelope } from '../src/signaling/types.js'
import { RELAY_PROTOCOL_ID } from '../src/types.js'
import { randomBytes, toBase64Url, toHex } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import {
  authenticate,
  env,
  freePort,
  hmacBase64,
  inbox,
  newSid,
  party,
  raw,
  relayFixtures,
  upgradeError,
  waitFor
} from './helpers/relay.js'
import type { Party } from './helpers/relay.js'

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n'

describe('turnCredentials', () => {
  it('derives coturn REST credentials from the secret and a pseudonym of the identity key', () => {
    // pseudonym = base64url(HMAC-SHA256('s', 'webrtpay-turn-user|02ab')).slice(0, 22)
    const pseudonym = createHmac('sha256', 's')
      .update('webrtpay-turn-user|02ab')
      .digest('base64url')
      .slice(0, 22)
    expect(pseudonym).toBe('8OSyoxEttHTQPehoRrXxzb')
    expect(
      turnCredentials({ secret: 's', identityKey: '02ab', ttlSeconds: 60, now: 1_000_000_000_000 })
    ).toEqual({
      username: '1000000060:8OSyoxEttHTQPehoRrXxzb',
      credential: 'Ci1uC3E40z7bL2q9IwWVcfUzQXg=',
      expiresAt: 1_000_000_060_000
    })
    expect(hmacBase64('s', '1000000060:8OSyoxEttHTQPehoRrXxzb')).toBe(
      'Ci1uC3E40z7bL2q9IwWVcfUzQXg='
    )
  })

  it('matches fixed coturn REST vectors for UTF-8, hex-looking, block-sized and long secrets', () => {
    // Expected values: base64(HMAC-SHA1(utf8(secret), utf8(username))), computed with
    // node:crypto, which is what coturn's use-auth-secret check reproduces.
    const vectors = [
      [
        'coturn-static-auth-secret',
        '02ab',
        '5SsuiQiML_xRe0sRbBQsGE',
        'uCKYuYnffWSWlc+9BpjWOnRp+S0='
      ],
      // a secret that also parses as hex must still be taken as UTF-8 text
      ['deadbeef', '02ab', 'vCJ6TX5ewasnc3xdwaVz_2', 't4Em3G6XG+arEt80qnFoebBp7ZE='],
      ['sécret-✓', '02ab', '4gzRXwa7RpU4qfcSaTyZ_u', 'gxkF2/FcAtmmzAfG1jU68bdFUPU='],
      // exactly one SHA-1 block, then longer than one (the key is hashed first)
      ['k'.repeat(64), '02ab', 'owMnNg8DPApg3y9bX0UwOq', 'zJeuYeunJ894JnVDzjOd0ld4TXc='],
      [
        `${'x'.repeat(65)}-long-secret-past-the-sha1-block`,
        '03cd',
        '6_FnfmwhCRbRIi44gYbA5o',
        'W1fBSgHLTrBM5udFFGokbeIPAko='
      ]
    ]
    for (const [secret, identityKey, pseudonym, credential] of vectors) {
      expect(
        turnCredentials({ secret, identityKey, ttlSeconds: 600, now: 1_700_000_000_000 })
      ).toEqual({
        username: `1700000600:${pseudonym}`,
        credential,
        expiresAt: 1_700_000_600_000
      })
      expect(hmacBase64(secret, `1700000600:${pseudonym}`)).toBe(credential)
    }
  })

  it('keeps the identity key out of the username but gives each identity a stable pseudonym', async () => {
    const { key } = await party()
    const at = (now: number, identityKey = key, secret = 'k') =>
      turnCredentials({ secret, identityKey, now }).username
    const username = at(1_000_000_000_000)
    expect(username).toMatch(/^1000003600:[A-Za-z0-9_-]{22}$/)
    expect(username).not.toContain(key)
    expect(username).not.toContain(key.slice(2, 24))
    const pseudonym = (u: string) => u.slice(u.indexOf(':') + 1)
    // coturn groups --user-quota by the part after the timestamp, so it must not change
    expect(pseudonym(at(1_700_000_000_000))).toBe(pseudonym(username))
    expect(pseudonym(at(1_000_000_000_000, '03cd'))).not.toBe(pseudonym(username))
    expect(pseudonym(at(1_000_000_000_000, key, 'other'))).not.toBe(pseudonym(username))
  })

  it('defaults to a one hour ttl from the current time', () => {
    const before = Math.floor(Date.now() / 1000)
    const { username, credential, expiresAt } = turnCredentials({
      secret: 'k',
      identityKey: '03cd'
    })
    const after = Math.floor(Date.now() / 1000)
    const [expiry, pseudonym] = username.split(':')
    expect(pseudonym).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(Number(expiry)).toBeGreaterThanOrEqual(before + 3600)
    expect(Number(expiry)).toBeLessThanOrEqual(after + 3600)
    expect(expiresAt).toBe(Number(expiry) * 1000)
    expect(credential).toBe(hmacBase64('k', username))
  })

  it('rejects a ttl that is not a positive whole number of seconds and an empty secret', () => {
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN]) {
      expect(() => turnCredentials({ secret: 's', identityKey: '02ab', ttlSeconds })).toThrow(
        RangeError
      )
    }
    expect(() => turnCredentials({ secret: '', identityKey: '02ab' })).toThrow(TypeError)
  })
})

describe('relay authentication signature', () => {
  it('verifies with ProtoWallet("anyone") for the signer and only for the signed url', async () => {
    const p = await party()
    const nonce = toBase64Url(randomBytes(32))
    const { signature } = await p.wallet.createSignature({
      data: relayAuthData('ws://127.0.0.1:8787', nonce),
      protocolID: RELAY_PROTOCOL_ID,
      keyID: nonce,
      counterparty: 'anyone'
    })
    const anyone = new ProtoWallet('anyone')
    const verify = (url: string): Promise<unknown> =>
      anyone.verifySignature({
        data: relayAuthData(url, nonce),
        signature,
        protocolID: RELAY_PROTOCOL_ID,
        keyID: nonce,
        counterparty: p.key
      })
    await expect(verify('ws://127.0.0.1:8787')).resolves.toEqual({ valid: true })
    await expect(verify('ws://127.0.0.1:8787/')).resolves.toEqual({ valid: true })
    await expect(verify('ws://127.0.0.1:8788')).rejects.toThrow()
  })

  it('signs the prefix, the url without trailing slashes and the nonce', () => {
    const text = new TextDecoder().decode(Uint8Array.from(relayAuthData('wss://r.example//', 'n1')))
    expect(text).toBe('webrtpay-relay/1|wss://r.example|n1')
  })

  it('drops exactly the trailing slashes of any url, astral characters and lone surrogates included', () => {
    expect(normalizeRelayUrl('wss://r.example/😀//')).toBe('wss://r.example/😀')
    expect(normalizeRelayUrl('wss://r.example/\uD83D/')).toBe('wss://r.example/\uD83D')
    expect(normalizeRelayUrl('\uDE00//')).toBe('\uDE00')
    expect(normalizeRelayUrl('///')).toBe('')
    const piece = fc.oneof(
      fc.constantFrom('/', 'a', '😀', '\uD83D', '\uDE00', '／'),
      fc.integer({ min: 0, max: 0xffff }).map(c => String.fromCodePoint(c))
    )
    fc.assert(
      fc.property(fc.string({ unit: piece, maxLength: 12 }), url => {
        let expected = url
        while (expected.endsWith('/')) expected = expected.slice(0, -1)
        expect(normalizeRelayUrl(url)).toBe(expected)
      })
    )
  })
})

describe('relay', () => {
  let alice: Party
  let bob: Party
  let carol: Party
  const { relay, signaler, rawAt, defer, cleanup } = relayFixtures()

  beforeAll(async () => {
    ;[alice, bob, carol] = await Promise.all([party(), party(), party()])
  })

  afterEach(cleanup)

  describe('server', () => {
    it('reports its url and port and answers GET /health', async () => {
      const r = await relay()
      expect(r.url).toBe(`ws://127.0.0.1:${r.port}`)
      const res = await fetch(`http://127.0.0.1:${r.port}/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'ok' })
      expect((await fetch(`http://127.0.0.1:${r.port}/nope`)).status).toBe(404)
    })

    it('refuses websocket upgrades on other paths', async () => {
      const r = await relay({ path: '/relay' })
      expect(r.url).toBe(`ws://127.0.0.1:${r.port}/relay`)
      expect(await upgradeError(`ws://127.0.0.1:${r.port}/other`)).toContain('404')
    })

    it('challenges, then sends ready and ice once the signature verifies', async () => {
      const r = await relay()
      const a = rawAt(r.url)
      await authenticate(a, alice, r.url)
      expect(await a.next()).toEqual({ t: 'ready', identityKey: alice.key })
      expect(await a.next()).toEqual({ t: 'ice', iceServers: [] })
    })

    it('uses a fresh 32-byte base64url nonce for every socket', async () => {
      const r = await relay()
      const nonces = await Promise.all(
        [rawAt(r.url), rawAt(r.url)].map(async c => (await c.next()).nonce)
      )
      for (const n of nonces) expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(nonces[0]).not.toBe(nonces[1])
    })

    it('closes a client that signed the wrong url with auth_failed', async () => {
      const r = await relay()
      const a = rawAt(r.url)
      await authenticate(a, alice, 'ws://evil.example')
      expect(await a.next()).toEqual({ t: 'error', code: 'auth_failed' })
      expect(await a.closed).toBe(1008)
      await waitFor(() => r.stats().sockets === 0)
      expect(r.stats()).toEqual({ sockets: 0, identities: 0 })
    })

    it('closes a client whose signature belongs to another key with auth_failed', async () => {
      const r = await relay()
      const a = rawAt(r.url)
      const challenge = await a.next()
      const nonce = challenge.nonce as string
      const { signature } = await carol.wallet.createSignature({
        data: relayAuthData(r.url, nonce),
        protocolID: RELAY_PROTOCOL_ID,
        keyID: nonce,
        counterparty: 'anyone'
      })
      a.send({ t: 'auth', identityKey: alice.key, signature: toHex(Uint8Array.from(signature)) })
      expect(await a.next()).toEqual({ t: 'error', code: 'auth_failed' })
      expect(await a.closed).toBe(1008)
    })

    it('verifies against the public urls instead of the Host header when they are set', async () => {
      const r = await relay({ publicUrls: ['wss://relay.example/', 'wss://relay2.example'] })
      const a = rawAt(r.url)
      await authenticate(a, alice, 'wss://relay.example')
      expect(await a.next()).toEqual({ t: 'ready', identityKey: alice.key })

      const b = rawAt(r.url)
      await authenticate(b, bob, r.url)
      expect(await b.next()).toEqual({ t: 'error', code: 'auth_failed' })
      expect(await b.closed).toBe(1008)
    })

    it('ignores x-forwarded-proto unless the Host header is trusted', async () => {
      // On loopback without public urls, a same-host proxy could otherwise get a victim's
      // wss:// signature for a Host of its choosing accepted here.
      const r = await relay({ path: '/relay/' })
      const host = `127.0.0.1:${r.port}`
      const a = rawAt(r.url, { headers: { 'x-forwarded-proto': 'https' } })
      await authenticate(a, alice, `wss://${host}/relay`)
      expect(await a.next()).toEqual({ t: 'error', code: 'auth_failed' })
      expect(await a.closed).toBe(1008)

      const b = rawAt(r.url, { headers: { 'x-forwarded-proto': 'https' } })
      await authenticate(b, bob, `ws://${host}/relay`)
      expect(await b.next()).toEqual({ t: 'ready', identityKey: bob.key })
    })

    it('expects a wss url behind a proxy that forwards https when the Host header is trusted', async () => {
      const r = await relay({ path: '/relay/', trustHostHeader: true })
      const host = `127.0.0.1:${r.port}`
      const a = rawAt(r.url, { headers: { 'x-forwarded-proto': 'https' } })
      await authenticate(a, alice, `wss://${host}/relay`)
      expect(await a.next()).toEqual({ t: 'ready', identityKey: alice.key })

      const b = rawAt(r.url, { headers: { 'x-forwarded-proto': 'https' } })
      await authenticate(b, bob, `ws://${host}/relay`)
      expect(await b.next()).toEqual({ t: 'error', code: 'auth_failed' })
    })

    it('rejects a signature over the url a forged Host names when public urls are set', async () => {
      // A relay the victim dialed (evil.example) replays this relay's nonce to the
      // victim, then presents the victim's signature here with a matching Host.
      const r = await relay({ publicUrls: ['wss://relay.example'] })
      const headers = { host: 'evil.example', 'x-forwarded-proto': 'https' }
      const a = rawAt(r.url, { headers })
      await authenticate(a, alice, 'wss://evil.example')
      expect(await a.next()).toEqual({ t: 'error', code: 'auth_failed' })
      expect(await a.closed).toBe(1008)

      const b = rawAt(r.url, { headers })
      await authenticate(b, bob, 'wss://relay.example')
      expect(await b.next()).toEqual({ t: 'ready', identityKey: bob.key })
    })

    it('refuses to listen on a non-loopback address without public urls', async () => {
      const port = await freePort()
      const logs: string[] = []
      await expect(
        createRelayServer({ port, host: '0.0.0.0', log: m => logs.push(m) })
      ).rejects.toThrow('publicUrls is required')
      expect(logs).toEqual([])
      // The port was released: listening on it again succeeds.
      const again = await relay({ port, host: '127.0.0.1' })
      expect(again.port).toBe(port)
    })

    it('listens on a non-loopback address with public urls or trustHostHeader', async () => {
      const pub = await relay({ host: '0.0.0.0', publicUrls: ['wss://relay.example'] })
      const a = rawAt(`ws://127.0.0.1:${pub.port}`)
      await authenticate(a, alice, 'wss://relay.example')
      expect(await a.next()).toEqual({ t: 'ready', identityKey: alice.key })

      const logs: string[] = []
      const trusting = await relay({
        host: '0.0.0.0',
        trustHostHeader: true,
        log: m => logs.push(m)
      })
      const url = `ws://127.0.0.1:${trusting.port}`
      const b = rawAt(url)
      await authenticate(b, bob, url)
      expect(await b.next()).toEqual({ t: 'ready', identityKey: bob.key })
      expect(logs[0]).toContain('WARNING: no publicUrls')
    })

    it('warns at startup when public urls are set without a trusted address header (Ruling 28)', async () => {
      const proxied: string[] = []
      await relay({ publicUrls: ['wss://relay.example'], log: m => proxied.push(m) })
      const warning = proxied.filter(m => m.includes('WARNING'))
      expect(warning).toHaveLength(1)
      expect(warning[0]).toContain('trustedIpHeader')
      expect(warning[0]).toContain('TRUSTED_IP_HEADER=cf-connecting-ip')

      const trusted: string[] = []
      await relay({
        publicUrls: ['wss://relay.example'],
        trustedIpHeader: 'cf-connecting-ip',
        log: m => trusted.push(m)
      })
      const local: string[] = []
      await relay({ log: m => local.push(m) })
      expect(trusted.join('\n')).not.toContain('WARNING')
      expect(local.join('\n')).not.toContain('trustedIpHeader')
    })

    it('refuses a non-loopback server it is attached to without public urls, leaving it open', async () => {
      const http = createServer((_req, res) => res.end('app'))
      await new Promise<void>(r => http.listen(0, '0.0.0.0', r))
      defer(() => new Promise(r => http.close(r)))
      await expect(createRelayServer({ server: http })).rejects.toThrow('publicUrls is required')
      expect(http.listening).toBe(true)
      expect(http.listenerCount('upgrade')).toBe(0)
      const { port } = http.address() as AddressInfo
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('app')
    })

    it('treats only loopback hosts as loopback', () => {
      const loopback = [
        'localhost',
        'LOCALHOST',
        '127.0.0.1',
        '127.1.2.3',
        '::1',
        '::ffff:127.0.0.1'
      ]
      const other = [
        '0.0.0.0',
        '::',
        '10.0.0.1',
        '198.51.100.1',
        '127.0.0.256',
        '::ffff:10.0.0.1',
        'relay.localhost',
        'example.com',
        ''
      ]
      expect(loopback.filter(isLoopbackHost)).toEqual(loopback)
      expect(other.filter(isLoopbackHost)).toEqual([])
    })

    it('rejects a signal sent before authenticating and never forwards it', async () => {
      const r = await relay()
      const box = inbox()
      await signaler(r, bob).listen(box.fn)

      const m = rawAt(r.url)
      expect((await m.next()).t).toBe('challenge')
      const e = env()
      m.send({ t: 'signal', to: bob.key, envelope: e })
      expect(await m.next()).toEqual({ t: 'error', code: 'auth_failed' })
      expect(await m.closed).toBe(1008)

      const control = env()
      await signaler(r, alice).send(bob.key, control)
      expect(await box.next()).toEqual([alice.key, control])
      expect(box.got).toHaveLength(1)
    })

    it('closes a socket that does not authenticate in time', async () => {
      const r = await relay({ limits: { authTimeoutMs: 100 } })
      const a = rawAt(r.url)
      expect((await a.next()).t).toBe('challenge')
      expect(await a.next()).toEqual({ t: 'error', code: 'auth_failed' })
      expect(await a.closed).toBe(1008)
    })

    it('answers malformed frames from an authenticated socket with bad_request and keeps it open', async () => {
      const r = await relay()
      const box = inbox()
      await signaler(r, bob).listen(box.fn)
      const a = rawAt(r.url)
      await authenticate(a, alice, r.url)
      await a.next()
      await a.next()

      const e = env()
      a.send('not json')
      expect(await a.next()).toEqual({ t: 'error', code: 'bad_request' })
      a.send({ t: 'signal', to: 'zz', envelope: e })
      expect(await a.next()).toEqual({ t: 'error', code: 'bad_request', ref: e.sid })
      a.send({ t: 'signal', to: bob.key, envelope: { v: 2, sid: 's', ciphertext: '' } })
      expect(await a.next()).toEqual({ t: 'error', code: 'bad_request' })
      a.send({ t: 'auth', identityKey: alice.key, signature: '00' })
      expect(await a.next()).toEqual({ t: 'error', code: 'bad_request' })
      a.ws.send(Uint8Array.of(1, 2, 3))
      expect(await a.next()).toEqual({ t: 'error', code: 'bad_request' })

      a.send({ t: 'signal', to: bob.key, envelope: e })
      expect(await a.next()).toEqual({ t: 'sent', ref: e.sid })
      expect(await box.next()).toEqual([alice.key, e])
      expect(box.got).toHaveLength(1)
    })

    it('forwards only the envelope fields with the authenticated sender', async () => {
      const r = await relay()
      const box = inbox()
      await signaler(r, bob).listen(box.fn)
      const a = rawAt(r.url)
      await authenticate(a, alice, r.url)
      await a.next()
      await a.next()

      const e = env()
      a.send({ t: 'signal', to: bob.key, from: carol.key, envelope: { ...e, from: carol.key } })
      expect(await a.next()).toEqual({ t: 'sent', ref: e.sid })
      const [from, got] = await box.next()
      expect(from).toBe(alice.key)
      expect(got).toEqual(e)
      expect(Object.keys(got).sort()).toEqual(['ciphertext', 'sid', 'v'])
    })

    it('limits each identity to five sockets, checked after the signature', async () => {
      const r = await relay()
      const five = Array.from({ length: 5 }, () => signaler(r, alice))
      await Promise.all(five.map(s => s.connect()))
      expect(r.stats()).toEqual({ sockets: 5, identities: 1 })

      const forged = rawAt(r.url)
      await authenticate(forged, carol, r.url)
      await forged.next()
      const impostor = rawAt(r.url)
      expect((await impostor.next()).t).toBe('challenge')
      impostor.send({ t: 'auth', identityKey: alice.key, signature: '3006020101020101' })
      expect(await impostor.next()).toEqual({ t: 'error', code: 'auth_failed' })

      const sixth = rawAt(r.url)
      await authenticate(sixth, alice, r.url)
      expect(await sixth.next()).toEqual({ t: 'error', code: 'rate_limited' })
      expect(await sixth.closed).toBe(1013)
      await expect(signaler(r, alice).connect()).rejects.toMatchObject({ code: 'rate_limited' })
      await waitFor(() => r.stats().sockets === 6)
      expect(r.stats()).toEqual({ sockets: 6, identities: 2 })
    })

    it('refuses upgrades beyond the global socket cap', async () => {
      const r = await relay({ limits: { maxSockets: 1 } })
      await signaler(r, alice).connect()
      expect(await upgradeError(r.url)).toContain('503')
      expect(r.stats()).toEqual({ sockets: 1, identities: 1 })
    })

    it('terminates sockets that stop answering pings', async () => {
      const r = await relay({ limits: { pingIntervalMs: 250 } })
      const healthy = signaler(r, bob)
      await healthy.connect()
      const silent = rawAt(r.url, { autoPong: false })
      await authenticate(silent, alice, r.url)
      expect(await silent.next()).toEqual({ t: 'ready', identityKey: alice.key })
      expect(await silent.closed).toBe(1006)
      await new Promise(res => setTimeout(res, 600))
      expect(r.stats()).toEqual({ sockets: 1, identities: 1 })
    })

    it('sends only the STUN urls in ice after authentication, even with TURN configured', async () => {
      const r = await relay({
        stunUrls: ['stun:127.0.0.1:3478'],
        turn: { kind: 'coturn-rest', secret: 'turn-secret', urls: ['turn:127.0.0.1:3478'] }
      })
      const a = rawAt(r.url)
      await authenticate(a, alice, r.url)
      expect(await a.next()).toEqual({ t: 'ready', identityKey: alice.key })
      expect(await a.next()).toEqual({ t: 'ice', iceServers: [{ urls: ['stun:127.0.0.1:3478'] }] })

      const seen: RTCIceServer[][] = []
      const s = signaler(r, bob, { onIceServers: servers => seen.push(servers) })
      expect(s.iceServers()).toBeUndefined()
      await s.connect()
      expect(s.iceServers()).toEqual([{ urls: ['stun:127.0.0.1:3478'] }])
      expect(seen).toEqual([s.iceServers()])
    })

    it('attaches to an existing http server without taking over its requests', async () => {
      const http: Server = createServer((_req, res) => res.end('app'))
      defer(
        () =>
          new Promise(resolve => {
            http.closeAllConnections()
            http.close(resolve)
          })
      )
      const pending = relay({ server: http, path: '/relay' })
      http.listen(0, '127.0.0.1')
      const r = await pending
      const { port } = http.address() as AddressInfo
      expect(r.port).toBe(port)
      expect(r.url).toBe(`ws://127.0.0.1:${port}/relay`)
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).toBe('app')

      const box = inbox()
      await signaler(r, bob).listen(box.fn)
      const e = env()
      await signaler(r, alice).send(bob.key, e)
      expect(await box.next()).toEqual([alice.key, e])

      await r.close()
      expect(http.listening).toBe(true)
    })

    it('closes every socket and stops listening on close', async () => {
      const r = await createRelayServer({ port: 0, host: '127.0.0.1' })
      const a = raw(r.url)
      await authenticate(a, alice, r.url)
      await a.next()
      await r.close()
      expect(await a.closed).toBe(1001)
      expect(await upgradeError(r.url)).toContain('ECONNREFUSED')
    })
  })

  describe('RelaySignaler', () => {
    it('delivers an envelope with the authenticated sender', async () => {
      const r = await relay()
      const box = inbox()
      const b = signaler(r, bob)
      await b.listen(box.fn)
      const e = env()
      await signaler(r, alice).send(bob.key, e)
      expect(await box.next()).toEqual([alice.key, e])
      expect(r.stats()).toEqual({ sockets: 2, identities: 2 })
    })

    it('carries a sealed offer and answer end to end', async () => {
      const r = await relay()
      const a = signaler(r, alice)
      const b = signaler(r, bob)
      const aBox = inbox()
      const bBox = inbox()
      await a.listen(aBox.fn)
      await b.listen(bBox.fn)

      const sid = newSid()
      const offer = await sealSignal(alice.wallet, {
        v: 1,
        kind: 'offer',
        sid,
        from: alice.key,
        to: bob.key,
        ts: Date.now(),
        purpose: 'payment',
        sdp: SDP
      })
      await a.send(bob.key, offer)
      const [offerFrom, offerEnv] = await bBox.next()
      await expect(
        openSignal(bob.wallet, offerFrom, offerEnv, { me: bob.key, replay: new ReplayCache() })
      ).resolves.toMatchObject({ kind: 'offer', sid, from: alice.key, to: bob.key, sdp: SDP })

      const answer = await sealSignal(bob.wallet, {
        v: 1,
        kind: 'answer',
        sid,
        from: bob.key,
        to: alice.key,
        ts: Date.now(),
        purpose: 'payment',
        sdp: SDP + 'a=setup:active\r\n'
      })
      await b.send(alice.key, answer)
      const [answerFrom, answerEnv] = await aBox.next()
      await expect(
        openSignal(alice.wallet, answerFrom, answerEnv, {
          me: alice.key,
          replay: new ReplayCache()
        })
      ).resolves.toMatchObject({ kind: 'answer', sid, from: bob.key, to: alice.key })
    })

    it('delivers to every listener and every socket of the recipient', async () => {
      const r = await relay()
      const one = inbox()
      const two = inbox()
      const three = inbox()
      const b1 = signaler(r, bob)
      await b1.listen(one.fn)
      await b1.listen(two.fn)
      await signaler(r, bob).listen(three.fn)
      const e = env()
      await signaler(r, alice).send(bob.key, e)
      for (const box of [one, two, three]) expect(await box.next()).toEqual([alice.key, e])
    })

    it('rejects peer_unreachable for a recipient that is not connected', async () => {
      const r = await relay()
      const p = signaler(r, alice).send(bob.key, env())
      await expect(p).rejects.toBeInstanceOf(WebRTPayError)
      await expect(p).rejects.toMatchObject({ code: 'peer_unreachable' })
    })

    it('goes offline once its last listener unsubscribes', async () => {
      const r = await relay()
      const b = signaler(r, bob)
      const stop = await b.listen(() => {})
      const a = signaler(r, alice)
      await a.send(bob.key, env())
      await stop()
      // alice only held her socket for the send, so both are gone
      await waitFor(() => r.stats().sockets === 0)
      await expect(a.send(bob.key, env())).rejects.toMatchObject({ code: 'peer_unreachable' })
    })

    it('forwards the largest envelope a signal may carry and refuses more bytes (M25)', async () => {
      const r = await relay()
      const box = inbox()
      await signaler(r, bob).listen(box.fn)
      const a = signaler(r, alice)

      // the largest well-formed envelope: a 64-character sid and the longest ciphertext
      const largest = {
        v: 1 as const,
        sid: 's'.repeat(64),
        ciphertext: 'A'.repeat(MAX_SIGNAL_CIPHERTEXT_CHARS)
      }
      expect(DEFAULT_RELAY_LIMITS.maxEnvelopeBytes).toBe(JSON.stringify(largest).length)
      await a.send(bob.key, largest)
      expect(await box.next()).toEqual([alice.key, largest])

      // an offer with the longest SDP a signal allows
      const lines = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0']
      while (lines.join('\r\n').length < MAX_SIGNAL_SDP_CHARS - 64) {
        lines.push(`a=candidate:${lines.length} 1 udp 2130706431 192.0.2.1 50000 typ host`)
      }
      const sdp = (lines.join('\r\n') + '\r\na=x:').padEnd(MAX_SIGNAL_SDP_CHARS, 'x')
      expect(sdp).toHaveLength(MAX_SIGNAL_SDP_CHARS)
      const offer = await sealSignal(alice.wallet, {
        v: 1,
        kind: 'offer',
        sid: newSid(),
        from: alice.key,
        to: bob.key,
        ts: Date.now(),
        purpose: 'payment',
        sdp
      })
      await a.send(bob.key, offer)
      expect((await box.next())[1]).toEqual(offer)

      // as many characters, more bytes: a sid of two-byte characters
      await expect(a.send(bob.key, { ...largest, sid: 'é'.repeat(64) })).rejects.toMatchObject({
        code: 'too_large'
      })
      // a ciphertext one character longer is not an envelope at all
      await expect(
        a.send(bob.key, { ...largest, ciphertext: `${largest.ciphertext}A` })
      ).rejects.toMatchObject({ code: 'protocol' })
      expect(box.got).toHaveLength(2)
    })

    it('rate limits a socket to 20 messages per 10 seconds', async () => {
      const r = await relay({ limits: { signalsPerPairPerMinute: 100 } })
      const box = inbox()
      await signaler(r, bob).listen(box.fn)
      const a = signaler(r, alice)
      await a.connect()
      const results = await Promise.allSettled(
        Array.from({ length: 25 }, () => a.send(bob.key, env()))
      )
      const sent = results.filter(x => x.status === 'fulfilled')
      const limited = results.filter(x => x.status === 'rejected')
      expect(limited.length).toBeGreaterThan(0)
      for (const x of limited) {
        expect((x as PromiseRejectedResult).reason).toMatchObject({ code: 'rate_limited' })
      }
      // the auth frame spent one of the 20 tokens
      expect(sent.length).toBeGreaterThanOrEqual(19)
      expect(sent.length).toBeLessThanOrEqual(20)
      await waitFor(() => box.got.length === sent.length)
    })

    it('rejects auth_failed when the relay expects a different public url', async () => {
      const r = await relay({ publicUrls: ['wss://relay.example'] })
      await expect(signaler(r, alice).connect()).rejects.toMatchObject({ code: 'auth_failed' })
      await waitFor(() => r.stats().sockets === 0)
      expect(r.stats()).toEqual({ sockets: 0, identities: 0 })
    })

    it('tells onStateChange why a listener is offline: auth_failed for a public url it did not dial', async () => {
      const r = await relay({ publicUrls: ['wss://relay.example'] })
      const changes: Array<[string, unknown]> = []
      const b = signaler(r, bob, {
        random: () => 0.99,
        onStateChange: (state, error) => changes.push([state, error])
      })
      await b.listen(() => {})
      expect(changes).toEqual([
        ['connecting', undefined],
        ['offline', expect.objectContaining({ code: 'auth_failed' })]
      ])
      expect(changes[1][1]).toBeInstanceOf(WebRTPayError)
    })

    it('rejects peer_unreachable when no relay is listening', async () => {
      const url = `ws://127.0.0.1:${await freePort()}`
      await expect(signaler(url, alice).connect()).rejects.toMatchObject({
        code: 'peer_unreachable'
      })
      await expect(signaler(url, alice).send(bob.key, env())).rejects.toMatchObject({
        code: 'peer_unreachable'
      })
      await expect(signaler(url, alice).requestTurn()).rejects.toMatchObject({
        code: 'peer_unreachable'
      })
    })

    it('keeps a listener subscribed while the relay is unreachable and connects once it is up', async () => {
      const port = await freePort()
      const states: string[] = []
      const box = inbox()
      const b = signaler(`ws://127.0.0.1:${port}`, bob, {
        random: () => 0.1,
        onStateChange: state => states.push(state)
      })
      // resolves although nothing listens on the port yet
      const stop = await b.listen(box.fn)
      expect(states).toEqual(['connecting', 'offline'])

      const r = await relay({ port })
      await waitFor(() => states.at(-1) === 'online')
      expect(r.stats().identities).toBe(1)
      const e = env()
      await signaler(r, alice).send(bob.key, e)
      expect(await box.next()).toEqual([alice.key, e])

      await stop()
      expect(states.at(-1)).toBe('offline')
      await waitFor(() => r.stats().identities === 0)
    })

    it('reports empty ice servers when the relay has none configured', async () => {
      const r = await relay()
      const s = signaler(r, alice)
      await s.connect()
      expect(s.iceServers()).toEqual([])
    })

    it('reconnects a listener after the relay restarts', async () => {
      const first = await createRelayServer({ port: 0, host: '127.0.0.1' })
      const port = first.port
      const box = inbox()
      await signaler(first, bob).listen(box.fn)
      await first.close()

      const second = await relay({ port })
      await waitFor(() => second.stats().identities === 1)
      const e = env()
      await signaler(second, alice).send(bob.key, e)
      expect(await box.next()).toEqual([alice.key, e])
    })

    it('is finished after close', async () => {
      const r = await relay()
      const s = signaler(r, alice)
      await s.listen(() => {})
      await s.close()
      await waitFor(() => r.stats().sockets === 0)
      await expect(s.connect()).rejects.toMatchObject({ code: 'closed' })
      await expect(s.send(bob.key, env())).rejects.toMatchObject({ code: 'closed' })
      await expect(s.listen(() => {})).rejects.toMatchObject({ code: 'closed' })
      await s.close()
    })

    it('isolates a throwing listener', async () => {
      const r = await relay()
      const box = inbox()
      const b = signaler(r, bob)
      await b.listen(() => {
        throw new Error('boom')
      })
      await b.listen(async () => {
        throw new Error('async boom')
      })
      await b.listen(box.fn)
      const e = env()
      await signaler(r, alice).send(bob.key, e)
      expect(await box.next()).toEqual([alice.key, e])
    })
  })
})

/**
 * A stand-in for the global `WebSocket` that plays the relay's side of the protocol
 * on promise jobs (not timers), so fake timers drive only the signaler's own clock.
 */
class FakeSocket {
  static instances: FakeSocket[] = []
  /**
   * up: full protocol; down: fails to connect; silent: never challenges; mute: never replies
   * to signals; confused: answers signals with `ice`, the reply to a `turn`; manual: never
   * challenges or replies, so the test plays the relay's side.
   */
  static mode: 'up' | 'down' | 'silent' | 'mute' | 'confused' | 'manual' = 'up'
  /** The servers a `turn` request is answered with. */
  static turnServers: RTCIceServer[] = []
  /** When set, a `turn` request is answered with this error code instead. */
  static turnError: string | undefined
  /** When set, the `ice` answering a `turn` request carries it as `expiresAt`. */
  static turnExpiresAt: unknown

  readyState = 0
  private readonly manual = FakeSocket.mode === 'manual'
  readonly frames: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>()

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
    const mode = FakeSocket.mode
    void Promise.resolve().then(() => {
      if (mode === 'down') {
        this.fire('error', {})
        this.finish(1006)
        return
      }
      this.readyState = 1
      this.fire('open', {})
      if (mode !== 'silent' && mode !== 'manual')
        this.message({ t: 'challenge', nonce: `n${FakeSocket.instances.length}` })
    })
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    let set = this.listeners.get(type)
    if (set === undefined) this.listeners.set(type, (set = new Set()))
    set.add(fn)
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn)
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>
    this.frames.push(frame)
    if (this.manual) return
    void Promise.resolve().then(() => {
      if (frame.t === 'auth') {
        this.message({ t: 'ready', identityKey: frame.identityKey })
        this.message({ t: 'ice', iceServers: [] })
      } else if (frame.t === 'turn') {
        if (FakeSocket.turnError !== undefined) {
          this.message({ t: 'error', code: FakeSocket.turnError })
        } else {
          const expiresAt = FakeSocket.turnExpiresAt
          this.message({
            t: 'ice',
            iceServers: FakeSocket.turnServers,
            ...(expiresAt === undefined ? {} : { expiresAt })
          })
        }
      } else if (frame.t === 'signal' && FakeSocket.mode === 'confused') {
        this.message({ t: 'ice', iceServers: [] })
      } else if (frame.t === 'signal' && FakeSocket.mode !== 'mute') {
        this.message({ t: 'sent', ref: (frame.envelope as SignalEnvelope).sid })
      }
    })
  }

  close(code = 1000): void {
    if (this.readyState >= 2) return
    this.readyState = 2
    void Promise.resolve().then(() => this.finish(code))
  }

  /** The connection drops without a closing handshake. */
  drop(): void {
    this.finish(1006)
  }

  /** Deliver `frame` as if the relay had sent it. */
  message(frame: unknown): void {
    this.messageData(JSON.stringify(frame))
  }

  /** Deliver `data` as the relay's message event, whatever it is. */
  messageData(data: unknown): void {
    if (this.readyState === 1) this.fire('message', { data })
  }

  private finish(code: number): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.fire('close', { code, reason: '' })
  }

  private fire(type: string, ev: unknown): void {
    for (const fn of Array.from(this.listeners.get(type) ?? [])) fn(ev)
  }
}

describe('RelaySignaler connection lifecycle', () => {
  let alice: Party
  const URL = 'ws://relay.test'

  beforeAll(async () => {
    alice = await party()
  })

  beforeEach(() => {
    FakeSocket.instances = []
    FakeSocket.mode = 'up'
    FakeSocket.turnServers = []
    FakeSocket.turnError = undefined
    FakeSocket.turnExpiresAt = undefined
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function fake(o: Partial<RelaySignalerOptions> = {}): RelaySignaler {
    return new RelaySignaler({
      url: URL,
      wallet: alice.wallet,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      ...o
    })
  }

  function last(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1]
  }

  it('signs the configured url and sends the hex signature', async () => {
    const s = fake({ url: `${URL}/` })
    await s.connect()
    const auth = FakeSocket.instances[0].frames[0]
    expect(FakeSocket.instances[0].url).toBe(`${URL}/`)
    expect(auth).toEqual({ t: 'auth', identityKey: alice.key, signature: expect.any(String) })
    await expect(
      new ProtoWallet('anyone').verifySignature({
        data: relayAuthData(URL, 'n1'),
        signature: Array.from(Buffer.from(auth.signature as string, 'hex')),
        protocolID: RELAY_PROTOCOL_ID,
        keyID: 'n1',
        counterparty: alice.key
      })
    ).resolves.toEqual({ valid: true })
    await s.close()
  })

  it('reconnects after a random share of a backoff cap that doubles per failure up to 30 s', async () => {
    const s = fake({ random: () => 0.5 })
    const stop = await s.listen(() => {})
    expect(FakeSocket.instances).toHaveLength(1)

    // The first connection was up for less than 30 s, so its drop counts as a failure.
    FakeSocket.mode = 'down'
    last().drop()
    const caps = [2000, 4000, 8000, 16000, 30000, 30000]
    for (const [i, cap] of caps.entries()) {
      await jest.advanceTimersByTimeAsync(cap / 2 - 1)
      expect(FakeSocket.instances).toHaveLength(i + 1)
      await jest.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(i + 2)
    }

    await stop()
    await s.close()
  })

  it('draws a fresh delay anywhere below the cap for every attempt (full jitter)', async () => {
    // one draw per ended connection, in order
    const draws = [0, 0.999, 0.25]
    const s = fake({ random: () => draws.shift() ?? 0.5 })
    const stop = await s.listen(() => {})
    FakeSocket.mode = 'down'
    last().drop() // cap 2 s, draw 0: no wait
    await jest.advanceTimersByTimeAsync(0)
    expect(FakeSocket.instances).toHaveLength(2)
    // that attempt failed: cap 4 s, draw 0.999
    await jest.advanceTimersByTimeAsync(3995)
    expect(FakeSocket.instances).toHaveLength(2)
    await jest.advanceTimersByTimeAsync(1)
    expect(FakeSocket.instances).toHaveLength(3)
    // cap 8 s, draw 0.25
    await jest.advanceTimersByTimeAsync(1999)
    expect(FakeSocket.instances).toHaveLength(3)
    await jest.advanceTimersByTimeAsync(1)
    expect(FakeSocket.instances).toHaveLength(4)
    expect(draws).toEqual([])

    await stop()
    await s.close()
  })

  it('starts the backoff over only after a connection stayed authenticated for 30 s', async () => {
    const connected: number[] = []
    const s = fake({ random: () => 0.5, onIceServers: () => connected.push(Date.now()) })
    const stop = await s.listen(() => {})
    await waitForFake(() => connected.length === 1)

    /** Drop the current connection after `upMs` and expect the next attempt `delay` ms later. */
    async function dropAfter(upMs: number, delay: number): Promise<void> {
      await jest.advanceTimersByTimeAsync(upMs)
      const n = FakeSocket.instances.length
      const was = connected.length
      last().drop()
      await jest.advanceTimersByTimeAsync(delay - 1)
      expect(FakeSocket.instances).toHaveLength(n)
      await jest.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(n + 1)
      await waitForFake(() => connected.length === was + 1)
    }

    await dropAfter(30000, 500) // stable: cap back to 1 s
    await dropAfter(0, 1000) // dropped right after ready: a failure, cap 2 s
    await dropAfter(29999, 2000) // still short of 30 s: cap 4 s
    await dropAfter(30000, 500) // stable again

    await stop()
    await s.close()
  })

  it('resolves listen while the relay is down and keeps reconnecting with the jittered backoff', async () => {
    FakeSocket.mode = 'down'
    const states: string[] = []
    const s = fake({ random: () => 0.5, onStateChange: state => states.push(state) })
    const stop = await s.listen(() => {})
    expect(FakeSocket.instances).toHaveLength(1)
    expect(states).toEqual(['connecting', 'offline'])

    // caps 2, 4 and 8 s after the first, second and third failure; drawn at half of each
    for (const [i, cap] of [2000, 4000, 8000].entries()) {
      if (i === 2) FakeSocket.mode = 'up'
      await jest.advanceTimersByTimeAsync(cap / 2 - 1)
      expect(FakeSocket.instances).toHaveLength(i + 1)
      await jest.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(i + 2)
    }
    await waitForFake(() => states.at(-1) === 'online')
    expect(states).toEqual([
      'connecting',
      'offline',
      'connecting',
      'offline',
      'connecting',
      'offline',
      'connecting',
      'online'
    ])

    await stop()
    await s.close()
    expect(states.at(-1)).toBe('offline')
  })

  it('reports connecting, online and offline through onStateChange', async () => {
    const states: string[] = []
    const s = fake({
      random: () => 0,
      onStateChange: state => {
        states.push(state)
        throw new Error('a throwing callback changes nothing')
      }
    })
    const stop = await s.listen(() => {})
    expect(states).toEqual(['connecting', 'online'])
    last().drop()
    expect(states).toEqual(['connecting', 'online', 'offline'])
    await waitForFake(() => states.length === 5)
    expect(states.slice(3)).toEqual(['connecting', 'online'])

    await stop() // the last listener: the connection is closed
    expect(states).toHaveLength(6)
    expect(states.at(-1)).toBe('offline')
    await s.send(alice.key, env()) // a send opens a connection of its own and closes it again
    expect(states.slice(6)).toEqual(['connecting', 'online', 'offline'])
    await s.close()
    expect(states).toHaveLength(9)
  })

  it('keeps signaling when onIceServers or onStateChange throws, and reports it (R6)', async () => {
    const reported: unknown[] = []
    const iceBug = new Error('app bug in onIceServers')
    const stateBug = new Error('app bug in onStateChange')
    const expiry = Math.floor(Date.now() / 1000) + 600
    FakeSocket.turnServers = [
      { urls: 'turn:turn.test:3478', username: `${expiry}:u`, credential: 'c' }
    ]
    const s = fake({
      onIceServers: () => {
        throw iceBug
      },
      onStateChange: () => {
        throw stateBug
      },
      onCallbackError: e => {
        reported.push(e)
        throw new Error('a throwing error hook changes nothing either')
      }
    })
    let listening = false
    void s.listen(() => {}).then(() => (listening = true))
    await waitForFake(() => listening)
    expect(s.iceServers()).toEqual([])
    await s.send(alice.key, env())
    expect(await s.requestTurn()).toEqual(FakeSocket.turnServers)
    expect(reported.filter(e => e === iceBug)).toHaveLength(2) // on connecting and on turn
    expect(reported).toContain(stateBug)
    await s.close()
  })

  it('passes onStateChange the error that ended the connection when it goes offline on its own', async () => {
    const changes: Array<[string, unknown]> = []
    const s = fake({
      random: () => 0,
      onStateChange: (state, error) => changes.push([state, error])
    })
    const ended = (message: string) => [
      'offline',
      expect.objectContaining({ code: 'peer_unreachable', message })
    ]
    FakeSocket.mode = 'down'
    const stop = await s.listen(() => {})
    expect(changes).toEqual([['connecting', undefined], ended('Could not connect to the relay')])
    expect(changes[1][1]).toBeInstanceOf(WebRTPayError)

    FakeSocket.mode = 'up'
    await waitForFake(() => changes.length === 4)
    expect(changes.slice(2)).toEqual([
      ['connecting', undefined],
      ['online', undefined]
    ])
    last().drop()
    expect(changes[4]).toEqual(ended('Relay connection closed'))
    await waitForFake(() => changes.at(-1)?.[0] === 'online')

    // a connection closed on purpose ended with no error
    await stop()
    expect(changes.at(-1)).toEqual(['offline', undefined])
    await s.connect()
    await s.close()
    expect(changes.at(-1)).toEqual(['offline', undefined])
  })

  it('ends the connection with protocol when a reply does not match the request it answers', async () => {
    const s = fake()
    await s.connect()
    FakeSocket.mode = 'confused'
    await expect(s.send(alice.key, env())).rejects.toMatchObject({ code: 'protocol' })
    await jest.advanceTimersByTimeAsync(0)
    expect(last().readyState).toBe(3)

    // a reply that arrives with no request outstanding ends the connection too
    FakeSocket.mode = 'up'
    await s.send(alice.key, env())
    expect(FakeSocket.instances).toHaveLength(2)
    last().message({ t: 'sent' })
    await jest.advanceTimersByTimeAsync(0)
    expect(last().readyState).toBe(3)
    await s.send(alice.key, env())
    expect(FakeSocket.instances).toHaveLength(3)
    last().message({ t: 'error', code: 'rate_limited' })
    await jest.advanceTimersByTimeAsync(0)
    expect(last().readyState).toBe(3)
    await s.close()
  })

  describe('TURN credentials', () => {
    const stun = { urls: ['stun:relay.test:3478'] }
    /** TURN with a coturn REST username that expires at `expiry` (Unix seconds). */
    const turn = (expiry: number): RTCIceServer => ({
      urls: ['turn:relay.test:3478'],
      username: `${expiry}:pseudonym`,
      credential: 'c'
    })
    const T0 = 1_790_000_000_000

    /** `turn` requests sent over every connection so far. */
    function turnRequests(): number {
      return FakeSocket.instances.flatMap(i => i.frames).filter(f => f.t === 'turn').length
    }

    beforeEach(() => {
      jest.setSystemTime(T0)
    })

    it('drops TURN servers from iceServers() 30 s before their REST credentials expire', async () => {
      const unparsed = { urls: 'turns:relay.test:5349', username: 'static', credential: 'c' }
      FakeSocket.turnServers = [stun, turn(1_790_000_060), unparsed]
      const s = fake()
      await s.connect()
      expect(await s.requestTurn()).toEqual(FakeSocket.turnServers)
      expect(s.iceServers()).toEqual(FakeSocket.turnServers)

      await jest.advanceTimersByTimeAsync(29_999)
      expect(s.iceServers()).toEqual(FakeSocket.turnServers)
      // a gather and the allocation it starts must fit before coturn refuses the credentials
      await jest.advanceTimersByTimeAsync(1)
      expect(s.iceServers()).toEqual([stun, unparsed])
      await s.close()
    })

    it('turnProvider asks the relay once for concurrent calls and reuses the servers until 30 s before they expire', async () => {
      FakeSocket.turnServers = [stun, turn(1_790_000_600)]
      const s = fake()
      const provide = s.turnProvider()
      const [a, b] = await Promise.all([provide(), provide()])
      expect(turnRequests()).toBe(1)
      expect(a).toEqual(FakeSocket.turnServers)
      expect(b).toEqual(FakeSocket.turnServers)
      // callers get copies they may change
      a[0].urls = 'stun:changed.test'
      expect(await provide()).toEqual(FakeSocket.turnServers)
      expect(turnRequests()).toBe(1)

      await jest.advanceTimersByTimeAsync(569_999)
      expect(await provide()).toEqual(FakeSocket.turnServers)
      expect(turnRequests()).toBe(1)
      await jest.advanceTimersByTimeAsync(1)
      FakeSocket.turnServers = [stun, turn(1_790_001_170)]
      expect(await provide()).toEqual(FakeSocket.turnServers)
      expect(turnRequests()).toBe(2)
      // every provider of a signaler shares its servers
      expect(await s.turnProvider()()).toEqual(FakeSocket.turnServers)
      expect(turnRequests()).toBe(2)
      await s.close()
    })

    it('turnProvider keeps its TURN servers across connections, which reset iceServers() to STUN', async () => {
      FakeSocket.turnServers = [stun, turn(1_790_000_600)]
      const s = fake()
      const provide = s.turnProvider()
      expect(await provide()).toEqual(FakeSocket.turnServers)
      // the connection opened only for the request is closed again
      await jest.advanceTimersByTimeAsync(0)
      expect(last().readyState).toBe(3)

      // a dial opens a new connection, whose ice frame lists STUN only
      await s.send(alice.key, env())
      expect(FakeSocket.instances).toHaveLength(2)
      expect(s.iceServers()).toEqual([])
      expect(await provide()).toEqual(FakeSocket.turnServers)
      expect(turnRequests()).toBe(1)
      await s.close()
    })

    /** TURN as Cloudflare issues it: hex credentials with no expiry inside. */
    const opaque: RTCIceServer = {
      urls: ['turn:turn.example:3478?transport=udp'],
      username: 'ab'.repeat(48),
      credential: 'cd'.repeat(48)
    }

    it('drops TURN servers 30 s before the expiresAt of the ice frame that listed them', async () => {
      FakeSocket.turnServers = [stun, opaque]
      FakeSocket.turnExpiresAt = T0 + 60_000
      const s = fake()
      await s.connect()
      expect(await s.requestTurn()).toEqual(FakeSocket.turnServers)
      expect(s.iceServers()).toEqual(FakeSocket.turnServers)

      await jest.advanceTimersByTimeAsync(29_999)
      expect(s.iceServers()).toEqual(FakeSocket.turnServers)
      await jest.advanceTimersByTimeAsync(1)
      expect(s.iceServers()).toEqual([stun])
      await s.close()
    })

    it('turnProvider goes by expiresAt rather than the expiry in a coturn REST username', async () => {
      // the username says an hour, the relay says a minute
      FakeSocket.turnServers = [stun, turn(1_790_003_600)]
      FakeSocket.turnExpiresAt = T0 + 60_000
      const s = fake()
      const provide = s.turnProvider()
      expect(await provide()).toEqual(FakeSocket.turnServers)
      await jest.advanceTimersByTimeAsync(29_999)
      expect(await provide()).toEqual(FakeSocket.turnServers)
      expect(turnRequests()).toBe(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(s.iceServers()).toEqual([stun])
      expect(await provide()).toEqual(FakeSocket.turnServers)
      expect(turnRequests()).toBe(2)
      await s.close()
    })

    it('refuses a turn answer whose expiresAt is not a time, and stays connected', async () => {
      FakeSocket.turnServers = [stun, opaque]
      const s = fake()
      await s.connect()
      for (const expiresAt of ['soon', -1, 0, 1.5, null, 2 ** 53]) {
        FakeSocket.turnExpiresAt = expiresAt
        await expect(s.requestTurn()).rejects.toMatchObject({ code: 'protocol' })
      }
      FakeSocket.turnExpiresAt = T0 + 60_000
      expect(await s.requestTurn()).toEqual(FakeSocket.turnServers)
      expect(FakeSocket.instances).toHaveLength(1)
      await s.close()
    })

    it('rejects unavailable when the relay could not get TURN credentials, and stays connected', async () => {
      FakeSocket.turnServers = [stun, opaque]
      FakeSocket.turnError = 'unavailable'
      const s = fake()
      await s.connect()
      const failed = s.requestTurn()
      await expect(failed).rejects.toBeInstanceOf(WebRTPayError)
      await expect(failed).rejects.toMatchObject({ code: 'unavailable' })
      FakeSocket.turnError = undefined
      expect(await s.requestTurn()).toEqual(FakeSocket.turnServers)
      expect(FakeSocket.instances).toHaveLength(1)
      await s.close()
    })

    it('turnProvider asks again after a failed request, and rejects closed after close', async () => {
      FakeSocket.turnServers = [stun, turn(1_790_000_600)]
      FakeSocket.turnError = 'rate_limited'
      const s = fake()
      const provide = s.turnProvider()
      const failed = await Promise.allSettled([provide(), provide()])
      expect(failed.map(r => r.status)).toEqual(['rejected', 'rejected'])
      expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'rate_limited' })
      expect(turnRequests()).toBe(1)

      FakeSocket.turnError = undefined
      expect(await provide()).toEqual(FakeSocket.turnServers)
      expect(turnRequests()).toBe(2)
      // a relay without TURN answers with STUN only: nothing to keep, so it is asked each time
      FakeSocket.turnServers = [stun]
      jest.setSystemTime(T0 + 600_000)
      expect(await provide()).toEqual([stun])
      expect(await provide()).toEqual([stun])
      expect(turnRequests()).toBe(4)

      await s.close()
      await expect(provide()).rejects.toMatchObject({ code: 'closed' })
      expect(turnRequests()).toBe(4)
    })
  })

  it('stops reconnecting once the last listener unsubscribes', async () => {
    const s = fake({ random: () => 0.5 })
    const stop = await s.listen(() => {})
    FakeSocket.mode = 'down'
    last().drop()
    await jest.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.instances).toHaveLength(2)
    await stop()
    await jest.advanceTimersByTimeAsync(120000)
    expect(FakeSocket.instances).toHaveLength(2)
    await s.close()
  })

  it('closes a connection it only opened to send, and does not reconnect it', async () => {
    const s = fake()
    await s.send(alice.key, env())
    await jest.advanceTimersByTimeAsync(0)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(last().readyState).toBe(3)
    await jest.advanceTimersByTimeAsync(120000)
    expect(FakeSocket.instances).toHaveLength(1)
    await s.close()
  })

  it('keeps an explicit connect open without reconnecting it, and reopens on demand', async () => {
    const s = fake()
    await s.connect()
    await s.send(alice.key, env())
    await jest.advanceTimersByTimeAsync(0)
    expect(last().readyState).toBe(1)
    last().drop()
    await jest.advanceTimersByTimeAsync(120000)
    expect(FakeSocket.instances).toHaveLength(1)
    await s.send(alice.key, env())
    expect(FakeSocket.instances).toHaveLength(2)
    await s.close()
    expect(last().readyState).toBe(3)
  })

  it('shares one connection between concurrent callers', async () => {
    const s = fake()
    await Promise.all([s.connect(), s.listen(() => {}), s.send(alice.key, env())])
    expect(FakeSocket.instances).toHaveLength(1)
    await s.close()
  })

  it('ignores relay frames that are not JSON objects or come out of turn during the handshake', async () => {
    FakeSocket.mode = 'manual'
    const s = fake()
    const p = s.connect()
    await jest.advanceTimersByTimeAsync(0)
    const sock = last()
    for (const data of ['not json', new Uint8Array([123, 125]), '[1]', '"challenge"', 'null']) {
      sock.messageData(data)
    }
    // replies, signals and `ready`/`ice` before the challenge was answered are ignored
    sock.message({ t: 'sent' })
    sock.message({ t: 'signal', from: alice.key, envelope: env() })
    sock.message({ t: 'ready', identityKey: alice.key })
    sock.message({ t: 'ice', iceServers: [] })
    sock.message({ t: 'challenge', nonce: 'n1' })
    // a second challenge while the first is being signed is ignored too
    sock.message({ t: 'challenge', nonce: 'n2' })
    await waitForFake(() => sock.frames.length === 1)
    expect(sock.frames[0]).toMatchObject({ t: 'auth', identityKey: alice.key })
    // `ice` before `ready` is ignored
    sock.message({ t: 'ice', iceServers: [{ urls: 'stun:early.test' }] })
    sock.message({ t: 'ready', identityKey: alice.key })
    sock.message({ t: 'ice', iceServers: [{ urls: 'stun:relay.test' }] })
    await p
    expect(s.iceServers()).toEqual([{ urls: 'stun:relay.test' }])
    expect(sock.frames).toHaveLength(1)
    await s.close()
  })

  it('fails the handshake with protocol on a malformed challenge', async () => {
    FakeSocket.mode = 'manual'
    for (const nonce of ['', 'x'.repeat(257), 7]) {
      const s = fake()
      const p = s.connect()
      const settled = expect(p).rejects.toMatchObject({
        code: 'protocol',
        message: 'Relay sent a malformed challenge'
      })
      await jest.advanceTimersByTimeAsync(0)
      last().message({ t: 'challenge', nonce })
      await settled
      expect(last().frames).toHaveLength(0)
      await s.close()
    }
    // the longest nonce accepted is 256 characters
    const s = fake()
    const p = s.connect()
    await jest.advanceTimersByTimeAsync(0)
    last().message({ t: 'challenge', nonce: 'x'.repeat(256) })
    await waitForFake(() => last().frames.length === 1)
    last().message({ t: 'ready', identityKey: alice.key })
    last().message({ t: 'ice', iceServers: [] })
    await p
    await s.close()
  })

  it('fails the handshake with protocol when the relay confirms a different identity', async () => {
    FakeSocket.mode = 'manual'
    const other = await party()
    const s = fake()
    const p = s.connect()
    const settled = expect(p).rejects.toMatchObject({
      code: 'protocol',
      message: 'Relay confirmed a different identity'
    })
    await jest.advanceTimersByTimeAsync(0)
    last().message({ t: 'challenge', nonce: 'n1' })
    await waitForFake(() => last().frames.length === 1)
    last().message({ t: 'ready', identityKey: other.key })
    await settled
    await jest.advanceTimersByTimeAsync(0)
    expect(last().readyState).toBe(3)
    await s.close()
  })

  it('fails the handshake with the mapped code when the relay sends an error, and protocol on bad ICE servers', async () => {
    FakeSocket.mode = 'manual'
    const s = fake()
    const p = s.connect()
    const refused = expect(p).rejects.toMatchObject({ code: 'rate_limited' })
    await jest.advanceTimersByTimeAsync(0)
    last().message({ t: 'error', code: 'rate_limited' })
    await refused
    await s.close()

    for (const ice of [
      { iceServers: 'stun:relay.test' },
      { iceServers: [], expiresAt: 0 },
      { iceServers: [], expiresAt: '1' }
    ]) {
      const t = fake()
      const q = t.connect()
      const bad = expect(q).rejects.toMatchObject({
        code: 'protocol',
        message: 'Relay sent bad ICE servers'
      })
      await jest.advanceTimersByTimeAsync(0)
      last().message({ t: 'challenge', nonce: 'n1' })
      await waitForFake(() => last().frames.length === 1)
      last().message({ t: 'ready', identityKey: alice.key })
      last().message({ t: 'ice', ...ice })
      await bad
      await t.close()
    }
  })

  it('gives up on a relay that does not complete the handshake within 15 s', async () => {
    FakeSocket.mode = 'silent'
    const s = fake()
    const p = s.connect()
    const settled = expect(p).rejects.toMatchObject({ code: 'peer_unreachable' })
    await jest.advanceTimersByTimeAsync(14999)
    expect(last().readyState).toBe(1)
    await jest.advanceTimersByTimeAsync(1)
    await settled
    await jest.advanceTimersByTimeAsync(0)
    expect(last().readyState).toBe(3)
    await s.close()
  })

  it('drops a connection whose relay does not confirm a send within 10 s', async () => {
    const s = fake()
    await s.connect()
    FakeSocket.mode = 'mute'
    const p = s.send(alice.key, env())
    const settled = expect(p).rejects.toMatchObject({ code: 'peer_unreachable' })
    await jest.advanceTimersByTimeAsync(9999)
    expect(last().readyState).toBe(1)
    await jest.advanceTimersByTimeAsync(1)
    await settled
    await jest.advanceTimersByTimeAsync(0)
    expect(last().readyState).toBe(3)
    await s.close()
  })

  it('rejects pending sends with closed when closed', async () => {
    const s = fake()
    await s.connect()
    FakeSocket.mode = 'mute'
    const p = s.send(alice.key, env())
    const settled = expect(p).rejects.toMatchObject({ code: 'closed' })
    await jest.advanceTimersByTimeAsync(0)
    await s.close()
    await settled
  })

  /** Let promise jobs run until `check` holds (the clock is fake, so no timers advance). */
  async function waitForFake(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) await jest.advanceTimersByTimeAsync(0)
    expect(check()).toBe(true)
  }
})

describe('relayOptionsFromEnv', () => {
  it('refuses a non-loopback HOST, the default 0.0.0.0 included, without PUBLIC_URLS', () => {
    for (const HOST of [undefined, '', '0.0.0.0', '::', '10.0.0.5', 'relay.example.com']) {
      expect(() => relayOptionsFromEnv({ HOST })).toThrow('PUBLIC_URLS is required')
    }
    // the hint covers a loopback relay behind a proxy too
    expect(() => relayOptionsFromEnv({})).toThrow('behind a proxy')
    expect(() => relayOptionsFromEnv({ PUBLIC_URLS: ' , ' })).toThrow('PUBLIC_URLS is required')
  })

  it('keeps the documented defaults: port 8787, every IPv4 interface, TURN for 600 s', () => {
    // README "Relay server" lists these values; the relay and --help take them from here
    expect(DEFAULT_RELAY_PORT).toBe(8787)
    expect(DEFAULT_HOST).toBe('0.0.0.0')
    expect(DEFAULT_TURN_TTL_SECONDS).toBe(600)
  })

  it('defaults to DEFAULT_RELAY_PORT on DEFAULT_HOST when PUBLIC_URLS is set', () => {
    expect(relayOptionsFromEnv({ PUBLIC_URLS: 'wss://relay.example' })).toEqual({
      port: DEFAULT_RELAY_PORT,
      host: DEFAULT_HOST,
      publicUrls: ['wss://relay.example']
    })
  })

  it('allows a loopback HOST without PUBLIC_URLS', () => {
    for (const HOST of ['127.0.0.1', 'localhost', '::1']) {
      expect(relayOptionsFromEnv({ HOST })).toEqual({ port: DEFAULT_RELAY_PORT, host: HOST })
    }
  })

  it('reads the listen address, public urls, STUN urls and TURN settings', () => {
    expect(
      relayOptionsFromEnv({
        PORT: '9000',
        HOST: '127.0.0.1',
        PUBLIC_URLS: 'wss://a.example, wss://b.example/ ,',
        STUN_URLS: 'stun:a.example:3478',
        TURN_SECRET: 'secret',
        TURN_URLS: 'turn:a.example:3478,turns:a.example:5349',
        TURN_TTL: '600',
        TRUSTED_IP_HEADER: ' CF-Connecting-IP '
      })
    ).toEqual({
      port: 9000,
      host: '127.0.0.1',
      publicUrls: ['wss://a.example', 'wss://b.example/'],
      trustedIpHeader: 'CF-Connecting-IP',
      stunUrls: ['stun:a.example:3478'],
      turn: {
        kind: 'coturn-rest',
        secret: 'secret',
        urls: ['turn:a.example:3478', 'turns:a.example:5349'],
        ttlSeconds: 600
      }
    })
  })

  it('reads the per-source TURN budget from TURN_PER_IP_PER_HOUR, leaving the default 6 when unset', () => {
    const turn = { HOST: '127.0.0.1', TURN_SECRET: 's', TURN_URLS: 'turn:a.example:3478' }
    expect(relayOptionsFromEnv({ ...turn, TURN_PER_IP_PER_HOUR: ' 600 ' })).toMatchObject({
      turn: { secret: 's', urls: ['turn:a.example:3478'] },
      limits: { turnPerIpPerHour: 600 }
    })
    for (const unset of [undefined, '']) {
      expect(relayOptionsFromEnv({ ...turn, TURN_PER_IP_PER_HOUR: unset })).not.toHaveProperty(
        'limits'
      )
    }
    expect(DEFAULT_RELAY_LIMITS.turnPerIpPerHour).toBe(6)
    for (const TURN_PER_IP_PER_HOUR of ['0', '-1', '1.5', 'many']) {
      expect(() => relayOptionsFromEnv({ ...turn, TURN_PER_IP_PER_HOUR })).toThrow(
        'TURN_PER_IP_PER_HOUR must be a whole number'
      )
    }
    // a TURN budget without TURN to spend it on is a configuration mistake
    expect(() => relayOptionsFromEnv({ HOST: '127.0.0.1', TURN_PER_IP_PER_HOUR: '600' })).toThrow(
      'TURN_SECRET is required'
    )
  })

  it('passes TURN_PER_IP_PER_HOUR to the relay, which then issues that many per address', async () => {
    const r = await createRelayServer({
      ...relayOptionsFromEnv({
        HOST: '127.0.0.1',
        PORT: '0',
        TURN_SECRET: 's',
        TURN_URLS: 'turn:a.example:3478',
        TURN_PER_IP_PER_HOUR: '7'
      }),
      log: () => {}
    })
    const p = await party()
    const s = new RelaySignaler({ url: r.url, wallet: p.wallet })
    try {
      for (let i = 0; i < 7; i++) await s.requestTurn()
      await expect(s.requestTurn()).rejects.toMatchObject({ code: 'rate_limited' })
    } finally {
      await s.close()
      await r.close()
    }
  })

  it('reads the per-source, per-recipient and relay-wide limits (M26)', () => {
    const at = { HOST: '127.0.0.1' }
    expect(
      relayOptionsFromEnv({
        ...at,
        MAX_SOCKETS: '20000',
        MAX_UNAUTHENTICATED_SOCKETS: ' 2000 ',
        SOCKETS_PER_IP: '200',
        CONNECTIONS_PER_IP_PER_MINUTE: '300',
        SOCKETS_PER_48: '800',
        CONNECTIONS_PER_48_PER_MINUTE: '1200',
        SIGNALS_PER_RECIPIENT_PER_MINUTE: '240',
        SIGNALS_PER_PAIR_PER_MINUTE: '12',
        MAX_OVER_RATE_FRAMES: '5'
      }).limits
    ).toEqual({
      maxSockets: 20000,
      maxUnauthenticatedSockets: 2000,
      maxSocketsPerIp: 200,
      connectionsPerIpPerMinute: 300,
      maxSocketsPer48: 800,
      connectionsPer48PerMinute: 1200,
      signalsPerRecipientPerMinute: 240,
      signalsPerPairPerMinute: 12,
      maxOverRateFrames: 5
    })
    const turn = { ...at, TURN_SECRET: 's', TURN_URLS: 'turn:a.example:3478' }
    expect(
      relayOptionsFromEnv({
        ...turn,
        TURN_PER_IP_PER_HOUR: '12',
        TURN_PER_48_PER_HOUR: '48',
        TURN_PER_HOUR: '6000'
      }).limits
    ).toEqual({ turnPerIpPerHour: 12, turnPer48PerHour: 48, turnPerHour: 6000 })
    for (const name of ['TURN_PER_48_PER_HOUR', 'TURN_PER_HOUR']) {
      expect(() => relayOptionsFromEnv({ ...at, [name]: '10' })).toThrow('TURN_SECRET is required')
    }
    for (const value of ['0', '-1', '1.5', 'many']) {
      expect(() => relayOptionsFromEnv({ ...at, SOCKETS_PER_IP: value })).toThrow(
        'SOCKETS_PER_IP must be a whole number'
      )
    }
  })

  it('passes the limits to the relay', async () => {
    const r = await createRelayServer({
      ...relayOptionsFromEnv({ HOST: '127.0.0.1', PORT: '0', SOCKETS_PER_IP: '1' }),
      log: () => {}
    })
    const first = raw(r.url)
    try {
      expect((await first.next()).t).toBe('challenge')
      expect(await upgradeError(r.url)).toContain('429')
    } finally {
      first.ws.terminate()
      await r.close()
    }
  })

  it('reads a Cloudflare TURN provider from TURN_PROVIDER=cloudflare', () => {
    const at = { HOST: '127.0.0.1' }
    expect(
      relayOptionsFromEnv({
        ...at,
        TURN_PROVIDER: ' cloudflare ',
        CLOUDFLARE_TURN_KEY_ID: ' 0123abcd ',
        // a secret mounted from a file often ends in a newline
        CLOUDFLARE_TURN_API_TOKEN: 'token-value\n',
        TURN_TTL: '900',
        TURN_PER_IP_PER_HOUR: '12'
      })
    ).toEqual({
      port: 8787,
      host: '127.0.0.1',
      turn: { kind: 'cloudflare', keyId: '0123abcd', apiToken: 'token-value', ttlSeconds: 900 },
      limits: { turnPerIpPerHour: 12 }
    })
    expect(
      relayOptionsFromEnv({
        ...at,
        TURN_PROVIDER: 'cloudflare',
        CLOUDFLARE_TURN_KEY_ID: 'k',
        CLOUDFLARE_TURN_API_TOKEN: 't'
      }).turn
    ).toEqual({ kind: 'cloudflare', keyId: 'k', apiToken: 't' })
  })

  it('uses coturn REST by default when TURN_SECRET is set, and with TURN_PROVIDER=coturn', () => {
    const coturn = { HOST: '127.0.0.1', TURN_SECRET: 's', TURN_URLS: 'turn:a.example:3478' }
    const expected = { kind: 'coturn-rest', secret: 's', urls: ['turn:a.example:3478'] }
    expect(relayOptionsFromEnv(coturn).turn).toEqual(expected)
    expect(relayOptionsFromEnv({ ...coturn, TURN_PROVIDER: 'coturn' }).turn).toEqual(expected)
    expect(() => relayOptionsFromEnv({ HOST: '127.0.0.1', TURN_PROVIDER: 'coturn' })).toThrow(
      'TURN_SECRET is required when TURN_PROVIDER is set'
    )
  })

  it('refuses a half-configured or mixed TURN provider, naming no secret', () => {
    const id = { CLOUDFLARE_TURN_KEY_ID: 'k' }
    const token = { CLOUDFLARE_TURN_API_TOKEN: 'secret-token' }
    const coturn = { TURN_SECRET: 'secret-token', TURN_URLS: 'turn:a.example:3478' }
    const cases: Array<[Record<string, string>, string]> = [
      [
        { TURN_PROVIDER: 'cloudflare' },
        'CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN are required when TURN_PROVIDER=cloudflare'
      ],
      [
        { TURN_PROVIDER: 'cloudflare', ...id },
        'CLOUDFLARE_TURN_API_TOKEN is required when TURN_PROVIDER=cloudflare'
      ],
      [
        { TURN_PROVIDER: 'cloudflare', ...token },
        'CLOUDFLARE_TURN_KEY_ID is required when TURN_PROVIDER=cloudflare'
      ],
      [
        { TURN_PROVIDER: 'cloudflare', ...id, CLOUDFLARE_TURN_API_TOKEN: ' ' },
        'CLOUDFLARE_TURN_API_TOKEN is required when TURN_PROVIDER=cloudflare'
      ],
      [
        { ...id, ...token },
        'TURN_PROVIDER=cloudflare is required when CLOUDFLARE_TURN_KEY_ID or CLOUDFLARE_TURN_API_TOKEN is set'
      ],
      [token, 'TURN_PROVIDER=cloudflare is required when CLOUDFLARE_TURN_API_TOKEN is set'],
      [
        { TURN_PROVIDER: 'coturn', ...coturn, ...id, ...token },
        'TURN_PROVIDER=cloudflare is required when CLOUDFLARE_TURN_KEY_ID or'
      ],
      [
        { TURN_PROVIDER: 'cloudflare', ...id, ...token, TURN_SECRET: 'secret-token' },
        'TURN_SECRET is for TURN_PROVIDER=coturn'
      ],
      [
        { TURN_PROVIDER: 'cloudflare', ...id, ...token, TURN_URLS: 'turn:a.example:3478' },
        'TURN_URLS is for TURN_PROVIDER=coturn'
      ],
      [
        { TURN_PROVIDER: 'cloudflare', ...id, ...token, ...coturn },
        'TURN_SECRET and TURN_URLS are for TURN_PROVIDER=coturn'
      ],
      [{ TURN_PROVIDER: 'twilio' }, 'TURN_PROVIDER must be coturn or cloudflare'],
      [
        { TURN_PROVIDER: 'Cloudflare', ...id, ...token },
        'TURN_PROVIDER must be coturn or cloudflare'
      ],
      [
        { TURN_PROVIDER: 'cloudflare', ...id, ...token, TURN_TTL: '0' },
        'TURN_TTL must be a whole number'
      ],
      [{ TURN_TTL: '600' }, 'or set TURN_PROVIDER=cloudflare']
    ]
    for (const [vars, message] of cases) {
      let thrown: unknown
      try {
        relayOptionsFromEnv({ HOST: '127.0.0.1', ...vars })
      } catch (e) {
        thrown = e
      }
      expect([vars, (thrown as Error | undefined)?.message]).toEqual([
        vars,
        expect.stringContaining(message)
      ])
      expect((thrown as Error).message).not.toContain('secret-token')
    }
  })

  it('reports the first problem in the TURN settings, word for word', () => {
    const ttl = 'TURN_TTL must be a whole number from 1 to 2147483647'
    const cases: Array<[Record<string, string>, string]> = [
      // the provider name, then TURN_TTL, before what either provider needs
      [
        { TURN_PROVIDER: 'twilio', TURN_TTL: '0', CLOUDFLARE_TURN_KEY_ID: 'k' },
        'TURN_PROVIDER must be coturn or cloudflare'
      ],
      [{ TURN_PROVIDER: 'cloudflare', TURN_TTL: '0' }, ttl],
      [{ TURN_TTL: 'x', CLOUDFLARE_TURN_KEY_ID: 'k' }, ttl],
      [{ TURN_PROVIDER: 'coturn', TURN_TTL: '1.5' }, ttl],
      // Cloudflare: coturn settings before missing Cloudflare ones
      [
        { TURN_PROVIDER: 'cloudflare', TURN_SECRET: 's' },
        'TURN_SECRET is for TURN_PROVIDER=coturn; Cloudflare chooses its own urls, so unset ' +
          'it with TURN_PROVIDER=cloudflare'
      ],
      [
        { TURN_PROVIDER: 'cloudflare', TURN_SECRET: 's', TURN_URLS: 'turn:a:3478' },
        'TURN_SECRET and TURN_URLS are for TURN_PROVIDER=coturn; Cloudflare chooses its own ' +
          'urls, so unset them with TURN_PROVIDER=cloudflare'
      ],
      // coturn: Cloudflare settings before missing coturn ones
      [
        { TURN_SECRET: 's', CLOUDFLARE_TURN_API_TOKEN: 't' },
        'TURN_PROVIDER=cloudflare is required when CLOUDFLARE_TURN_API_TOKEN is set'
      ],
      [
        { TURN_TTL: '60', TURN_PER_HOUR: '5', TURN_PER_IP_PER_HOUR: '1' },
        'TURN_SECRET is required when TURN_TTL or TURN_PER_IP_PER_HOUR or TURN_PER_HOUR is set ' +
          '(or set TURN_PROVIDER=cloudflare with CLOUDFLARE_TURN_KEY_ID and ' +
          'CLOUDFLARE_TURN_API_TOKEN)'
      ],
      // a TURN limit needs TURN before its own value is checked
      [
        { TURN_PER_IP_PER_HOUR: '0' },
        'TURN_SECRET is required when TURN_PER_IP_PER_HOUR is set (or set ' +
          'TURN_PROVIDER=cloudflare with CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN)'
      ],
      [
        {
          TURN_PROVIDER: 'coturn',
          TURN_URLS: 'turn:a:3478',
          TURN_TTL: '60',
          TURN_PER_48_PER_HOUR: '2'
        },
        'TURN_SECRET is required when TURN_PROVIDER or TURN_URLS or TURN_TTL or ' +
          'TURN_PER_48_PER_HOUR is set'
      ],
      [{ TURN_SECRET: 's', TURN_PER_HOUR: '0' }, 'TURN_URLS is required when TURN_SECRET is set']
    ]
    for (const [vars, message] of cases) {
      let thrown: unknown
      try {
        relayOptionsFromEnv({ HOST: '127.0.0.1', ...vars })
      } catch (e) {
        thrown = e
      }
      expect([vars, (thrown as Error | undefined)?.message]).toEqual([vars, message])
    }
  })

  it('starts a relay with a Cloudflare provider without asking Cloudflare anything', async () => {
    const logs: string[] = []
    const fetch = jest.fn<typeof globalThis.fetch>()
    const options = relayOptionsFromEnv({
      HOST: '127.0.0.1',
      PORT: '0',
      TURN_PROVIDER: 'cloudflare',
      CLOUDFLARE_TURN_KEY_ID: '0123456789abcdef0123456789abcdef',
      CLOUDFLARE_TURN_API_TOKEN: 'secret-token'
    })
    const r = await createRelayServer({
      ...options,
      turn: { ...(options.turn as CloudflareTurnProvider), fetch },
      log: line => logs.push(line)
    })
    try {
      expect(logs).toContainEqual(
        expect.stringContaining('TURN credentials from cloudflare, valid 600 s')
      )
      expect(logs.join('\n')).not.toContain('secret-token')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await r.close()
    }
  })

  it('rejects an invalid port or ttl and TURN settings without their pair', () => {
    for (const PORT of ['abc', '-1', '65536', '1.5']) {
      expect(() => relayOptionsFromEnv({ PORT })).toThrow('PORT')
    }
    const at = { HOST: '127.0.0.1' }
    expect(() => relayOptionsFromEnv({ ...at, TURN_SECRET: 's' })).toThrow('TURN_URLS')
    expect(() => relayOptionsFromEnv({ ...at, TURN_URLS: 'turn:a:3478' })).toThrow('TURN_SECRET')
    expect(() =>
      relayOptionsFromEnv({ ...at, TURN_SECRET: 's', TURN_URLS: 'turn:a:3478', TURN_TTL: '0' })
    ).toThrow('TURN_TTL')
    expect(() => relayOptionsFromEnv({ ...at, TRUSTED_IP_HEADER: 'cf connecting ip' })).toThrow(
      'TRUSTED_IP_HEADER'
    )
  })
})

describe('relayUsage (webrtpay-relay --help)', () => {
  /** The variables `relayOptionsFromEnv` reads from `env`. */
  function variablesRead(env: Record<string, string | undefined>): string[] {
    const read = new Set<string>()
    relayOptionsFromEnv(
      new Proxy(env, {
        get: (target, key) => {
          if (typeof key === 'string') read.add(key)
          return target[key as string]
        }
      })
    )
    return [...read].sort()
  }

  it('lists exactly the variables relayOptionsFromEnv reads', () => {
    const named = [...relayUsage().matchAll(/^ {2}([A-Z][A-Z0-9_]*)\b/gm)].map(m => m[1]).sort()
    // with TURN configured, every variable is read, the TURN limits included, whichever
    // provider it is
    const coturn = variablesRead({ HOST: '127.0.0.1', TURN_SECRET: 's', TURN_URLS: 'turn:a:3478' })
    const cloudflare = variablesRead({
      HOST: '127.0.0.1',
      TURN_PROVIDER: 'cloudflare',
      CLOUDFLARE_TURN_KEY_ID: 'key-id',
      CLOUDFLARE_TURN_API_TOKEN: 'token'
    })
    expect(coturn).toContain('TURN_PER_HOUR')
    expect(coturn).toContain('CLOUDFLARE_TURN_API_TOKEN')
    expect(named).toEqual(coturn)
    expect(named).toEqual(cloudflare)
  })

  it('says what each TURN provider needs, and that the TURN limits need one of them', () => {
    const usage = relayUsage()
    const line = (name: string): string =>
      usage.split('\n').find(l => l.startsWith(`  ${name} `)) ?? ''
    expect(line('TURN_PROVIDER')).toMatch(/coturn.*cloudflare/)
    expect(line('TURN_SECRET')).toContain('refused with TURN_PROVIDER=cloudflare')
    expect(line('TURN_URLS')).toContain('refused with TURN_PROVIDER=cloudflare')
    expect(line('CLOUDFLARE_TURN_KEY_ID')).toContain('requires TURN_PROVIDER=cloudflare')
    expect(line('CLOUDFLARE_TURN_API_TOKEN')).toContain('requires TURN_PROVIDER=cloudflare')
    for (const name of ['TURN_PER_IP_PER_HOUR', 'TURN_PER_48_PER_HOUR', 'TURN_PER_HOUR']) {
      expect(line(name)).toMatch(/, requires a TURN provider$/)
    }
  })

  it('gives the limit defaults of DEFAULT_RELAY_LIMITS and how to stop the relay', () => {
    const usage = relayUsage()
    expect(usage).toMatch(/^Usage: webrtpay-relay/)
    expect(usage).toMatch(
      new RegExp(`^ {2}MAX_SOCKETS +${DEFAULT_RELAY_LIMITS.maxSockets}\\b`, 'm')
    )
    expect(usage).toMatch(
      new RegExp(`^ {2}TURN_PER_IP_PER_HOUR +${DEFAULT_RELAY_LIMITS.turnPerIpPerHour}\\b`, 'm')
    )
    expect(usage).toContain('SIGTERM')
  })

  it('gives the PORT, HOST and TURN_TTL defaults from the constants the relay uses', () => {
    const usage = relayUsage()
    const shows = (name: string, value: number | string): void => {
      const line = usage.split('\n').find(l => l.startsWith(`  ${name} `))
      expect(line).toContain(`(default ${value})`)
    }
    shows('PORT', DEFAULT_RELAY_PORT)
    shows('HOST', DEFAULT_HOST)
    shows('TURN_TTL', DEFAULT_TURN_TTL_SECONDS)
  })
})
