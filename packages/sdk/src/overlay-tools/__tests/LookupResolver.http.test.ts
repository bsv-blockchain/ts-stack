import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import LookupResolver, { HTTPSOverlayLookupFacilitator } from '../LookupResolver.js'
import { getOverlayHostReputationTracker } from '../HostReputationTracker.js'
import { Beef, Transaction } from '../../transaction/index.js'
import { LockingScript } from '../../script/index.js'

interface LookupServer {
  url: string
  close: () => Promise<void>
}

/**
 * This uses SDK serialization to make a structurally parseable receipt. It is
 * deliberately synthetic: parsing BEEF here does not make a cryptographic or
 * chain-validity claim.
 */
function structuralOutputListFixture(scriptBytes = 48 * 1024): {
  answer: {
    type: 'output-list'
    outputs: Array<{ beef: number[]; outputIndex: number; context: number[] }>
  }
  evidenceBytes: number
  wire: Buffer
} {
  const transaction = new Transaction(
    1,
    [],
    [{ lockingScript: LockingScript.fromHex('00'.repeat(scriptBytes)), satoshis: 1 }],
    0
  )
  const beef = Beef.fromBinary(transaction.toBEEF()).toBinary()
  const answer = { type: 'output-list' as const, outputs: [{ beef, outputIndex: 0 }] }
  return {
    answer,
    evidenceBytes: beef.length,
    wire: Buffer.from(JSON.stringify(answer))
  }
}

function configuredResolver(url: string): LookupResolver {
  return new LookupResolver({
    facilitator: new HTTPSOverlayLookupFacilitator(fetch, true),
    hostOverrides: { ls_http: [url] }
  })
}

async function startLookupServer(
  handler: Parameters<typeof createServer>[0]
): Promise<LookupServer> {
  const server = createServer(handler)
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Expected a TCP server address')

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        ;(server as Server).close(error => (error === undefined ? resolve() : reject(error)))
      })
    }
  }
}

async function waitForClose(close: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      close,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('server did not observe client close')), 1500)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('HTTPSOverlayLookupFacilitator HTTP transport', () => {
  let server: LookupServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    getOverlayHostReputationTracker().reset()
  })

  it('accepts a slowly streamed structural BEEF receipt within a configured budget', async () => {
    const fixture = structuralOutputListFixture()
    server = await startLookupServer(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      for (let offset = 0; offset < fixture.wire.length; offset += 1024) {
        response.write(fixture.wire.subarray(offset, offset + 1024))
        await new Promise<void>(resolve => setTimeout(resolve, 2))
      }
      response.end()
    })
    const resolver = configuredResolver(server.url)
    const startedAt = Date.now()
    const result = await resolver.queryDetailed({ service: 'ls_http', query: {} }, 2000, {
      limits: { maxResponseBytes: fixture.wire.length, maxTotalBytes: fixture.wire.length }
    })
    const elapsedMs = Date.now() - startedAt

    expect(result.answer.outputs).toHaveLength(1)
    expect(result.answer.outputs[0].beef).toEqual(fixture.answer.outputs[0].beef)
    expect(result.progress.receivedBytes).toBe(fixture.wire.length)
    expect(fixture.evidenceBytes).toBeGreaterThanOrEqual(48 * 1024)
    expect(fixture.wire.length).toBeGreaterThan(fixture.evidenceBytes)
    expect({ evidenceBytes: fixture.evidenceBytes, jsonWireBytes: fixture.wire.length }).toEqual({
      evidenceBytes: 49_180,
      jsonWireBytes: 98_429
    })
    expect(elapsedMs).toBeGreaterThanOrEqual(20)
    expect(elapsedMs).toBeLessThan(2000)
  })

  it('limits evidence callbacks for the structural receipt, then admits it through evidenceLimits', async () => {
    const fixture = structuralOutputListFixture()
    server = await startLookupServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(fixture.wire)
    })
    const limitedEvidence: string[] = []
    const limited = await configuredResolver(server.url).queryDetailed(
      { service: 'ls_http', query: {} },
      1000,
      {
        limits: {
          maxResponseBytes: fixture.wire.length,
          maxTotalBytes: fixture.wire.length,
          maxEvidenceBytes: fixture.evidenceBytes - 1
        },
        onEvidence: event => limitedEvidence.push(event.type)
      }
    )
    const admittedEvidence: string[] = []
    const admitted = await configuredResolver(server.url).queryDetailed(
      { service: 'ls_http', query: {} },
      1000,
      {
        limits: { maxResponseBytes: fixture.wire.length, maxTotalBytes: fixture.wire.length },
        evidenceLimits: { maxBytes: fixture.evidenceBytes },
        onEvidence: event => admittedEvidence.push(event.type)
      }
    )

    expect(limitedEvidence).toEqual(['limit'])
    expect(limited.progress.terminalReason).toBe('resource-limit')
    expect(limited.progress.limitsHit).toContain('maxEvidenceBytes')
    expect(admittedEvidence).toEqual(['output'])
    expect(admitted.progress.terminalReason).toBe('settled')
    expect(admitted.progress.receivedBytes).toBe(fixture.wire.length)
  })

  it.each(['maxResponseBytes', 'maxTotalBytes'] as const)(
    'reports %s exhaustion without recording an availability failure',
    async limitName => {
      const fixture = structuralOutputListFixture()
      server = await startLookupServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(fixture.wire)
      })
      const smallLimit = fixture.wire.length - 1
      const result = await configuredResolver(server.url).queryDetailed(
        { service: 'ls_http', query: {} },
        1000,
        {
          limits:
            limitName === 'maxResponseBytes'
              ? { maxResponseBytes: smallLimit, maxTotalBytes: fixture.wire.length }
              : { maxResponseBytes: fixture.wire.length, maxTotalBytes: smallLimit }
        }
      )

      expect(result.answer.outputs).toEqual([])
      expect(result.progress.terminalReason).toBe('resource-limit')
      expect(result.progress.limitsHit).toContain(limitName)
      expect(result.progress.completedHosts).toBe(1)
      expect(getOverlayHostReputationTracker().snapshot(server.url)).toMatchObject({
        totalFailures: 0,
        consecutiveFailures: 0,
        totalSuccesses: 0
      })
    }
  )

  it('times out a response whose body never finishes and closes the server-side response', async () => {
    let resolveClosed: () => void = () => undefined
    const responseClosed = new Promise<void>(resolve => {
      resolveClosed = resolve
    })
    server = await startLookupServer((_request, response) => {
      response.once('close', resolveClosed)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"type":"freeform","result":"')
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(fetch, true)

    await expect(
      facilitator.lookup(server.url, { service: 'ls_http', query: {} }, 50, undefined, {
        maxResponseBytes: 1024,
        maxOutputs: 1
      })
    ).rejects.toThrow('Request timed out')

    await waitForClose(responseClosed)
  })

  it.each([
    ['invalid UTF-8', Buffer.from([0xff, 0xfe])],
    ['malformed JSON', Buffer.from('{')]
  ])('rejects %s without treating it as a successful answer', async (_name, payload) => {
    server = await startLookupServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(payload)
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(fetch, true)

    await expect(
      facilitator.lookup(server.url, { service: 'ls_http', query: {} }, 1000, undefined, {
        maxResponseBytes: 1024,
        maxOutputs: 1
      })
    ).rejects.toBeInstanceOf(Error)
  })

  it('honors an early caller abort and closes the server-side response', async () => {
    let resolveStarted: () => void = () => undefined
    const started = new Promise<void>(resolve => {
      resolveStarted = resolve
    })
    let resolveClosed: () => void = () => undefined
    const responseClosed = new Promise<void>(resolve => {
      resolveClosed = resolve
    })
    server = await startLookupServer((_request, response) => {
      response.once('close', resolveClosed)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"type":"freeform","result":"')
      resolveStarted()
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(fetch, true)
    const controller = new AbortController()
    const lookup = facilitator.lookup(
      server.url,
      { service: 'ls_http', query: {} },
      2000,
      controller.signal,
      { maxResponseBytes: 1024, maxOutputs: 1 }
    )

    await started
    controller.abort()

    await expect(lookup).rejects.toMatchObject({ name: 'AbortError', message: 'Lookup cancelled' })
    await waitForClose(responseClosed)
  })
})
