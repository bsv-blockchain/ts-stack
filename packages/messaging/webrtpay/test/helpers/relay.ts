import { expect } from '@jest/globals'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
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
  return {
    got,
    fn(from, e) {
      got.push([from, e])
      waiters.shift()?.()
    },
    async next() {
      while (read >= got.length) await new Promise<void>(r => waiters.push(r))
      return got[read++]
    }
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time')
    await new Promise(r => setTimeout(r, 20))
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
  return {
    ws,
    async next() {
      while (frames.length === 0) await new Promise<void>(r => waiters.push(r))
      return frames.shift() as Record<string, unknown>
    },
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

export function hmacBase64(secret: string, s: string): string {
  return createHmac('sha1', secret).update(s).digest('base64')
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
    async cleanup() {
      while (cleanups.length > 0) await cleanups.pop()?.()
    }
  }
}
