import { jest } from '@jest/globals'
import { SimplifiedFetchTransport } from '../SimplifiedFetchTransport.js'
import * as Utils from '../../../primitives/utils.js'
import { AuthMessage } from '../../types.js'

function createGeneralPayload (path = '/resource', method = 'GET'): number[] {
  const writer = new Utils.Writer()
  const requestId = new Array(32).fill(1)
  writer.write(requestId)

  const methodBytes = Utils.toArray(method, 'utf8')
  writer.writeVarIntNum(methodBytes.length)
  writer.write(methodBytes)

  const pathBytes = Utils.toArray(path, 'utf8')
  writer.writeVarIntNum(pathBytes.length)
  writer.write(pathBytes)

  writer.writeVarIntNum(-1) // no query string
  writer.writeVarIntNum(0) // no headers
  writer.writeVarIntNum(-1) // no body

  return writer.toArray()
}

function createGeneralMessage (overrides: Partial<AuthMessage> = {}): AuthMessage {
  return {
    version: '1.0',
    messageType: 'general',
    identityKey: 'client-key',
    nonce: 'client-nonce',
    yourNonce: 'server-nonce',
    payload: createGeneralPayload(),
    signature: new Array(64).fill(0),
    ...overrides
  }
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe('SimplifiedFetchTransport send', () => {
  test('wraps network failures with context', async () => {
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn()
    fetchMock.mockRejectedValue(new Error('network down'))
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any)
    await transport.onData(async () => {})
    const message = createGeneralMessage()

    let caught: any
    await expect((async () => {
      try {
        await transport.send(message)
      } catch (error) {
        caught = error
        throw error
      }
    })()).rejects.toThrow('Network error while sending authenticated request to https://api.example.com/resource: network down')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/resource')
    expect(caught).toBeInstanceOf(Error)
    expect(caught.cause).toBeInstanceOf(Error)
    expect(caught.cause?.message).toBe('network down')
  })

  test('throws when server omits authentication headers', async () => {
    const response = new Response('missing auth', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain'
      }
    })
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn()
    fetchMock.mockResolvedValue(response)
    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any)
    await transport.onData(async () => {})

    const message = createGeneralMessage()

    let thrown: any
    await expect((async () => {
      try {
        await transport.send(message)
      } catch (error) {
        thrown = error
        throw error
      }
    })()).rejects.toThrow('Received HTTP 200 from https://api.example.com/resource without valid BSV authentication (missing headers: x-bsv-auth-version, x-bsv-auth-identity-key, x-bsv-auth-signature)')

    expect(thrown.details).toMatchObject({
      url: 'https://api.example.com/resource',
      status: 200,
      missingHeaders: [
        'x-bsv-auth-version',
        'x-bsv-auth-identity-key',
        'x-bsv-auth-signature'
      ]
    })
    expect(thrown.details.bodyPreview).toContain('missing auth')
  })

  test('rejects malformed requested certificates header', async () => {
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn()
    fetchMock.mockResolvedValue(new Response('', {
      status: 200,
      headers: {
        'x-bsv-auth-version': '0.1',
        'x-bsv-auth-identity-key': 'server-key',
        'x-bsv-auth-signature': 'deadbeef',
        'x-bsv-auth-message-type': 'general',
        'x-bsv-auth-request-id': Utils.toBase64(new Array(32).fill(2)),
        'x-bsv-auth-requested-certificates': 'not-json'
      }
    }))

    const transport = new SimplifiedFetchTransport('https://api.example.com', fetchMock as any)
    await transport.onData(async () => {})
    const message = createGeneralMessage()

    await expect(transport.send(message)).rejects.toThrow(
      'Failed to parse x-bsv-auth-requested-certificates returned by https://api.example.com/resource: not-json'
    )
  })
})
