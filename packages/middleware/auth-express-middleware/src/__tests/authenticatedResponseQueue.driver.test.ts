import type { Response, NextFunction } from 'express'
import type { AuthMessage, Peer } from '@bsv/sdk'
import { Writer } from '@bsv/sdk/primitives/utils'
import { ExpressTransport } from '../index.js'
import type {
  AuthenticatedResponseQueue,
  AuthenticatedResponseReplacement
} from '../authenticatedResponseQueue.js'
import { guardAuthenticatedResponse } from '../../mod.js'
import { queueFixture } from './authenticatedResponseQueue.fixture.js'
import { observeAuthenticatedResponseCompletion } from './authenticatedResponseCompletion.fixture.js'

// Inject a deliberately incomplete internal collaborator to prove that transport
// failure cannot leave an unbounded pending response or an extra signing loop.
const requestId = Buffer.alloc(32).toString('base64')
const response: AuthenticatedResponseReplacement = {
  statusCode: 200,
  headers: {},
  body: new Uint8Array()
}
interface GuardedTransportDriver {
  sendGuardedResponse(
    queue: AuthenticatedResponseQueue,
    res: Response,
    next: NextFunction,
    requestId: string,
    sessionNonce: string,
    wrapper: {
      getStatusCode: () => number
      getHeaders: () => Record<string, string>
      getBody: () => number[]
    }
  ): Promise<void>
}
it.each(['missing-peer', 'missing-send', 'extra-replacement'])(
  'cleans up incomplete internal guarded transport (%s)',
  async mode => {
    const transport = new ExpressTransport(false, undefined, undefined, { requestTimeoutMs: 100 })
    let signatures = 0
    if (mode !== 'missing-peer')
      transport.peer = {
        toPeer: async () => {
          signatures++
          if (mode === 'extra-replacement')
            transport.openGeneralHandles.get(requestId)!.replacement = response
        }
      } as unknown as Peer
    const queue = {
      prepare: () => response,
      wait: async (work: Promise<void>) => await work,
      queued: false,
      close: jest.fn()
    } as unknown as AuthenticatedResponseQueue
    const wrapper = { getStatusCode: () => 200, getHeaders: () => ({}), getBody: () => [] }
    const message =
      mode === 'missing-peer'
        ? 'peer is unavailable'
        : mode === 'missing-send'
          ? 'did not complete admission'
          : 'exhausted'
    await expect(
      (transport as unknown as GuardedTransportDriver).sendGuardedResponse(
        queue,
        {} as Response,
        jest.fn(),
        requestId,
        'fixture-session',
        wrapper
      )
    ).rejects.toThrow(message)
    expect(signatures).toBe(mode === 'missing-peer' ? 0 : mode === 'missing-send' ? 1 : 2)
    expect(transport.openGeneralHandles.size).toBe(0)
  }
)
it('finishes guarded signing immediately after a successful native enqueue', async () => {
  const transport = new ExpressTransport()
  const toPeer = jest.fn(async () => undefined)
  transport.peer = { toPeer } as unknown as Peer
  const queue = {
    prepare: () => response,
    wait: async (work: Promise<void>) => await work,
    queued: true,
    close: jest.fn()
  } as unknown as AuthenticatedResponseQueue
  await expect(
    (transport as unknown as GuardedTransportDriver).sendGuardedResponse(
      queue,
      {} as Response,
      jest.fn(),
      requestId,
      'fixture-session',
      { getStatusCode: () => 200, getHeaders: () => ({}), getBody: () => [] }
    )
  ).resolves.toBeUndefined()
  expect(toPeer).toHaveBeenCalledTimes(1)
  expect(transport.openGeneralHandles.size).toBe(0)
})
it.each(['capture', 'guard'])(
  'closes and reports a guarded %s failure without exposing private data',
  async mode => {
    const logger = captureLogger()
    const fixture = await queueFixture(
      (_req, res) => {
        guardAuthenticatedResponse(res, (_candidate, enqueue) => {
          if (mode === 'guard') throw new Error('synthetic private guard detail')
          enqueue()
        })
        if (mode === 'capture')
          res.getHeaders = () => {
            throw new Error('synthetic private capture detail')
          }
        res.json({ secret: 'must-not-leave' })
      },
      { logger }
    )
    try {
      await expect(fixture.client.fetch(fixture.url, { method: 'POST' })).rejects.toThrow()
      expect(logger.error).toHaveBeenCalledWith(
        mode === 'capture'
          ? '[ExpressTransport] [ERROR] Failed to prepare guarded authenticated response'
          : '[ExpressTransport] [ERROR] Unable to queue guarded authenticated response',
        { errorType: 'error' }
      )
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/private|must-not-leave/)
    } finally {
      await fixture.close()
    }
  }
)

function legacyResponse() {
  const value: Record<string, unknown> = { headersSent: false }
  for (const method of [
    'status',
    'set',
    'send',
    'json',
    'text',
    'end',
    'write',
    'writeHead',
    'flushHeaders',
    'sendFile',
    'once'
  ])
    value[method] = jest.fn(() => value)
  return value as unknown as Response
}
function captureLogger() {
  return { ...console, error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
}
function startLegacyResponse(transport: ExpressTransport, res: Response) {
  const completed = observeAuthenticatedResponseCompletion(transport)
  const setup = Reflect.get(transport, 'setupAuthenticatedResponse') as (
    req: unknown,
    res: Response,
    next: NextFunction,
    identity: string,
    id: string
  ) => void
  setup.call(
    transport,
    { headers: { 'x-bsv-auth-your-nonce': Buffer.alloc(48).toString('base64') } },
    res,
    jest.fn(),
    'fixture-authenticated-identity',
    requestId
  )
  return completed
}
it('retains the legacy pending-handle deadline when no final guard is installed', async () => {
  const logger = captureLogger()
  const transport = new ExpressTransport(false, logger, 'debug', { requestTimeoutMs: 10 })
  let release!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  transport.peer = { toPeer: jest.fn(() => pending) } as unknown as Peer
  const res = legacyResponse()
  const settled = startLegacyResponse(transport, res)
  res.json({ value: 'ordinary' })
  expect(transport.openGeneralHandles.size).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(transport.openGeneralHandles.size).toBe(0)
  expect(logger.warn).toHaveBeenCalledWith(
    '[ExpressTransport] [WARN] Authenticated response signing timed out'
  )
  expect(logger.debug).toHaveBeenCalledWith(
    '[ExpressTransport] [DEBUG] General message from the correct identity key'
  )
  release()
  await settled()
})
it('retains bounded legacy failure cleanup when response restoration itself fails', async () => {
  const logger = captureLogger()
  const transport = new ExpressTransport(false, logger, 'debug'),
    res = legacyResponse(),
    originalJson = res.json
  transport.peer = {
    toPeer: async () => {
      Reflect.set(res, '__send', undefined)
      throw new Error('synthetic signer failure')
    }
  } as unknown as Peer
  const settled = startLegacyResponse(transport, res)
  res.json({ value: 'ordinary' })
  await settled()
  expect(transport.openGeneralHandles.size).toBe(0)
  expect(originalJson).not.toHaveBeenCalled()
  expect(logger.error).toHaveBeenCalledWith(
    '[ExpressTransport] [ERROR] Unable to report response-signing failure',
    { errorType: 'error' }
  )
})

it('reports a missing legacy signing peer once and leaves no pending handle', async () => {
  const logger = { ...console, error: jest.fn(), debug: jest.fn() }
  const transport = new ExpressTransport(false, logger, 'debug')
  const res = legacyResponse()
  const originalJson = res.json
  const originalStatus = res.status
  const settled = startLegacyResponse(transport, res)
  res.json({ private: 'never log this body' })
  await settled()
  expect(transport.openGeneralHandles.size).toBe(0)
  expect(originalStatus).toHaveBeenCalledWith(500)
  expect(originalJson).toHaveBeenCalledWith({
    status: 'error',
    code: 'ERR_RESPONSE_SIGNING_FAILED',
    description: 'Failed to sign the authenticated response.'
  })
  expect(logger.error).toHaveBeenCalledWith(
    '[ExpressTransport] [ERROR] Failed to build and send authenticated response',
    expect.any(Object)
  )
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('never log this body')
})

it('signs a legacy response only once when the application finishes twice', async () => {
  const transport = new ExpressTransport()
  const toPeer = jest.fn(async () => undefined)
  transport.peer = { toPeer } as unknown as Peer
  const res = legacyResponse()
  const settled = startLegacyResponse(transport, res)
  res.json({ first: true })
  res.end()
  await settled()
  expect(toPeer).toHaveBeenCalledTimes(1)
  const clear = Reflect.get(transport, 'clearOpenGeneralHandle') as (id: string) => void
  clear.call(transport, requestId)
})

function generalMessage(status = 200, body: number[] = []): AuthMessage {
  const payload = new Writer()
    .write(Array(32).fill(0))
    .writeVarIntNum(status)
    .writeVarIntNum(0)
    .writeVarIntNum(body.length)
    .write(body)
    .toArray()
  return {
    version: '0.1',
    messageType: 'general',
    identityKey: 'fixture-identity',
    nonce: 'fixture-nonce',
    yourNonce: 'fixture-your-nonce',
    signature: [1, 2],
    requestedCertificates: { certifiers: [], types: {} },
    payload
  }
}
function sendGeneral(transport: ExpressTransport, message: AuthMessage) {
  const send = Reflect.get(transport, 'sendGeneralMessage') as (
    message: AuthMessage
  ) => Promise<void>
  return send.call(transport, message)
}
it.each([[[]], [[1, 2, 3]]])(
  'preserves legacy certificate headers and bounded diagnostics (%j)',
  async body => {
    const logger = captureLogger()
    const transport = new ExpressTransport(false, logger, 'debug')
    const res = legacyResponse()
    const set = res.set,
      send = res.send,
      end = res.end
    startLegacyResponse(transport, res)
    transport.openGeneralHandles.set(requestId, { res, next: jest.fn() })
    const message = generalMessage(200, body)
    await sendGeneral(transport, message)
    expect(set).toHaveBeenCalledWith(
      'x-bsv-auth-requested-certificates',
      JSON.stringify(message.requestedCertificates)
    )
    expect(logger.info).toHaveBeenCalledWith(
      '[ExpressTransport] [INFO] Sending general AuthMessage response',
      { status: 200, responseHeaderCount: 7, responseBodyLength: body.length }
    )
    expect(transport.openGeneralHandles.size).toBe(0)
    if (body.length === 0) {
      expect(end).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
    } else {
      expect(send).toHaveBeenCalledWith(Buffer.from(body))
      expect(end).not.toHaveBeenCalled()
    }
  }
)
it('reports a missing handle without logging response content', async () => {
  const logger = captureLogger()
  const transport = new ExpressTransport(false, logger, 'debug')
  await expect(sendGeneral(transport, generalMessage())).rejects.toThrow('No response handle')
  expect(logger.warn).toHaveBeenCalledWith(
    '[ExpressTransport] [WARN] No response handle for this requestId'
  )
})
it('rejects a negative signed status before applying legacy headers or ending the response', async () => {
  const transport = new ExpressTransport()
  const res = legacyResponse()
  const status = res.status,
    end = res.end
  startLegacyResponse(transport, res)
  transport.openGeneralHandles.set(requestId, { res, next: jest.fn() })
  await expect(sendGeneral(transport, generalMessage(-1))).rejects.toThrow()
  expect(status).not.toHaveBeenCalled()
  expect(end).not.toHaveBeenCalled()
})
