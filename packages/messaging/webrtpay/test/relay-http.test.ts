/**
 * The plain-HTTP side of a relay: the health and readiness probes a container runtime polls,
 * their wildcard CORS and preflights, and the `./server` entry a wrapper starts the relay from.
 */
import { afterEach, describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as entry from '../server/index.js'
import { createRelayServer } from '../server/index.js'
import type { RelayServer } from '../server/index.js'
import { DEFAULT_HOST, relayOptionsFromEnv, relayUsage } from '../server/env.js'
import { DEFAULT_RELAY_PORT } from '../server/relay.js'
import { raw } from './helpers/relay.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** The headers the ts-stack container runtime contract asks a preflight to allow. */
const PROBE_REQUEST_HEADERS = 'X-Correlation-ID, X-TS-Stack-Contract-Probe'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function relay(): Promise<RelayServer> {
  const r = await createRelayServer({ port: 0, host: '127.0.0.1' })
  cleanups.push(() => r.close())
  return r
}

function at(r: { port: number }, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${r.port}${path}`, init)
}

function headerList(res: Response, name: string): string[] {
  return (res.headers.get(name) ?? '').split(',').map(h => h.trim().toLowerCase())
}

describe('relay HTTP probes', () => {
  it('answers GET /health and GET /ready with wildcard CORS', async () => {
    const r = await relay()
    const origin = { Origin: 'https://unregistered.example' }
    const health = await at(r, '/health', { headers: origin })
    expect(health.status).toBe(200)
    expect(health.headers.get('access-control-allow-origin')).toBe('*')
    expect(health.headers.get('access-control-allow-credentials')).toBeNull()
    expect(health.headers.get('content-type')).toBe('application/json')
    expect(await health.json()).toEqual({ status: 'ok' })

    const ready = await at(r, '/ready?probe=1', { headers: origin })
    expect(ready.status).toBe(200)
    expect(ready.headers.get('access-control-allow-origin')).toBe('*')
    expect(await ready.json()).toEqual({ status: 'ready' })
  })

  it('answers HEAD on both probes without a body', async () => {
    const r = await relay()
    for (const path of ['/health', '/ready']) {
      const res = await at(r, path, { method: 'HEAD' })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(await res.text()).toBe('')
    }
  })

  it('answers a preflight on either probe with 204, allowing every requested header', async () => {
    const r = await relay()
    for (const path of ['/health', '/ready']) {
      const res = await at(r, path, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://unregistered.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': PROBE_REQUEST_HEADERS
        }
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(headerList(res, 'access-control-allow-methods')).toEqual(['get', 'head', 'options'])
      expect(headerList(res, 'access-control-allow-headers')).toEqual([
        'content-type',
        'x-correlation-id',
        'x-ts-stack-contract-probe'
      ])
      expect(res.headers.get('access-control-max-age')).toBe('600')
      expect(res.headers.get('vary')).toBe('Access-Control-Request-Headers')
      expect(await res.text()).toBe('')
    }
  })

  it('allows only the default header when none, or only malformed or repeated ones, are asked', async () => {
    const r = await relay()
    const bare = await at(r, '/health', { method: 'OPTIONS' })
    expect(bare.status).toBe(204)
    expect(bare.headers.get('access-control-allow-headers')).toBe('Content-Type')
    const odd = await at(r, '/ready', {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Headers': 'content-type, bad header, , x-a, X-A' }
    })
    expect(odd.headers.get('access-control-allow-headers')).toBe('Content-Type, x-a')
  })

  it('answers 404 without CORS on other paths and methods', async () => {
    const r = await relay()
    const checks: Array<[string, string]> = [
      ['/nope', 'GET'],
      ['/nope', 'OPTIONS'],
      ['/health/', 'GET'],
      ['/health', 'POST'],
      ['/ready', 'DELETE'],
      ['/', 'GET']
    ]
    for (const [path, method] of checks) {
      const res = await at(r, path, { method })
      expect([path, method, res.status]).toEqual([path, method, 404])
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      await res.arrayBuffer()
    }
  })

  it('answers /ready with 503 once close() is called, while /health stays 200', async () => {
    const r = await createRelayServer({ port: 0, host: '127.0.0.1' })
    // A client that never reads the close frame holds shutdown open for its close wait.
    const a = raw(r.url)
    await a.next()
    a.ws.pause()
    const closing = r.close()
    const ready = await at(r, '/ready', { headers: { Origin: 'https://unregistered.example' } })
    expect(ready.status).toBe(503)
    expect(ready.headers.get('access-control-allow-origin')).toBe('*')
    expect(await ready.json()).toEqual({ status: 'closing' })
    const health = await at(r, '/health')
    expect(health.status).toBe(200)
    await health.arrayBuffer()
    await closing
    a.ws.resume()
    await expect(at(r, '/ready')).rejects.toThrow()
  })

  it('keeps the websocket upgrade on its path', async () => {
    const r = await relay()
    const a = raw(r.url)
    expect((await a.next()).t).toBe('challenge')
    a.ws.close()
  })

  it('leaves the requests of a server it is attached to alone', async () => {
    const http: Server = createServer((_req, res) => {
      res.writeHead(418)
      res.end('app')
    })
    cleanups.push(
      () =>
        new Promise(resolve => {
          http.closeAllConnections()
          http.close(resolve)
        })
    )
    const pending = createRelayServer({ server: http, path: '/relay' })
    http.listen(0, '127.0.0.1')
    const r = await pending
    cleanups.push(() => r.close())
    const app = { port: (http.address() as AddressInfo).port }
    for (const [path, method] of [
      ['/health', 'GET'],
      ['/ready', 'GET'],
      ['/ready', 'OPTIONS']
    ]) {
      const res = await at(app, path, { method })
      expect(res.status).toBe(418)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(await res.text()).toBe('app')
    }
  })
})

describe('the ./server entry', () => {
  it('exports what the CLI starts the relay with', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'DEFAULT_HOST',
      'DEFAULT_RELAY_LIMITS',
      'DEFAULT_RELAY_PORT',
      'createRelayServer',
      'relayOptionsFromEnv',
      'relayUsage',
      'turnCredentials'
    ])
    expect(entry.relayOptionsFromEnv).toBe(relayOptionsFromEnv)
    expect(entry.relayUsage).toBe(relayUsage)
    expect(entry.DEFAULT_HOST).toBe(DEFAULT_HOST)
    expect(entry.DEFAULT_RELAY_PORT).toBe(DEFAULT_RELAY_PORT)
    expect(entry.relayUsage()).toMatch(/^Usage: webrtpay-relay/)
    expect(entry.relayUsage()).toContain('GET /ready')
    expect(entry.relayOptionsFromEnv({ HOST: '127.0.0.1', PORT: '0' })).toMatchObject({
      host: '127.0.0.1',
      port: 0
    })
  })

  it('is what @bsv/webrtpay/server resolves to', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.exports['./server']).toEqual({
      types: './dist/server/index.d.ts',
      import: './dist/server/index.js',
      default: './dist/server/index.js'
    })
    expect(pkg.typesVersions['*'].server).toEqual(['dist/server/index.d.ts'])
    // tsconfig.build.json compiles server/index.ts to dist/server/index.js
    const build = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8'))
    expect(JSON.stringify(build)).toContain('server')
    expect(pkg.scripts['pack:check']).toContain(
      './server=createRelayServer|turnCredentials|DEFAULT_RELAY_LIMITS|relayOptionsFromEnv|relayUsage'
    )
  })
})
