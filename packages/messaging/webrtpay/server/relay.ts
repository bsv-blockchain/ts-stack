import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { ProtoWallet } from '@bsv/sdk'
import { WebSocketServer, WebSocket as WsSocket } from 'ws'
import type { RawData } from 'ws'
import {
  MAX_SIGNAL_CIPHERTEXT_CHARS,
  MAX_SIGNAL_SID_CHARS,
  isSignalEnvelope
} from '../src/signaling/envelope.js'
import { normalizeRelayUrl, relayAuthData } from '../src/signaling/RelaySignaler.js'
import type {
  RelayErrorCode,
  RelayIceServer,
  RelayServerFrame
} from '../src/signaling/RelaySignaler.js'
import { RELAY_PROTOCOL_ID, isIdentityKey } from '../src/types.js'
import type { PubKeyHex } from '../src/types.js'
import { fromHex } from '../src/util/bytes.js'
import { TokenBucket } from './bucket.js'
import { addressGroup, headerAddress, ipv6Block48 } from './ip.js'
import { turnIssuer } from './turn.js'
import type { TurnIssuer, TurnProvider } from './turn.js'

/** Per-socket, per-source and global limits; sizes in bytes, durations in milliseconds. */
export interface RelayLimits {
  /**
   * Largest envelope forwarded, measured as the UTF-8 JSON of `{ v, sid, ciphertext }`. The
   * default, 24672, is the largest well-formed envelope: a 64-character sid and a ciphertext
   * of 24576 characters, room for a signal with a 16384-character SDP.
   */
  maxEnvelopeBytes: number
  /** Time a new socket has to authenticate. */
  authTimeoutMs: number
  /**
   * Frames a socket may send per `rateWindowMs` (a token bucket refilled continuously).
   * WebSocket pings count too.
   */
  rateMessages: number
  rateWindowMs: number
  /**
   * Frames over the rate a socket may send in a row, each answered `rate_limited` (pings get
   * no pong); one more closes it with 1008. Clients match replies to frames in order, so a
   * client briefly over the rate keeps its socket, while one that floods is cut off.
   */
  maxOverRateFrames: number
  /** Authenticated sockets one identity may hold at once. */
  maxSocketsPerIdentity: number
  /** Sockets the relay holds at once, authenticated or not. */
  maxSockets: number
  /** Sockets that have not authenticated yet the relay holds at once, from all sources together. */
  maxUnauthenticatedSockets: number
  /** Sockets one source address may hold at once; IPv6 sources are grouped by /64. */
  maxSocketsPerIp: number
  /** New connections one source address may open per minute (a token bucket). */
  connectionsPerIpPerMinute: number
  /** Sockets all the IPv6 sources of one /48 may hold at once, together. */
  maxSocketsPer48: number
  /** New connections all the IPv6 sources of one /48 may open per minute, together. */
  connectionsPer48PerMinute: number
  /**
   * Signals forwarded from one source address group (an IPv4 address or an IPv6 /64, as
   * for `maxSocketsPerIp`) to one recipient per minute, whatever identities they come from
   * (a token bucket); the rest are answered `rate_limited`. Identities cost nothing and
   * addresses do, so the share is per address: it keeps one address from spending a
   * recipient's whole budget, however many identities it brings.
   */
  signalsPerPairPerMinute: number
  /**
   * Signals forwarded to one identity per minute, from all senders together (a token
   * bucket); the rest are answered `offline`, as if the identity were not connected.
   */
  signalsPerRecipientPerMinute: number
  /**
   * Bytes a socket may have queued for sending. A socket over it is not reading: it
   * is terminated instead of written to, and a signal for it counts as not delivered.
   */
  maxBufferedBytes: number
  /**
   * Ping interval. Each ping carries a fresh random payload, and a socket that has
   * not answered it with a pong echoing that payload by the next one is dropped.
   */
  pingIntervalMs: number
  /** Sets of TURN credentials one source address may get per hour (a token bucket). */
  turnPerIpPerHour: number
  /** Sets of TURN credentials all the IPv6 sources of one /48 may get per hour, together. */
  turnPer48PerHour: number
  /** Sets of TURN credentials the relay issues per hour in total (a token bucket). */
  turnPerHour: number
}

/** The largest well-formed envelope as the relay measures it (see `maxEnvelopeBytes`). */
const MAX_ENVELOPE_BYTES =
  JSON.stringify({ v: 1, sid: '', ciphertext: '' }).length +
  MAX_SIGNAL_SID_CHARS +
  MAX_SIGNAL_CIPHERTEXT_CHARS

export const DEFAULT_RELAY_LIMITS: Readonly<RelayLimits> = Object.freeze({
  maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
  authTimeoutMs: 10000,
  rateMessages: 20,
  rateWindowMs: 10000,
  maxOverRateFrames: 20,
  maxSocketsPerIdentity: 5,
  maxSockets: 10000,
  maxUnauthenticatedSockets: 1000,
  maxSocketsPerIp: 20,
  connectionsPerIpPerMinute: 30,
  maxSocketsPer48: 80,
  connectionsPer48PerMinute: 120,
  signalsPerPairPerMinute: 6,
  signalsPerRecipientPerMinute: 120,
  maxBufferedBytes: 1048576,
  pingIntervalMs: 30000,
  turnPerIpPerHour: 6,
  turnPer48PerHour: 24,
  turnPerHour: 600
})

/** Port the relay listens on when `port` is not given. */
export const DEFAULT_RELAY_PORT = 8787

export interface RelayServerOptions {
  /** Port to listen on (0 picks a free one); default 8787. Ignored with `server`. */
  port?: number
  /** Address to listen on; default all interfaces. Ignored with `server`. */
  host?: string
  /**
   * Attach to this HTTP server instead of creating one. The relay only takes
   * WebSocket upgrades on `path`; it never answers the server's requests and
   * never closes it. Resolves once the server is listening.
   */
  server?: Server
  /** Path of the WebSocket endpoint; default `/`. */
  path?: string
  /**
   * URLs clients may sign (`wss://relay.example`). When set, the Host header is
   * not trusted; otherwise the signed URL must be `ws://` + Host + path, without
   * trailing slashes (`wss://` on a TLS socket, or behind `x-forwarded-proto: https`
   * when `trustHostHeader` is set).
   *
   * Required in production. The Host header and `x-forwarded-proto` are chosen by
   * the client, so without public urls a relay a victim dialed can replay this
   * relay's challenge to the victim and log in here as the victim. The relay
   * therefore refuses to start without public urls unless it listens on a
   * loopback address or `trustHostHeader` is set. Set them whenever a proxy fronts
   * the relay, even one that listens on loopback.
   */
  publicUrls?: string[]
  /**
   * Accept the Host-header URL on a relay that listens on a non-loopback address
   * and has no `publicUrls`, and honour `x-forwarded-proto` when building it
   * (development only; see `publicUrls`). Ignored when `publicUrls` is set.
   */
  trustHostHeader?: boolean
  /**
   * Request header that carries the client's address for the per-source limits. It
   * must be one the outermost proxy sets to a single address, overwriting whatever
   * the client sent, and that every proxy after it passes on unchanged:
   * `cf-connecting-ip` behind Cloudflare (also through a tunnel and Traefik), or
   * e.g. `x-real-ip` behind a single nginx that sets it. Set it only when every
   * connection arrives through that proxy; otherwise clients choose their own address.
   *
   * A value that is not exactly one IP address, such as a list, counts under the
   * socket's peer address, which behind a proxy is the proxy's, and the first such
   * connection is logged. So `x-forwarded-for` works only behind exactly one proxy
   * that overwrites it; proxies append to it, and behind two of them its last entry
   * is the first proxy's address for every client. Without this option the peer
   * address is used.
   */
  trustedIpHeader?: string
  /**
   * Where TURN credentials come from, valid for `ttlSeconds` (default 600):
   * `{ kind: 'coturn-rest', secret, urls }` mints coturn REST credentials (see
   * `turnCredentials`) for these urls, and `{ kind: 'cloudflare', keyId, apiToken }` asks
   * Cloudflare Realtime TURN for each set (see `CloudflareTurnProvider`). They go to an
   * authenticated socket that asks with `{ t: 'turn' }`, within the per-source and global
   * hourly budgets, and are never part of the `ice` frame sent after authentication. A
   * first connection needs them before its offer is gathered, so asking does not wait for
   * a delivered signal. The answer carries `expiresAt`. When the provider fails (Cloudflare
   * answers an error or not within 5 s) the socket gets `unavailable` and the failure is
   * logged, without any secret. coturn REST credentials cannot be revoked; rotating the
   * secret is the only way to cut them off early.
   */
  turn?: TurnProvider
  /** STUN urls handed to authenticated sockets. */
  stunUrls?: string[]
  limits?: Partial<RelayLimits>
  /** Operational messages (never payloads). */
  log?: (msg: string) => void
}

export interface RelayServer {
  /** Local WebSocket URL of the relay, e.g. `ws://127.0.0.1:8787`. */
  url: string
  port: number
  /** Close every socket and, unless attached to a caller's server, stop listening. */
  close(): Promise<void>
  /** Open sockets (authenticated or not) and distinct authenticated identities. */
  stats(): { sockets: number; identities: number }
}

interface Client {
  ws: WsSocket
  stage: 'auth' | 'verifying' | 'open' | 'closed'
  identityKey: PubKeyHex | undefined
  nonce: string
  /** URLs this socket may have signed. */
  authUrls: string[]
  /** The sources this socket counts against: its address group, and an IPv6 address's /48. */
  sources: Source[]
  /** Its address group (`addressGroup`): the key of its share of a recipient's budget. */
  group: string
  /** Frames this socket may still send. */
  rate: TokenBucket
  /** Frames over the rate sent in a row. */
  overRate: number
  /**
   * Replies waiting, oldest first, behind one that is still being prepared (TURN
   * credentials from a provider); empty otherwise. See `send`.
   */
  replies: Array<{ frame: RelayServerFrame | undefined }>
  /** Payload of the last ping sent; only a pong echoing it proves the socket is alive. */
  ping: Buffer | undefined
  alive: boolean
  authTimer: ReturnType<typeof setTimeout> | undefined
}

/** An authenticated identity: its sockets and what may still be forwarded to it. */
interface Identity {
  sockets: Set<Client>
  /** Signals it may still receive from everyone together. */
  budget: TokenBucket
  /**
   * Signals it may still receive from each source address group (`Client.group`); full
   * buckets are swept out. Keyed by the group's string, not its `Source`, which is swept
   * out and made again while the group has no socket.
   */
  pairs: Map<string, TokenBucket>
}

/** A source (an IPv4 address, an IPv6 /64 or /48): its sockets and budgets. */
interface Source {
  sockets: number
  maxSockets: number
  connections: TokenBucket
  turnPerHour: number
  turn: TokenBucket | undefined
}

/** Hex DER signature: 1 to 80 bytes. */
const SIGNATURE_HEX = /^(?:[0-9a-f]{2}){1,80}$/
/** Time `close()` waits for a socket's closing handshake before dropping it. */
const CLOSE_WAIT_MS = 1000
/** A dotted-quad IPv4 address in 127.0.0.0/8. */
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** Bytes of random payload in each ping. */
const PING_BYTES = 16
const MINUTE_MS = 60000
const HOUR_MS = 3600000

/**
 * Start a stateless WebSocket rendezvous for {@link RelaySignaler}s. A socket is
 * challenged with a nonce and must sign it (see `relayAuthData`) within the auth
 * timeout; afterwards it may send `signal` frames, which are forwarded with the
 * authenticated key as `from` to every socket of the recipient, and `turn` frames
 * (see `turn`). Connections are admitted per source address before the WebSocket
 * upgrade (see `limits` and `trustedIpHeader`). Nothing is stored and payloads are
 * never logged. On a server the relay created, `GET /health` answers `{"status":"ok"}`,
 * `GET /ready` answers `{"status":"ready"}` (503 `{"status":"closing"}` once `close()` is
 * called), both with `Access-Control-Allow-Origin: *`, and `OPTIONS` on either path answers
 * a CORS preflight with 204. Rejects, releasing any port it bound, when it would listen on
 * a non-loopback address without `publicUrls` or `trustHostHeader`.
 */
export async function createRelayServer(o: RelayServerOptions = {}): Promise<RelayServer> {
  const settings = relaySettings(o)
  const { limits, path, pathPart, publicUrls, stunUrls, turn, trustedIpHeader } = settings
  const log = o.log ?? (() => {})

  const owned = o.server === undefined
  /** Whether `close()` has been called, so `/ready` answers 503. */
  let shuttingDown = false
  const http = o.server ?? createServer((req, res) => answerHttp(req, res, !shuttingDown))
  // Pings are answered by onPing, within the socket's rate (autoPong would answer them all).
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxEnvelopeBytes * 4,
    autoPong: false
  })
  const verifier = new ProtoWallet('anyone')
  const clients = new Set<Client>()
  const unauthenticated = new Set<Client>()
  const identities = new Map<PubKeyHex, Identity>()
  const sources = new Map<string, Source>()
  const turnIssued = new TokenBucket(limits.turnPerHour, HOUR_MS)
  /** Whether a connection without a usable `trustedIpHeader` value was logged. */
  let headerWarned = false

  // Admission runs before the upgrade, so a refused connection costs no WebSocket.
  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (trimPath(requestPath(req)) !== path) {
      if (owned) refuse(socket, '404 Not Found')
      return
    }
    const address = sourceAddress(req)
    const sources = sourcesOf(address)
    if (sources.some(s => s.sockets >= s.maxSockets || !s.connections.ready())) {
      refuse(socket, '429 Too Many Requests')
      return
    }
    if (
      clients.size >= limits.maxSockets ||
      unauthenticated.size >= limits.maxUnauthenticatedSockets
    ) {
      refuse(socket, '503 Service Unavailable')
      return
    }
    for (const s of sources) s.connections.take()
    // ws completes the upgrade synchronously, so no other upgrade runs between these
    // checks and accept() counting the socket.
    wss.handleUpgrade(req, socket, head, ws => accept(ws, req, sources, addressGroup(address)))
  }

  /** The address `req` counts under: `trustedIpHeader`'s, else the socket's peer address. */
  function sourceAddress(req: IncomingMessage): string {
    if (trustedIpHeader !== undefined) {
      const address = headerAddress(req, trustedIpHeader)
      if (address !== undefined) return address
      if (!headerWarned) {
        headerWarned = true
        log(
          `webrtpay relay: a connection had no single IP address in ${trustedIpHeader}, so it ` +
            'counts under its peer address; that header must be set to one address by the ' +
            'outermost proxy (logged once)'
        )
      }
    }
    return req.socket.remoteAddress ?? ''
  }

  /**
   * The sources an address counts against: its address group (see `addressGroup`) with the
   * per-IP limits and, for IPv6, also its /48 with the per-/48 limits.
   */
  function sourcesOf(address: string): Source[] {
    const out = [
      sourceOf(addressGroup(address), {
        maxSockets: limits.maxSocketsPerIp,
        connectionsPerMinute: limits.connectionsPerIpPerMinute,
        turnPerHour: limits.turnPerIpPerHour
      })
    ]
    const block = ipv6Block48(address)
    if (block !== undefined) {
      out.push(
        sourceOf(block, {
          maxSockets: limits.maxSocketsPer48,
          connectionsPerMinute: limits.connectionsPer48PerMinute,
          turnPerHour: limits.turnPer48PerHour
        })
      )
    }
    return out
  }

  function sourceOf(
    key: string,
    caps: { maxSockets: number; connectionsPerMinute: number; turnPerHour: number }
  ): Source {
    let source = sources.get(key)
    if (source === undefined) {
      const connections = new TokenBucket(caps.connectionsPerMinute, MINUTE_MS)
      source = {
        sockets: 0,
        maxSockets: caps.maxSockets,
        connections,
        turnPerHour: caps.turnPerHour,
        turn: undefined
      }
      sources.set(key, source)
    }
    return source
  }

  function accept(ws: WsSocket, req: IncomingMessage, from: Source[], group: string): void {
    const client: Client = {
      ws,
      stage: 'auth',
      identityKey: undefined,
      nonce: randomBytes(32).toString('base64url'),
      authUrls: publicUrls.length > 0 ? publicUrls : requestUrls(req),
      sources: from,
      group,
      rate: new TokenBucket(limits.rateMessages, limits.rateWindowMs),
      overRate: 0,
      replies: [],
      ping: undefined,
      alive: true,
      authTimer: undefined
    }
    clients.add(client)
    unauthenticated.add(client)
    // sourcesOf registered them and the upgrade was synchronous, so none was swept out
    for (const source of from) source.sockets++
    ws.on('error', () => {})
    ws.on('ping', data => onPing(client, data))
    ws.on('pong', data => {
      // RFC 6455 allows unsolicited pongs, so only an echo of our latest ping counts.
      if (client.ping !== undefined && data.equals(client.ping)) client.alive = true
    })
    ws.on('close', () => forget(client))
    ws.on('message', (data, isBinary) => onFrame(client, data, isBinary))
    client.authTimer = setTimeout(() => refuseAuth(client), limits.authTimeoutMs)
    send(client, { t: 'challenge', nonce: client.nonce })
  }

  /** The URL a client behind this request signs when no public urls are configured. */
  function requestUrls(req: IncomingMessage): string[] {
    const host = req.headers.host
    if (host === undefined || host === '') return []
    // x-forwarded-proto is as client-chosen as Host, so it counts only when Host does.
    const proto =
      o.trustHostHeader === true
        ? String(req.headers['x-forwarded-proto'] ?? '')
            .split(',')[0]
            .trim()
            .toLowerCase()
        : ''
    const secure = proto === 'https' || (req.socket as TLSSocket).encrypted === true
    return [normalizeRelayUrl(`${secure ? 'wss' : 'ws'}://${host}${pathPart}`)]
  }

  function onFrame(client: Client, data: RawData, isBinary: boolean): void {
    if (client.stage === 'closed') return
    const allowed = client.rate.take()
    switch (client.stage) {
      case 'auth':
        // Nothing awaits this, and an unhandled rejection ends a Node process. A failure no
        // check above expects leaves the socket in no known state, so it is cut off.
        authenticate(client, data, isBinary).catch(() => client.ws.terminate())
        return
      case 'verifying':
        refuseAuth(client)
        return
      case 'open': {
        // A frame over the limit is answered, as clients match replies to frames in order,
        // until the socket has sent maxOverRateFrames of them in a row (see overRate).
        if (!allowed) {
          if (overRate(client)) sendError(client, 'rate_limited')
          return
        }
        client.overRate = 0
        const f = isBinary ? undefined : parseJson(data)
        if (isRecord(f) && f.t === 'turn') vendTurn(client)
        else relaySignal(client, f)
        return
      }
    }
  }

  /**
   * A ping costs a frame of the socket's rate, authenticated or not: `ws` would otherwise
   * answer every ping with a pong, a write per frame that no limit covers. Over the rate
   * it gets no pong.
   */
  function onPing(client: Client, data: Buffer): void {
    if (client.stage === 'closed') return
    if (!client.rate.take()) {
      overRate(client)
      return
    }
    client.overRate = 0
    if (client.ws.readyState === WsSocket.OPEN) client.ws.pong(data)
  }

  /**
   * Count one more frame over the rate. Every reply costs a write, so a socket that keeps
   * sending over the rate while it reads the replies could keep the relay busy writing to
   * it: after `maxOverRateFrames` in a row it is closed with 1008. False once it is closed.
   */
  function overRate(client: Client): boolean {
    if (++client.overRate <= limits.maxOverRateFrames) return true
    closeClient(client, 1008, 'rate_limited')
    return false
  }

  async function authenticate(client: Client, data: RawData, isBinary: boolean): Promise<void> {
    client.stage = 'verifying'
    const f = isBinary ? undefined : parseJson(data)
    if (
      !isRecord(f) ||
      f.t !== 'auth' ||
      !isIdentityKey(f.identityKey) ||
      typeof f.signature !== 'string' ||
      !SIGNATURE_HEX.test(f.signature)
    ) {
      refuseAuth(client)
      return
    }
    const identityKey = f.identityKey
    const signature = Array.from(fromHex(f.signature))
    let valid = false
    for (const url of client.authUrls) {
      try {
        const result = await verifier.verifySignature({
          data: relayAuthData(url, client.nonce),
          signature,
          protocolID: RELAY_PROTOCOL_ID,
          keyID: client.nonce,
          counterparty: identityKey
        })
        valid = result.valid
      } catch {
        // verifySignature throws for a signature that does not verify
      }
      if (valid) break
    }
    if (client.stage !== 'verifying') return
    if (!valid) {
      refuseAuth(client)
      return
    }
    const identity = identities.get(identityKey)
    if (identity !== undefined && identity.sockets.size >= limits.maxSocketsPerIdentity) {
      sendError(client, 'rate_limited')
      closeClient(client, 1013, 'too many sockets for this identity')
      return
    }
    clearTimeout(client.authTimer)
    client.stage = 'open'
    client.identityKey = identityKey
    unauthenticated.delete(client)
    if (identity !== undefined) identity.sockets.add(client)
    else {
      const budget = new TokenBucket(limits.signalsPerRecipientPerMinute, MINUTE_MS)
      identities.set(identityKey, { sockets: new Set([client]), budget, pairs: new Map() })
    }
    send(client, { t: 'ready', identityKey })
    // TURN credentials are never handed out here, only on request (see vendTurn).
    send(client, { t: 'ice', iceServers: stunServers() })
  }

  function relaySignal(client: Client, f: unknown): void {
    const envelope = isRecord(f) ? f.envelope : undefined
    if (!isSignalEnvelope(envelope)) {
      sendError(client, 'bad_request')
      return
    }
    const ref = envelope.sid
    if (!isRecord(f) || f.t !== 'signal' || !isIdentityKey(f.to)) {
      sendError(client, 'bad_request', ref)
      return
    }
    const forward = { v: 1, sid: envelope.sid, ciphertext: envelope.ciphertext }
    if (Buffer.byteLength(JSON.stringify(forward)) > limits.maxEnvelopeBytes) {
      sendError(client, 'too_large', ref)
      return
    }
    // set when the socket authenticated, before any frame reaches here
    const sender = client.identityKey as PubKeyHex
    const frame = JSON.stringify({ t: 'signal', from: sender, envelope: forward })
    const recipient = identities.get(f.to)
    const outcome = recipient === undefined ? 'offline' : deliverSignal(client, recipient, frame)
    if (outcome === 'sent') {
      send(client, { t: 'sent', ref })
      return
    }
    // `offline` tells any authenticated key whether `to` is connected right now (and
    // within its budget): a presence oracle (audit F15). It is kept on purpose (Ruling
    // 23) so that a dial to a payee who is not listening fails at once rather than
    // after the 30 s connect budget. RelaySignaler holds a socket only while it listens,
    // sends or was told to connect, so the oracle shows when an identity has direct
    // receive on or is dialing.
    sendError(client, outcome, ref)
  }

  /**
   * Forward `frame` to every socket of `recipient`: `sent` when at least one of them took
   * it, `rate_limited` when the sender's share of the recipient's budget is spent, else
   * `offline`. Each source address group has its own share, checked first, so one address
   * cannot spend everyone's. It is the address and not the identity that is counted:
   * identities cost nothing (Ruling 34). The total still bounds what many addresses can
   * send together. Tokens go only for a signal delivered.
   */
  function deliverSignal(
    client: Client,
    recipient: Identity,
    frame: string
  ): 'sent' | 'rate_limited' | 'offline' {
    const pair = pairShare(recipient, client.group)
    if (!pair.ready()) return 'rate_limited'
    if (!recipient.budget.ready()) return 'offline'
    if (writeAll(recipient.sockets, frame) === 0) return 'offline'
    pair.take()
    recipient.budget.take()
    return 'sent'
  }

  /** `group`'s share of `recipient`'s budget (see `Identity.pairs`), full when new. */
  function pairShare(recipient: Identity, group: string): TokenBucket {
    let pair = recipient.pairs.get(group)
    if (pair === undefined) {
      pair = new TokenBucket(limits.signalsPerPairPerMinute, MINUTE_MS)
      recipient.pairs.set(group, pair)
    }
    return pair
  }

  /** Write `data` to each of `sockets` (see `write`); the number of sockets written to. */
  function writeAll(sockets: Iterable<Client>, data: string): number {
    let written = 0
    for (const socket of sockets) if (write(socket, data)) written++
    return written
  }

  /**
   * Answer `{ t: 'turn' }` with the STUN servers plus fresh TURN credentials and when they
   * expire. TURN relays traffic that we pay for and identities are free, so what limits it
   * is an hourly budget per source address and one in total, spent before the provider is
   * asked (a request it fails costs a credential too), short-lived credentials and, for
   * coturn, a username it can count per identity (Ruling 27). A provider that fails gets
   * the socket `unavailable`.
   */
  function vendTurn(client: Client): void {
    if (turn === undefined) {
      send(client, { t: 'ice', iceServers: stunServers() })
      return
    }
    const now = Date.now()
    // a source holding this socket is never swept out, so its budget is the current one
    const buckets = client.sources.map(source => {
      source.turn ??= new TokenBucket(source.turnPerHour, HOUR_MS, now)
      return source.turn
    })
    buckets.push(turnIssued)
    if (!buckets.every(b => b.ready(now))) {
      sendError(client, 'rate_limited')
      return
    }
    for (const b of buckets) b.take(now)
    const answer = replyLater(client)
    // set when the socket authenticated, before any frame reaches here
    turn
      .issue(client.identityKey as PubKeyHex)
      .then(
        ({ iceServers, expiresAt }) => {
          answer({ t: 'ice', iceServers: [...stunServers(), ...iceServers], expiresAt })
        },
        (err: unknown) => {
          // The reply comes first: it fills the place the socket's later replies wait
          // behind, so a log hook that throws cannot leave them waiting for ever.
          answer({ t: 'error', code: 'unavailable' })
          // issuers reject with messages that hold no secret (see TurnIssuer)
          const why = err instanceof Error ? err.message : 'unknown error'
          log(`webrtpay relay: could not get TURN credentials from ${turn.kind}: ${why}`)
        }
      )
      // Nothing awaits this chain, and an unhandled rejection ends a Node process: whatever
      // `answer` or the log hook throws stops here, on purpose. The reply has gone first, and
      // a log hook that threw is no use for reporting this.
      .catch(() => {})
  }

  function stunServers(): RelayIceServer[] {
    return stunUrls.length > 0 ? [{ urls: [...stunUrls] }] : []
  }

  /**
   * Send `frame` to `client`, after the replies it is waiting behind. Clients match
   * replies to their frames in order, so while a reply is still being prepared (see
   * `replyLater`) the replies to later frames wait for it; signals forwarded to the socket
   * are not replies and do not wait.
   */
  function send(client: Client, frame: RelayServerFrame): void {
    if (client.replies.length > 0) client.replies.push({ frame })
    else write(client, JSON.stringify(frame))
  }

  /**
   * Hold `client`'s place for a reply that is not ready yet: replies sent after this wait
   * until the returned function sends this one.
   */
  function replyLater(client: Client): (frame: RelayServerFrame) => void {
    const slot: { frame: RelayServerFrame | undefined } = { frame: undefined }
    client.replies.push(slot)
    return frame => {
      slot.frame = frame
      let head = client.replies[0]
      while (head?.frame !== undefined) {
        client.replies.shift()
        write(client, JSON.stringify(head.frame))
        head = client.replies[0]
      }
    }
  }

  /**
   * Write `data` to an open socket whose peer keeps reading. A socket with more than
   * `maxBufferedBytes` queued is terminated instead, so a client that stops reading
   * cannot make the relay buffer without bound. False when nothing was written.
   */
  function write(client: Client, data: string): boolean {
    if (client.ws.readyState !== WsSocket.OPEN) return false
    if (client.ws.bufferedAmount > limits.maxBufferedBytes) {
      client.ws.terminate()
      return false
    }
    client.ws.send(data)
    return true
  }

  function sendError(client: Client, code: RelayErrorCode, ref?: string): void {
    send(client, ref === undefined ? { t: 'error', code } : { t: 'error', code, ref })
  }

  function refuseAuth(client: Client): void {
    if (client.stage === 'open' || client.stage === 'closed') return
    sendError(client, 'auth_failed')
    closeClient(client, 1008, 'auth_failed')
  }

  function closeClient(client: Client, code: number, reason: string): void {
    client.stage = 'closed'
    clearTimeout(client.authTimer)
    client.ws.close(code, reason)
  }

  function forget(client: Client): void {
    client.stage = 'closed'
    clearTimeout(client.authTimer)
    clients.delete(client)
    unauthenticated.delete(client)
    for (const source of client.sources) source.sockets--
    if (client.identityKey === undefined) return
    const identity = identities.get(client.identityKey)
    identity?.sockets.delete(client)
    if (identity?.sockets.size === 0) identities.delete(client.identityKey)
  }

  function ping(): void {
    for (const client of clients) {
      if (!client.alive || client.ws.bufferedAmount > limits.maxBufferedBytes) {
        client.ws.terminate()
        continue
      }
      client.alive = false
      if (client.ws.readyState === WsSocket.OPEN) {
        client.ping = randomBytes(PING_BYTES)
        client.ws.ping(client.ping)
      }
    }
    sweep()
  }

  /** Forget sources that hold no socket and address shares, whose budgets are full again. */
  function sweep(): void {
    const now = Date.now()
    for (const [key, source] of sources) {
      const turnFull = source.turn === undefined || source.turn.full(now)
      if (source.sockets === 0 && turnFull && source.connections.full(now)) sources.delete(key)
    }
    for (const identity of identities.values()) {
      for (const [group, pair] of identity.pairs) if (pair.full(now)) identity.pairs.delete(group)
    }
  }

  http.on('upgrade', onUpgrade)
  try {
    await listening(http, owned ? { port: o.port ?? DEFAULT_RELAY_PORT, host: o.host } : undefined)
    if (publicUrls.length === 0 && o.trustHostHeader !== true && !isLoopback(http.address())) {
      throw new Error(
        'publicUrls is required when the relay listens on a non-loopback address: without ' +
          'it clients sign a url taken from the Host header, which the client chooses ' +
          '(set trustHostHeader: true to accept that in development)'
      )
    }
  } catch (err) {
    http.off('upgrade', onUpgrade)
    wss.close()
    if (owned && http.listening) await new Promise<void>(resolve => http.close(() => resolve()))
    throw err
  }
  const pinger = setInterval(ping, limits.pingIntervalMs)
  pinger.unref()

  const address = http.address() as AddressInfo
  const url = `ws://${displayHost(address)}:${address.port}${pathPart}`
  logStarted(log, url, settings)

  let closing: Promise<void> | undefined
  async function shutdown(): Promise<void> {
    shuttingDown = true
    clearInterval(pinger)
    http.off('upgrade', onUpgrade)
    await Promise.all([...clients].map(closeForShutdown))
    await new Promise<void>(resolve => wss.close(() => resolve()))
    if (owned) {
      await new Promise<void>((resolve, reject) => {
        http.close(err => (err === undefined ? resolve() : reject(err)))
        http.closeAllConnections()
      })
    }
    log('webrtpay relay closed')
  }

  function closeForShutdown(client: Client): Promise<void> {
    return new Promise<void>(resolve => {
      if (client.ws.readyState === WsSocket.CLOSED) {
        resolve()
        return
      }
      const timer = setTimeout(() => client.ws.terminate(), CLOSE_WAIT_MS)
      client.ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      closeClient(client, 1001, 'relay closing')
    })
  }

  return {
    url,
    port: address.port,
    close() {
      closing ??= shutdown()
      return closing
    },
    stats() {
      return { sockets: clients.size, identities: identities.size }
    }
  }
}

/** What `createRelayServer` takes from its options, checked before it binds anything. */
interface RelaySettings {
  limits: RelayLimits
  /** The WebSocket endpoint's path, without trailing slashes. */
  path: string
  /** `path` as urls end in it: empty for `/`. */
  pathPart: string
  /** `publicUrls`, normalized (see `normalizeRelayUrl`). */
  publicUrls: string[]
  stunUrls: string[]
  turn: TurnIssuer | undefined
  /** `trustedIpHeader` in lower case, as Node names the headers in `req.headers`. */
  trustedIpHeader: string | undefined
}

/**
 * The settings in `o`, normalized and checked in this order: the limits, the path, the
 * public urls, the TURN provider and the trusted address header. Throws on the first that
 * is invalid.
 */
function relaySettings(o: RelayServerOptions): RelaySettings {
  const limits = relayLimits(o.limits)
  const path = trimPath(o.path ?? '/')
  if (!path.startsWith('/')) throw new TypeError('path must start with "/"')
  const pathPart = path === '/' ? '' : path
  const publicUrls = (o.publicUrls ?? []).map(normalizeRelayUrl)
  const stunUrls = [...(o.stunUrls ?? [])]
  // Validates the provider now rather than on the first request.
  const turn = o.turn === undefined ? undefined : turnIssuer(o.turn)
  if (o.trustedIpHeader !== undefined && !isHeaderName(o.trustedIpHeader)) {
    throw new TypeError('trustedIpHeader must be an HTTP header name')
  }
  // Node lowercases the names in req.headers.
  const trustedIpHeader = o.trustedIpHeader?.toLowerCase()
  return { limits, path, pathPart, publicUrls, stunUrls, turn, trustedIpHeader }
}

/**
 * Log that the relay listens on `url`, where its TURN credentials come from, and the
 * warnings its settings call for: no public urls, or public urls without a trusted
 * address header.
 */
function logStarted(log: (msg: string) => void, url: string, s: RelaySettings): void {
  log(
    `webrtpay relay listening on ${url}` +
      (s.publicUrls.length > 0
        ? ` (public: ${s.publicUrls.join(', ')})`
        : ' (WARNING: no publicUrls, so clients sign a url built from the Host header; ' +
          'set publicUrls in production and whenever a proxy fronts this relay)')
  )
  if (s.turn !== undefined) {
    log(`webrtpay relay: TURN credentials from ${s.turn.kind}, valid ${s.turn.ttlSeconds} s`)
  }
  // A relay with public urls usually sits behind a proxy, whose address every client then has.
  if (s.publicUrls.length > 0 && s.trustedIpHeader === undefined) {
    log(
      'webrtpay relay: WARNING: publicUrls is set but trustedIpHeader is not, so the ' +
        'per-source limits count each socket under its peer address; behind a proxy every ' +
        "client then shares the proxy's limits. Set trustedIpHeader to the header the " +
        'outermost proxy sets (TRUSTED_IP_HEADER=cf-connecting-ip behind Cloudflare)'
    )
  }
}

function relayLimits(partial: Partial<RelayLimits> = {}): RelayLimits {
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...partial }
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`limits.${name} must be a positive number`)
    }
  }
  return limits
}

/** The plain-HTTP probes a relay-created server answers, by path. */
type Probe = 'health' | 'ready'

/** Methods the probe paths accept, as `Access-Control-Allow-Methods` lists them. */
const PROBE_METHODS = 'GET, HEAD, OPTIONS'
/** Request headers every probe preflight allows, before those the browser asks for. */
const PROBE_HEADERS = ['Content-Type']
/** Seconds a browser may cache a probe preflight. */
const PREFLIGHT_MAX_AGE_SECONDS = 600

/**
 * Answer a plain HTTP request on a server the relay created: `GET|HEAD /health` (200),
 * `GET|HEAD /ready` (200 while `ready`, else 503) and `OPTIONS` on either (204), all with
 * wildcard CORS and no credentials. Anything else is 404.
 */
function answerHttp(req: IncomingMessage, res: ServerResponse, ready: boolean): void {
  const probe = probeOf(requestPath(req))
  if (probe !== undefined && req.method === 'OPTIONS') {
    answerPreflight(req, res)
    return
  }
  if (probe !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
    answerProbe(res, probe, ready)
    return
  }
  res.writeHead(404)
  res.end()
}

function probeOf(path: string): Probe | undefined {
  if (path === '/health') return 'health'
  if (path === '/ready') return 'ready'
  return undefined
}

function answerProbe(res: ServerResponse, probe: Probe, ready: boolean): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json')
  if (probe === 'health') {
    res.writeHead(200)
    res.end('{"status":"ok"}')
  } else if (ready) {
    res.writeHead(200)
    res.end('{"status":"ready"}')
  } else {
    res.writeHead(503)
    res.end('{"status":"closing"}')
  }
}

/**
 * A CORS preflight: wildcard origin, the probe methods, and the default headers plus every
 * well-formed header the browser asks for (the probes read no request headers, so any may
 * be sent).
 */
function answerPreflight(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': PROBE_METHODS,
    'Access-Control-Allow-Headers': allowedHeaders(req.headers['access-control-request-headers']),
    'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE_SECONDS),
    Vary: 'Access-Control-Request-Headers'
  })
  res.end()
}

/** {@link PROBE_HEADERS} and the well-formed names in `requested`, each once, ignoring case. */
function allowedHeaders(requested: string | undefined): string {
  const names = new Map(PROBE_HEADERS.map(name => [name.toLowerCase(), name]))
  for (const name of (requested ?? '').split(',').map(n => n.trim())) {
    if (isHeaderName(name) && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name)
  }
  return [...names.values()].join(', ')
}

function requestPath(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0]
}

/** `p` without trailing slashes; `/` stays `/`. */
function trimPath(p: string): string {
  return normalizeRelayUrl(p) || '/'
}

function refuse(socket: Duplex, status: string): void {
  socket.on('error', () => {})
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** Resolve once `http` is listening, starting it on `at` when given. */
function listening(http: Server, at?: { port: number; host?: string }): Promise<void> {
  if (http.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      http.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      http.off('error', onError)
      resolve()
    }
    http.once('error', onError)
    http.once('listening', onListening)
    if (at !== undefined) http.listen(at.port, at.host)
  })
}

/**
 * True for a loopback host: `localhost`, `127.0.0.0/8`, `::1` or an IPv4-mapped
 * `::ffff:127.x.x.x`. Any other name, including one that resolves to loopback,
 * is false.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  const v4 = h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h
  return h === 'localhost' || h === '::1' || LOOPBACK_V4.test(v4)
}

/** True for a valid HTTP header name (an RFC 9110 token). */
export function isHeaderName(name: string): boolean {
  return HEADER_NAME.test(name)
}

/** True when `http.address()` is a loopback address; false for pipes and other addresses. */
function isLoopback(address: AddressInfo | string | null): boolean {
  return typeof address === 'object' && address !== null && isLoopbackHost(address.address)
}

/** A host to reach `a` from this machine: loopback for the unspecified addresses. */
function displayHost(a: AddressInfo): string {
  if (a.address === '0.0.0.0' || a.address === '::') return '127.0.0.1'
  return a.family === 'IPv6' ? `[${a.address}]` : a.address
}

function parseJson(data: RawData): unknown {
  const bytes = frameBytes(data)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

/** A websocket message's bytes, whichever of its forms `ws` delivered. */
function frameBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.isBuffer(data) ? data : Buffer.from(data)
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
