/**
 * tests/AuthFetch.test.ts
 */
import {
  CompletedProtoWallet,
  PrivateKey,
  RequestedCertificateTypeIDAndFieldList,
  Utils,
  AuthFetch
} from '@bsv/sdk'
import { Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { holdNextDelayedResponse, startServer } from './testExpressServer'
import { MockWallet } from './MockWallet'

export interface RequestedCertificateSet {
  certifiers: string[]
  types: RequestedCertificateTypeIDAndFieldList
}

// Increase global timeout for async ops
jest.setTimeout(30000)

describe('AuthFetch and AuthExpress Integration Tests', () => {
  const privKey = PrivateKey.fromRandom()
  let server: Server
  let port: number
  let origin: string
  beforeAll(async () => {
    server = startServer() // Returns un-listened server
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => {
        port = (server.address() as AddressInfo).port
        origin = `http://localhost:${port}`
        resolve()
      })
      server.once('error', reject)
      server.listen(0)
    })
  })

  afterAll(async () => {
    if (server && server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('close', () => {
          resolve()
        })
        server.once('error', reject)
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections()
        }
        server.close()
      })
    }
  })

  // --------------------------------------------------------------------------
  // Main Tests
  // --------------------------------------------------------------------------

  test('preserves Express header-map, scalar, array and alias overloads in signed responses', async () => {
    const authFetch = new AuthFetch(new MockWallet(privKey))
    const response = await authFetch.fetch(`${origin}/header-overloads`)
    expect(response.status).toBe(418)
    expect(await response.json()).toEqual({ headers: 'preserved' })
    for (const [name, value] of Object.entries({
      map: 'map',
      number: '25',
      array: 'one, two',
      alias: 'alias',
      single: 'single'
    })) {
      expect(response.headers.get(`x-bsv-${name}`)).toBe(value)
    }
    expect(response.headers.get('x-bsv-auth-identity-key')).toBeTruthy()
  })

  test('authenticates a 128 KiB payment header unchanged through a configured HTTP server', async () => {
    const proof = 'p'.repeat(128 * 1024)
    const authFetch = new AuthFetch(new MockWallet(privKey))
    const response = await authFetch.fetch(`${origin}/large-payment-header`, {
      headers: { 'x-bsv-payment': proof }
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      bytes: Buffer.byteLength(proof),
      sha256: createHash('sha256').update(proof).digest('hex')
    })
  })

  test('rejects tampering with a large signed request header', async () => {
    const tamper: typeof fetch = async (url, init) => {
      if (!String(url).endsWith('/large-payment-header')) return await fetch(url, init)
      const headers = new Headers(init?.headers)
      headers.set('x-bsv-payment', 'q'.repeat(128 * 1024))
      return await fetch(url, { ...init, headers })
    }
    const authFetch = new AuthFetch(
      new MockWallet(privKey),
      undefined,
      undefined,
      undefined,
      {},
      tamper
    )
    await expect(
      authFetch.fetch(`${origin}/large-payment-header`, {
        headers: { 'x-bsv-payment': 'p'.repeat(128 * 1024) }
      })
    ).rejects.toThrow(/401|authentication|signature/i)
  })

  test('rejects a changed signed header supplied through the header-map overload', async () => {
    const tamper: typeof fetch = async (url, init) => {
      const response = await fetch(url, init)
      if (!String(url).endsWith('/header-overloads')) return response
      const headers = new Headers(response.headers)
      headers.set('x-bsv-map', 'changed')
      return new Response(await response.arrayBuffer(), { status: response.status, headers })
    }
    const authFetch = new AuthFetch(
      new MockWallet(privKey),
      undefined,
      undefined,
      undefined,
      {},
      tamper
    )
    await expect(authFetch.fetch(`${origin}/header-overloads`)).rejects.toThrow(/signature/i)
  })

  test.each([204, 401, 403, 404])('verifies a signed bodyless HTTP %i response', async status => {
    const authFetch = new AuthFetch(new MockWallet(privKey))
    const result = await authFetch.fetch(`${origin}/empty-${status}`)
    expect(result.status).toBe(status)
    expect(await result.text()).toBe('')
    expect(result.headers.get('x-bsv-auth-identity-key')).toBeTruthy()
  })

  test('rejects a bodyless response whose signed HTTP status was changed in transit', async () => {
    const tamper: typeof fetch = async (url, init) => {
      const response = await fetch(url, init)
      if (!String(url).endsWith('/empty-404')) return response
      await response.arrayBuffer()
      return new Response(null, { status: 204, headers: response.headers })
    }
    const authFetch = new AuthFetch(
      new MockWallet(privKey),
      undefined,
      undefined,
      undefined,
      {},
      tamper
    )
    await expect(authFetch.fetch(`${origin}/empty-404`)).rejects.toThrow(/signature/i)
  })

  test('Test 1: Simple POST request with JSON', async () => {
    const walletWithRequests = new MockWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ message: 'Hello from JSON!' })
    })
    expect(result.status).toBe(200)
    const jsonResponse = await result.json()
    expect(jsonResponse).toBeDefined()
  })
  test('Test 1b: Simple POST request with JSON resulting in 500 error code', async () => {
    const walletWithRequests = new MockWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/error-500`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ message: 'Hello from JSON!' })
    })
    expect(result.status).toBe(500)
    const jsonResponse = await result.json()
    expect(jsonResponse).toHaveProperty('code', 'ERR_BAD_THING')
  })

  test('Test 2: POST request with URL-encoded data', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-bsv-test': 'this is a test header'
      },
      body: new URLSearchParams({ message: 'hello!', type: 'form-data' }).toString()
    })
    expect(result.status).toBe(200)
    const textResponse = await result.text()
    expect(textResponse).toBeDefined()
  })

  test('Test 3: POST request with plain text', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-bsv-test': 'this is a test header'
      },
      body: 'Hello, this is a plain text message!'
    })
    expect(result.status).toBe(200)
    const textResponse = await result.text()
    expect(textResponse).toBeDefined()
  })

  test('Test 4: POST request with binary data', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-bsv-test': 'this is a test header'
      },
      body: Utils.toArray('Hello from binary!')
    })
    expect(result.status).toBe(200)
    const textResponse = await result.text()
    expect(textResponse).toBeDefined()
  })

  test('Test 5: Simple GET request', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/`)
    expect(result.status).toBe(200)
    const textResponse = await result.text()
    expect(textResponse).toBeDefined()
  })

  test('Test 7: PUT request with JSON', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/put-endpoint`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-bsv-test': 'this is a test header'
      },
      body: JSON.stringify({ key: 'value', action: 'update' })
    })
    expect(result.status).toBe(200)
    const textResponse = await result.text()
    expect(textResponse).toBeDefined()
  })

  test('Test 8: DELETE request', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/delete-endpoint`, {
      method: 'DELETE',
      headers: {
        'x-bsv-test': 'this is a test header'
      }
    })
    expect(result.status).toBe(200)
    const textResponse = await result.text()
    expect(textResponse).toBeDefined()
  })

  test('Test 9: Large binary upload', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const largeBuffer = Utils.toArray('Hello from a large upload test')
    const result = await authFetch.fetch(`${origin}/large-upload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream'
      },
      body: largeBuffer
    })
    expect(result.status).toBe(200)
    const textResponse = await result.text()
    expect(textResponse).toBeDefined()
  })

  test('Test 10: Query parameters', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/query-endpoint?param1=value1&param2=value2`)
    expect(result.status).toBe(200)
    const textResponse = await result.text()
    expect(textResponse).toBeDefined()
  })

  test('Test 11: Custom headers', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/custom-headers`, {
      method: 'GET',
      headers: {
        'x-bsv-custom-header': 'CustomHeaderValue'
      }
    })
    expect(result.status).toBe(200)
    const textResponse = await result.text()
    expect(textResponse).toBeDefined()
  })

  // --------------------------------------------------------------------------
  // Edge-Case Tests
  // --------------------------------------------------------------------------

  test('Edge Case A: No Content-Type', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    await expect(
      authFetch.fetch(`${origin}/no-content-type-endpoint`, {
        method: 'POST',
        // Intentionally no 'content-type' header
        body: 'This should fail if your code requires Content-Type for POST.'
      })
    ).rejects.toThrow()
  })

  test('Edge Case B: application json content with undefined body', async () => {
    const walletWithRequests = new MockWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: undefined
    })
    expect(result.status).toBe(200)
    const jsonResponse = await result.json()
    expect(jsonResponse).toBeDefined()
  })

  test('Edge Case C: application json content with body of type object', async () => {
    const walletWithRequests = new MockWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: {}
    })
    expect(result.status).toBe(200)
    const jsonResponse = await result.json()
    expect(jsonResponse).toBeDefined()
  })

  // --------------------------------------------------------------------------
  // Multi-session and server-lifecycle regressions
  // --------------------------------------------------------------------------
  test('routes delayed responses to the exact session when one identity has concurrent sessions', async () => {
    const firstClient = new AuthFetch(new MockWallet(privKey))
    const secondClient = new AuthFetch(new MockWallet(privKey))

    await expect(firstClient.fetch(`${origin}/custom-headers`)).resolves.toHaveProperty(
      'status',
      200
    )
    await expect(secondClient.fetch(`${origin}/custom-headers`)).resolves.toHaveProperty(
      'status',
      200
    )

    const delayedResponse = holdNextDelayedResponse()
    const delayedFirstResponse = firstClient.fetch(`${origin}/delayed-response`)
    await delayedResponse.started
    try {
      await expect(secondClient.fetch(`${origin}/custom-headers`)).resolves.toHaveProperty(
        'status',
        200
      )
    } finally {
      delayedResponse.release()
    }

    const outcome = await Promise.race([
      delayedFirstResponse.then(response => ({ result: 'response' as const, response })),
      new Promise<{ result: 'timeout' }>(resolve => {
        const timeout = setTimeout(() => resolve({ result: 'timeout' }), 5_000)
        timeout.unref?.()
      })
    ])

    expect(outcome.result).toBe('response')
    if (outcome.result === 'response') {
      expect(outcome.response.status).toBe(200)
      await expect(outcome.response.json()).resolves.toEqual({ status: 'delayed response' })
    }
  })

  test('Test 12: Two AuthFetch instances from the same identity key (restart server mid-test)', async () => {
    // Use separate wallet instances with the same identity key.
    const wallet1 = new MockWallet(privKey)
    const authFetch1 = new AuthFetch(wallet1)
    const resp1 = await authFetch1.fetch(`${origin}/custom-headers`, {
      method: 'GET',
      headers: { 'x-bsv-custom-header': 'CustomHeaderValue' }
    })
    expect(resp1.status).toBe(200)
    const data1 = await resp1.json()
    expect(data1).toBeDefined()

    // Close the server and wait for it to shut down.
    await new Promise<void>((resolve, reject) => {
      server.once('close', () => {
        resolve()
      })
      server.once('error', reject)
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
      server.close()
    })

    // Restart the server and assign it back to the 'server' variable.
    server = startServer()
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => {
        resolve()
      })
      server.once('error', err => {
        reject(err)
      })
      server.listen(port) // Reuse the origin to preserve the stale-session scenario.
    })

    // Add a short delay to ensure the server is fully ready.
    await new Promise(resolve => setTimeout(resolve, 200))

    // Create a fresh AuthFetch instance using a new wallet instance (same identity key).
    const wallet2 = new MockWallet(privKey)
    const authFetch2 = new AuthFetch(wallet2)
    const resp2 = await authFetch2.fetch(`${origin}/custom-headers`, {
      method: 'GET',
      headers: { 'x-bsv-custom-header': 'CustomHeaderValue' }
    })
    expect(resp2.status).toBe(200)
    const data2 = await resp2.json()
    expect(data2).toBeDefined()
  })

  test('Test 13: POST request with JSON header containing charset injection', async () => {
    const walletWithRequests = new CompletedProtoWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)
    const result = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ message: 'Testing charset injection normalization!' })
    })
    expect(result.status).toBe(200)
    const jsonResponse = await result.json()
    expect(jsonResponse).toBeDefined()
  })

  test('Test 14: Stale-session recovery after server-side session reset', async () => {
    const walletWithRequests = new MockWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)

    // 1. Establish a session with a successful request
    const firstResponse = await authFetch.fetch(`${origin}/custom-headers`, {
      method: 'GET',
      headers: { 'x-bsv-custom-header': 'CustomHeaderValue' }
    })
    expect(firstResponse.status).toBe(200)

    // 2. Clear server-side sessions (simulates server restart / scaling event)
    const clearResponse = await fetch(`${origin}/__clear-auth-sessions`, {
      method: 'POST'
    })
    expect(clearResponse.status).toBe(200)

    // 3. Second request should recover automatically (re-handshake) instead of hanging
    const secondRequestPromise = authFetch.fetch(`${origin}/custom-headers`, {
      method: 'GET',
      headers: { 'x-bsv-custom-header': 'CustomHeaderValue' }
    })

    const outcome = await Promise.race([
      secondRequestPromise
        .then(res => ({ tag: 'resolved' as const, response: res }))
        .catch((error: unknown) => {
          if (error instanceof Error) return { tag: 'rejected' as const, message: error.message }
          return { tag: 'rejected' as const, message: String(error) }
        }),
      new Promise<{ tag: 'timeout' }>(resolve => {
        const t = setTimeout(() => resolve({ tag: 'timeout' }), 10000)
        if (typeof t.unref === 'function') t.unref()
      })
    ])

    // Should NOT timeout — the client should detect the stale session and retry
    expect(outcome.tag).not.toBe('timeout')

    // Should recover and succeed
    expect(outcome.tag).toBe('resolved')
    if (outcome.tag === 'resolved') {
      expect(outcome.response.status).toBe(200)
    }
  })

  test('Test 15: Multiple sequential requests survive a mid-session server reset', async () => {
    const walletWithRequests = new MockWallet(privKey)
    const authFetch = new AuthFetch(walletWithRequests)

    // First request — establishes session
    const r1 = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'before reset' })
    })
    expect(r1.status).toBe(200)

    // Clear sessions
    const clearResponse = await fetch(`${origin}/__clear-auth-sessions`, {
      method: 'POST'
    })
    expect(clearResponse.status).toBe(200)

    // Second request — should recover via re-handshake
    const r2 = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'after reset' })
    })
    expect(r2.status).toBe(200)
    const body2 = await r2.json()
    expect(body2).toBeDefined()

    // Third request — should work on the fresh session
    const r3 = await authFetch.fetch(`${origin}/other-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'after recovery' })
    })
    expect(r3.status).toBe(200)
    const body3 = await r3.json()
    expect(body3).toBeDefined()
  })
})
