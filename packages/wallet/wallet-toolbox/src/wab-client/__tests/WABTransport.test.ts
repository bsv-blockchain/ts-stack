import { TelemetryEvent, WalletInterface } from '@bsv/sdk'
import { UMPTokenInteractor } from '../../CWIStyleWalletManager'
import {
  WABAccountContinuityError,
  WalletAuthenticationManager
} from '../../WalletAuthenticationManager'
import { WABClient } from '../WABClient'
import { WABClientError } from '../WABTransport'
import { DevConsoleInteractor } from '../auth-method-interactors/DevConsoleInteractor'
import { TwilioPhoneInteractor } from '../auth-method-interactors/TwilioPhoneInteractor'

function jsonResponse (
  value: unknown,
  status: number = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

describe('WAB transport hardening', () => {
  it('requires HTTPS except for local development', () => {
    expect(() => new WABClient('http://wab.example')).toThrow(WABClientError)
    expect(() => new WABClient('https://user:password@wab.example')).toThrow(WABClientError)
    expect(() => new WABClient('http://localhost:3000')).not.toThrow()
  })

  it('requires canonical E.164 phone identity before sending authentication', async () => {
    const fetchClient = jest.fn(async () => jsonResponse({ success: true })) as typeof fetch
    const client = new WABClient('https://wab.example', { fetch: fetchClient })
    const twilio = new TwilioPhoneInteractor()

    await expect(client.startAuthMethod(
      twilio,
      'a'.repeat(64),
      { phoneNumber: '(555) 555-0123' }
    )).rejects.toThrow('canonical E.164')
    expect(fetchClient).not.toHaveBeenCalled()

    await expect(client.startAuthMethod(
      twilio,
      'a'.repeat(64),
      { phoneNumber: ' +15555550123 ' }
    )).resolves.toMatchObject({ success: true })
    const sent = JSON.parse(String(fetchClient.mock.calls[0][1]?.body)) as {
      payload: { phoneNumber: string }
    }
    expect(sent.payload.phoneNumber).toBe('+15555550123')
  })

  it('enforces a hard timeout and a bounded response', async () => {
    const stalledFetch = jest.fn(async () => await new Promise<Response>(() => {}))
    const stalled = new WABClient('https://wab.example', {
      fetch: stalledFetch as typeof fetch,
      timeoutMs: 5
    })

    await expect(stalled.getInfo()).rejects.toMatchObject({
      code: 'WAB_TIMEOUT',
      retryable: true
    })

    const oversized = new WABClient('https://wab.example', {
      fetch: jest.fn(async () => jsonResponse({ data: 'x'.repeat(200) })) as typeof fetch,
      maxResponseBytes: 64
    })
    await expect(oversized.getInfo()).rejects.toMatchObject({
      code: 'WAB_RESPONSE_TOO_LARGE',
      retryable: false
    })

    const arrayResponse = new WABClient('https://wab.example', {
      fetch: jest.fn(async () => jsonResponse([])) as typeof fetch
    })
    await expect(arrayResponse.getInfo()).rejects.toMatchObject({
      code: 'WAB_INVALID_RESPONSE',
      retryable: true
    })

    const fetchClient = jest.fn(async () => jsonResponse({ success: true })) as typeof fetch
    const oversizedRequest = new WABClient('https://wab.example', {
      fetch: fetchClient,
      maxRequestBytes: 64
    })
    await expect(oversizedRequest.startShareAuth(
      'DevConsole',
      'a'.repeat(64),
      { diagnostic: 'x'.repeat(200) }
    )).rejects.toMatchObject({
      code: 'WAB_REQUEST_TOO_LARGE',
      retryable: false
    })
    expect(fetchClient).not.toHaveBeenCalled()
  })

  it('sends correlation IDs without telemetry and preserves request context on errors', async () => {
    const fetchClient = jest.fn(async () => jsonResponse({ message: 'not found' }, 404)) as typeof fetch
    const client = new WABClient('https://wab.example/customer', { fetch: fetchClient })

    await expect(client.getInfo()).rejects.toMatchObject({
      code: 'WAB_ENDPOINT_MISMATCH',
      status: 404,
      retryable: false,
      operation: 'get-info',
      route: '/info',
      endpointMarkerPresent: false,
      responseCorrelationMatched: false,
      correlationId: expect.stringMatching(/^[a-f0-9]{32}$/)
    })

    const headers = fetchClient.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['X-Correlation-ID']).toMatch(/^[a-f0-9]{32}$/)
  })

  it('replaces an unsafe correlation ID produced by a custom factory', async () => {
    const fetchClient = jest.fn(async () => jsonResponse({ success: true })) as typeof fetch
    const client = new WABClient('https://wab.example', {
      fetch: fetchClient,
      telemetry: {
        correlationIdFactory: () => ' unsafe correlation '
      }
    })

    await client.getInfo()

    const headers = fetchClient.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['X-Correlation-ID']).toMatch(/^[a-f0-9]{32}$/)
  })

  it('distinguishes a WAB application 404 from an incompatible endpoint', async () => {
    let requestCorrelationId = ''
    const fetchClient = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      requestCorrelationId = headers['X-Correlation-ID']
      return jsonResponse(
        { error: { code: 'WAB_ROUTE_NOT_FOUND' } },
        404,
        {
          'X-WAB-Service': 'wab-server',
          'X-Correlation-ID': requestCorrelationId
        }
      )
    }) as typeof fetch
    const client = new WABClient('https://wab.example', { fetch: fetchClient })

    const request = client.getInfo()
    await expect(request).rejects.toMatchObject({
      code: 'WAB_HTTP_ERROR',
      status: 404,
      operation: 'get-info',
      endpointMarkerPresent: true,
      responseCorrelationMatched: true
    })
    await request.catch((error: WABClientError) => {
      expect(error.correlationId).toBe(requestCorrelationId)
    })
  })

  it('never includes request secrets in WAB or account-continuity telemetry', async () => {
    const events: TelemetryEvent[] = []
    const secretPhone = '+15555550123'
    const secretOtp = '928441'
    const existingPresentationKey = 'b'.repeat(64)
    let temporaryPresentationKey = ''

    const fetchClient = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        presentationKey: string
      }
      if (temporaryPresentationKey.length === 0) {
        temporaryPresentationKey = request.presentationKey
        return jsonResponse({ success: true })
      }
      return jsonResponse({
        success: true,
        presentationKey: existingPresentationKey
      })
    }) as typeof fetch

    const telemetry = {
      sink: {
        capture: (event: Readonly<TelemetryEvent>): void => {
          events.push(event)
        }
      },
      minimumSeverity: 'debug' as const,
      correlationIdFactory: () => 'support-correlation'
    }
    const wabClient = new WABClient('https://wab.example', {
      fetch: fetchClient,
      telemetry
    })
    const interactor: UMPTokenInteractor = {
      findByPresentationKeyHash: jest.fn(async () => undefined),
      findByRecoveryKeyHash: jest.fn(async () => undefined),
      buildAndSend: jest.fn(async () => `${'c'.repeat(64)}.0`)
    }
    const walletBuilder = async (): Promise<WalletInterface> => Object.create(null) as WalletInterface
    const manager = new WalletAuthenticationManager(
      'admin.example',
      walletBuilder,
      interactor,
      async (): Promise<true> => true,
      async () => 'password',
      wabClient,
      new DevConsoleInteractor(),
      undefined,
      { telemetry }
    )

    await manager.startAuth({ phoneNumber: secretPhone })
    await expect(manager.completeAuth({
      phoneNumber: secretPhone,
      otp: secretOtp
    })).rejects.toBeInstanceOf(WABAccountContinuityError)

    expect(manager.authenticationFlow).toBe('unknown')
    expect(temporaryPresentationKey).toMatch(/^[0-9a-f]{64}$/)

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(secretPhone)
    expect(serialized).not.toContain(secretOtp)
    expect(serialized).not.toContain(temporaryPresentationKey)
    expect(serialized).not.toContain(existingPresentationKey)
    expect(serialized).toContain('support-correlation')
    expect(serialized).toContain('account-continuity.mismatch')
  })

  it('rejects contradictory WAB account-continuity signals before UMP lookup', async () => {
    const wabClient = {
      startAuthMethod: jest.fn(async () => ({ success: true })),
      completeAuthMethod: jest.fn(async (
        _method: unknown,
        temporaryPresentationKey: string
      ) => ({
        success: true,
        presentationKey: `${temporaryPresentationKey[0] === '0' ? '1' : '0'}${temporaryPresentationKey.slice(1)}`,
        accountStatus: 'existing-user',
        existingUser: false
      }))
    } as unknown as WABClient
    const lookup = jest.fn(async () => undefined)
    const interactor: UMPTokenInteractor = {
      findByPresentationKeyHash: lookup,
      findByRecoveryKeyHash: jest.fn(async () => undefined),
      buildAndSend: jest.fn(async () => `${'c'.repeat(64)}.0`)
    }
    const manager = new WalletAuthenticationManager(
      'admin.example',
      async (): Promise<WalletInterface> => Object.create(null) as WalletInterface,
      interactor,
      async (): Promise<true> => true,
      async () => 'password',
      wabClient,
      new DevConsoleInteractor()
    )

    await manager.startAuth({})
    await expect(manager.completeAuth({})).rejects.toBeInstanceOf(WABAccountContinuityError)
    expect(lookup).not.toHaveBeenCalled()
    expect(manager.authenticationFlow).toBe('unknown')
  })
})
