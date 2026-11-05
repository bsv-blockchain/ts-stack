import { expect } from '@jest/globals'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hash, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { WebSocket as WsClient } from 'ws'
import { createRelayServer } from '../../server/index.js'
import type { RelayServer, RelayServerOptions } from '../../server/index.js'
import { RelaySignaler, relayAuthData } from '../../src/signaling/RelaySignaler.js'
import type { RelaySignalerOptions } from '../../src/signaling/RelaySignaler.js'
import type { SignalEnvelope } from '../../src/signaling/types.js'
import { RELAY_PROTOCOL_ID } from '../../src/types.js'
import { randomBytes, toBase64, toBase64Url, toHex } from '../../src/util/bytes.js'

export interface Party {
  wallet: ProtoWallet
  key: string
}

export async function party(): Promise<Party> {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return { wallet, key: publicKey }
}

export function newSid(): string {
  return toBase64Url(randomBytes(16))
}

export function env(ciphertext = toBase64(randomBytes(48))): SignalEnvelope {
  return { v: 1, sid: newSid(), ciphertext }
}

/** Collects deliveries from `listen` and hands them out in order. */
export function inbox(): {
  got: Array<[string, SignalEnvelope]>
  fn: (from: string, e: SignalEnvelope) => void
  next(): Promise<[string, SignalEnvelope]>
} {
  const got: Array<[string, SignalEnvelope]> = []
  const waiters: Array<() => void> = []
  let read = 0
  const next = async (): Promise<[string, SignalEnvelope]> => {
    if (read < got.length) return got[read++]
    await new Promise<void>(r => waiters.push(r))
    return next()
  }
  return {
    got,
    fn(from, e) {
      got.push([from, e])
      waiters.shift()?.()
    },
    next
  }
}

/**
 * Resolve once `check()` holds, polling every 20 ms; reject after `timeoutMs`. It keeps time
 * with `performance.now()`, so a test that mocks `Date.now` cannot make it wait forever.
 */
export function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return pollUntil(check, performance.now() + timeoutMs)
}

async function pollUntil(check: () => boolean, until: number): Promise<void> {
  if (check()) return
  if (performance.now() > until) throw new Error('condition not met in time')
  await new Promise(r => setTimeout(r, 20))
  return pollUntil(check, until)
}

/** `p`, or a rejection naming `what` after `timeoutMs`, so a wait fails rather than hangs. */
export async function within<T>(p: Promise<T>, what: string, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not in ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

/** A raw `ws` client that records every frame, for driving the wire protocol directly. */
export interface Raw {
  ws: WsClient
  next(): Promise<Record<string, unknown>>
  send(frame: unknown): void
  closed: Promise<number>
}

export interface RawOptions {
  headers?: Record<string, string>
  autoPong?: boolean
}

export function raw(url: string, o: RawOptions = {}): Raw {
  const ws = new WsClient(url, { headers: o.headers, autoPong: o.autoPong ?? true })
  const frames: Array<Record<string, unknown>> = []
  const waiters: Array<() => void> = []
  ws.on('message', data => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>)
    waiters.shift()?.()
  })
  ws.on('error', () => {})
  const closed = new Promise<number>(resolve => ws.on('close', code => resolve(code)))
  const next = async (): Promise<Record<string, unknown>> => {
    if (frames.length > 0) return frames.shift() as Record<string, unknown>
    await new Promise<void>(r => waiters.push(r))
    return next()
  }
  return {
    ws,
    next,
    send(frame) {
      ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
    },
    closed
  }
}

/** Answer the relay's challenge for `p`, signing `signedUrl`. */
export async function authenticate(r: Raw, p: Party, signedUrl: string): Promise<void> {
  const challenge = await r.next()
  expect(challenge.t).toBe('challenge')
  const nonce = challenge.nonce as string
  const { signature } = await p.wallet.createSignature({
    data: relayAuthData(signedUrl, nonce),
    protocolID: RELAY_PROTOCOL_ID,
    keyID: nonce,
    counterparty: 'anyone'
  })
  r.send({ t: 'auth', identityKey: p.key, signature: toHex(Uint8Array.from(signature)) })
}

/** The first message an upgrade to `url` fails with, or `opened`. */
export function upgradeError(url: string, headers?: Record<string, string>): Promise<string> {
  return new Promise(resolve => {
    const ws = new WsClient(url, { headers })
    ws.on('error', e => resolve(e.message))
    ws.on('open', () => {
      ws.close()
      resolve('opened')
    })
  })
}

export async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  await new Promise(r => s.close(r))
  return port
}

/**
 * base64(HMAC-SHA1(utf8(secret), utf8(s))), coturn's REST API password. The fixed vectors in
 * relay.test.ts check it, and turnCredentials, against node:crypto's output.
 */
export function hmacBase64(secret: string, s: string): string {
  const mac = new Hash.SHA1HMAC(Utils.toArray(secret, 'utf8'))
  return Utils.toBase64(mac.update(Utils.toArray(s, 'utf8')).digest())
}

/**
 * Relays, signalers and raw clients that `cleanup()` closes again (newest first);
 * relays listen on a free loopback port unless the options say otherwise.
 */
export function relayFixtures(): {
  relay(o?: Partial<RelayServerOptions>): Promise<RelayServer>
  signaler(at: RelayServer | string, p: Party, o?: Partial<RelaySignalerOptions>): RelaySignaler
  rawAt(url: string, o?: RawOptions): Raw
  defer(fn: () => unknown): void
  cleanup(): Promise<void>
} {
  const cleanups: Array<() => unknown> = []
  const cleanup = async (): Promise<void> => {
    const fn = cleanups.pop()
    if (fn === undefined) return
    await fn()
    return cleanup()
  }
  return {
    async relay(o = {}) {
      const r = await createRelayServer({ port: 0, host: '127.0.0.1', ...o })
      cleanups.push(() => r.close())
      return r
    },
    signaler(at, p, o = {}) {
      const s = new RelaySignaler({
        url: typeof at === 'string' ? at : at.url,
        wallet: p.wallet,
        ...o
      })
      cleanups.push(() => s.close())
      return s
    },
    rawAt(url, o = {}) {
      const r = raw(url, o)
      cleanups.push(() => r.ws.terminate())
      return r
    },
    defer(fn) {
      cleanups.push(fn)
    },
    cleanup
  }
}
