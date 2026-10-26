import {
  fetchBoundedJson,
  developmentHostKind,
  normalizeHttpOrigin,
  normalizeRelayUrl,
  parseRpcMessage,
  parseWireEnvelope,
  requireOptionalBoolean,
  validatePairingParams,
  validateSessionInfo
} from '../src/shared/validation.js'
import { base64urlToBytes } from '../src/shared/encoding.js'
import { PROTOCOL_ID } from '../src/types.js'
import {
  ipv4,
  LOCAL_NETWORK_AUTHORITIES,
  LOOPBACK_AUTHORITIES,
  PUBLIC_AUTHORITIES
} from './fixtures/localDevelopmentHosts.js'

const SESSION_ID = 'A'.repeat(43)
const RPC_ID = '00000000-0000-4000-8000-000000000001'

describe('wallet relay untrusted-data boundaries', () => {
  it('accepts only canonical unpadded base64url', () => {
    expect(base64urlToBytes('AQID')).toEqual([1, 2, 3])
    for (const encoded of ['', 'A', 'AQI=', 'AQI+', 'AQI/', 'AB']) {
      expect(() => base64urlToBytes(encoded)).toThrow(/canonical base64url/)
    }
  })

  it('requires exact RPC request and response framing', () => {
    expect(parseRpcMessage({ id: RPC_ID, seq: 1, result: { ok: true } })).toEqual({
      id: RPC_ID,
      seq: 1,
      result: { ok: true }
    })
    expect(() =>
      parseRpcMessage({ id: RPC_ID, seq: 1, result: {}, error: { code: 1, message: 'x' } })
    ).toThrow(/exactly one/)
    expect(() => parseRpcMessage({ id: RPC_ID, seq: 1, result: {}, method: 'confused' })).toThrow()
    expect(() => parseRpcMessage({ id: 'predictable', seq: 1, result: {} })).toThrow(/RPC ID/)
    expect(() => parseRpcMessage({ id: RPC_ID, seq: 0, result: {} })).toThrow(/positive/)
    expect(() => parseRpcMessage({ id: RPC_ID, seq: 1, result: {}, extra: true })).toThrow(
      /exact protocol object/
    )
  })

  it('binds a wire envelope to its connected topic and rejects surplus fields', () => {
    expect(parseWireEnvelope({ topic: SESSION_ID, ciphertext: 'AQID' }, SESSION_ID)).toEqual({
      topic: SESSION_ID,
      ciphertext: 'AQID'
    })
    expect(() =>
      parseWireEnvelope({ topic: 'B'.repeat(43), ciphertext: 'AQID' }, SESSION_ID)
    ).toThrow(/connected session topic/)
    expect(() =>
      parseWireEnvelope({ topic: SESSION_ID, ciphertext: 'AQID', plaintext: 'steal' }, SESSION_ID)
    ).toThrow(/exact protocol object/)
  })

  it('requires service session responses to carry canonical bearer identifiers', () => {
    expect(validateSessionInfo({ sessionId: SESSION_ID, status: 'pending' })).toEqual({
      sessionId: SESSION_ID,
      status: 'pending'
    })
    expect(() => validateSessionInfo({ sessionId: 'guessable', status: 'pending' })).toThrow(
      /sessionId/
    )
    expect(() => validateSessionInfo({ sessionId: SESSION_ID, status: 'invented' })).toThrow(
      /supported session status/
    )
  })

  it('rejects executable pairing links and non-PNG session artwork', () => {
    for (const scheme of ['javascript', 'vbscript']) {
      expect(() =>
        validateSessionInfo({
          sessionId: SESSION_ID,
          status: 'pending',
          pairingUri: `${scheme}://pair?topic=owned`
        })
      ).toThrow(/non-web wallet deep-link scheme/)
    }
    expect(() =>
      validateSessionInfo({
        sessionId: SESSION_ID,
        status: 'pending',
        qrDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
      })
    ).toThrow(/PNG data URL/)
    expect(() =>
      validateSessionInfo({
        sessionId: SESSION_ID,
        status: 'pending',
        qrDataUrl: 'data:image/png;base64,PHN2Zz48L3N2Zz4='
      })
    ).toThrow(/PNG data URL/)
  })

  it('requires encrypted relay transport except on loopback', () => {
    expect(normalizeRelayUrl('wss://relay.example/ws')).toBe('wss://relay.example/ws')
    expect(normalizeRelayUrl('ws://localhost:3000')).toBe('ws://localhost:3000')
    expect(() => normalizeRelayUrl('ws://relay.example')).toThrow(/WSS/)
    expect(() => normalizeRelayUrl('wss://user:secret@relay.example')).toThrow(/credential-free/)
    expect(() => normalizeRelayUrl('wss://relay.example?next=evil')).toThrow(/query/)
  })

  it.each(LOOPBACK_AUTHORITIES)(
    'allows plain HTTP and WS for loopback host %s by default',
    authority => {
      const { hostname, origin } = new URL(`http://${authority}`)
      expect(developmentHostKind(hostname)).toBe('loopback')
      expect(normalizeHttpOrigin(`http://${authority}`)).toBe(origin)
      expect(normalizeRelayUrl(`ws://${authority}/ws`)).toBe(`ws://${new URL(origin).host}/ws`)
    }
  )

  it.each(LOCAL_NETWORK_AUTHORITIES)(
    'requires allowLocalNetworkHttp for plain HTTP and WS on private-network host %s',
    authority => {
      const { hostname, origin } = new URL(`http://${authority}`)
      expect(developmentHostKind(hostname)).toBe('local-network')
      // The default text is safe for wallet users; only developerHint names the option.
      const hint =
        ', except for loopback development (set allowLocalNetworkHttp: true to allow private-network IP addresses in development)'
      expect(() => normalizeHttpOrigin(`http://${authority}`)).toThrow(
        /^origin must be HTTPS, except for loopback development$/u
      )
      expect(() =>
        normalizeRelayUrl(`ws://${authority}/ws`, 'relay URL', { allowLocalNetworkHttp: false })
      ).toThrow(/^relay URL must be WSS, except for loopback development$/u)
      expect(() =>
        normalizeHttpOrigin(`http://${authority}`, 'origin', { developerHint: true })
      ).toThrow(`origin must be HTTPS${hint}`)
      expect(() =>
        normalizeRelayUrl(`ws://${authority}/ws`, 'relay URL', { developerHint: true })
      ).toThrow(`relay URL must be WSS${hint}`)
      const allow = { allowLocalNetworkHttp: true }
      expect(normalizeHttpOrigin(`http://${authority}`, 'origin', allow)).toBe(origin)
      expect(normalizeRelayUrl(`ws://${authority}/ws`, 'relay URL', allow)).toBe(
        `ws://${new URL(origin).host}/ws`
      )
    }
  )

  it('validates pairing params under the loopback-only policy when no options are given', () => {
    const params = {
      topic: SESSION_ID,
      // Compressed public key of private key 1 (the secp256k1 generator point).
      backendIdentityKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      protocolID: JSON.stringify(PROTOCOL_ID),
      origin: 'http://localhost:5173',
      expiry: String(Math.floor(Date.now() / 1_000) + 60)
    }
    expect(validatePairingParams(params)).toBe(params)
    expect(() =>
      validatePairingParams({ ...params, origin: `http://${ipv4(192, 168, 1, 20)}:5173` })
    ).toThrow(/^pairing origin must be HTTPS, except for loopback development$/u)
  })

  it.each(PUBLIC_AUTHORITIES)(
    'requires HTTPS and WSS for public or ambiguous host %s even with allowLocalNetworkHttp',
    authority => {
      expect(developmentHostKind(new URL(`http://${authority}`).hostname)).toBeNull()
      expect(() => normalizeHttpOrigin(`http://${authority}`)).toThrow(
        /^origin must be HTTPS, except for loopback development$/u
      )
      expect(() => normalizeRelayUrl(`ws://${authority}`)).toThrow(
        /^relay URL must be WSS, except for loopback development$/u
      )
      const allow = { allowLocalNetworkHttp: true }
      expect(() => normalizeHttpOrigin(`http://${authority}`, 'origin', allow)).toThrow(
        'origin must be HTTPS, except for loopback or local-network development'
      )
      expect(() => normalizeRelayUrl(`ws://${authority}`, 'relay URL', allow)).toThrow(
        'relay URL must be WSS, except for loopback or local-network development'
      )
      expect(normalizeHttpOrigin(`https://${authority}`)).toBe(
        new URL(`https://${authority}`).origin
      )
    }
  )

  it('applies allowLocalNetworkHttp to relay URLs in session responses', () => {
    const lan = { sessionId: SESSION_ID, status: 'pending', relay: 'ws://192.168.1.20:3000' }
    expect(() => validateSessionInfo(lan)).toThrow(
      /^relay URL must be WSS, except for loopback development$/u
    )
    expect(() => validateSessionInfo(lan, { developerHint: true })).toThrow('allowLocalNetworkHttp')
    expect(validateSessionInfo(lan, { allowLocalNetworkHttp: true }).relay).toBe(
      'ws://192.168.1.20:3000'
    )
  })

  it('rejects a non-boolean allowLocalNetworkHttp instead of coercing it', () => {
    for (const value of ['true', 'false', 1, null]) {
      expect(() => requireOptionalBoolean(value, 'allowLocalNetworkHttp')).toThrow(
        'allowLocalNetworkHttp must be a boolean'
      )
    }
    expect(requireOptionalBoolean(undefined, 'allowLocalNetworkHttp')).toBe(false)
    expect(requireOptionalBoolean(true, 'allowLocalNetworkHttp')).toBe(true)
  })

  it('normalises integer and hex IPv4 forms before classifying them', () => {
    expect(
      normalizeHttpOrigin('http://3232235777:3000', 'origin', { allowLocalNetworkHttp: true })
    ).toBe('http://192.168.1.1:3000')
    expect(normalizeRelayUrl('ws://0x7f.1:3000')).toBe('ws://127.0.0.1:3000')
  })

  it('accepts only parser-canonical IP literals when classifying a raw hostname', () => {
    for (const hostname of ['localhost', 'a.localhost', '127.0.0.1', '127.255.0.1', '[::1]']) {
      expect(developmentHostKind(hostname)).toBe('loopback')
    }
    for (const hostname of [
      ipv4(192, 168, 1, 20),
      ipv4(10, 0, 0, 1),
      ipv4(172, 16, 0, 1),
      '[fd00::1]'
    ]) {
      expect(developmentHostKind(hostname)).toBe('local-network')
    }
    for (const hostname of [
      '',
      '0x7f.1',
      '3232235777',
      '010.0.0.1',
      '192.168.01.1',
      '192.168.1.256',
      '192.168.1',
      '192.168.1.1.',
      'fd00::1',
      '[fd0::1]',
      '[fd000::1]',
      '[fc00::1',
      '192.168.1.1/24'
    ]) {
      expect(developmentHostKind(hostname)).toBeNull()
    }
  })

  it('bounds response bodies, rejects invalid UTF-8, and disables redirects', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
    try {
      fetchMock.mockResolvedValueOnce(new Response('x'.repeat(33)))
      await expect(
        fetchBoundedJson('https://relay.example/status', {}, 'status response', { maxBytes: 32 })
      ).rejects.toThrow(/32-byte limit/)

      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])))
      await expect(
        fetchBoundedJson('https://relay.example/status', {}, 'status response')
      ).rejects.toThrow(/valid UTF-8/)

      expect(fetchMock).toHaveBeenCalledWith(
        'https://relay.example/status',
        expect.objectContaining({ redirect: 'error', signal: expect.anything() })
      )
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('safely supports non-streaming fetch implementations only with bounded lengths', async () => {
    const encoded = new TextEncoder().encode('{"status":"pending"}')
    const nonStreamingResponse = {
      headers: new Headers({ 'content-length': String(encoded.length) }),
      body: null,
      arrayBuffer: async () => encoded.buffer
    } as Response
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(nonStreamingResponse)
    try {
      await expect(
        fetchBoundedJson('https://relay.example/status', {}, 'status response')
      ).resolves.toMatchObject({ value: { status: 'pending' } })

      fetchMock.mockResolvedValueOnce({ ...nonStreamingResponse, headers: new Headers() })
      await expect(
        fetchBoundedJson('https://relay.example/status', {}, 'status response')
      ).rejects.toThrow(/could not be read within/)
    } finally {
      fetchMock.mockRestore()
    }
  })
})
