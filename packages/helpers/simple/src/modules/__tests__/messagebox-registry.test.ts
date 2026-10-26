import { PeerPayClient } from '@bsv/message-box-client'
import { WalletCore } from '../../core/WalletCore'
import { createMessageBoxMethods } from '../messagebox'

jest.mock('@bsv/message-box-client', () => ({
  PeerPayClient: jest.fn().mockImplementation(() => ({
    anointHost: jest.fn().mockResolvedValue({ txid: 'anointment-txid' })
  }))
}))

const IDENTITY_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const REGISTRY_URL = 'https://registry.example/api'

function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) }
  })
}

function createCore(defaultOverrides: Record<string, unknown> = {}): WalletCore {
  return {
    defaults: {
      messageBoxHost: 'https://messagebox.example',
      registryUrl: REGISTRY_URL,
      registryFetch: async (...args: Parameters<typeof fetch>) => await globalThis.fetch(...args),
      ...defaultOverrides
    },
    getClient: jest.fn().mockReturnValue({}),
    getIdentityKey: jest.fn().mockReturnValue(IDENTITY_KEY)
  } as unknown as WalletCore
}

describe('MessageBox identity-registry methods', () => {
  beforeEach(() => {
    global.fetch = jest.fn()
    jest.clearAllMocks()
  })

  it('anoints the MessageBox host and registers its handle', async () => {
    jest.mocked(fetch).mockResolvedValue(jsonResponse({ success: true }))
    const methods = createMessageBoxMethods(createCore())

    await expect(methods.certifyForMessageBox('alice')).resolves.toEqual({
      txid: 'anointment-txid',
      handle: 'alice'
    })
    expect(PeerPayClient).toHaveBeenCalledWith(
      expect.objectContaining({ messageBoxHost: 'https://messagebox.example' })
    )
    expect(jest.mocked(fetch).mock.calls[0][0].toString()).toBe(`${REGISTRY_URL}?action=register`)
    expect(jest.mocked(fetch).mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST' }))
  })

  it('returns the first registered MessageBox handle', async () => {
    jest
      .mocked(fetch)
      .mockResolvedValue(
        jsonResponse({ success: true, tags: [{ tag: 'alice' }, { tag: 'secondary' }] })
      )
    const methods = createMessageBoxMethods(createCore())

    await expect(methods.getMessageBoxHandle()).resolves.toBe('alice')
    expect(jest.mocked(fetch).mock.calls[0][0].toString()).toBe(
      `${REGISTRY_URL}?action=list&identityKey=${encodeURIComponent(IDENTITY_KEY)}`
    )
    expect(jest.mocked(fetch).mock.calls[0][1]).toEqual(
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })
    )
  })

  it.each([{ success: false }, { success: true }, { success: true, tags: [] }])(
    'returns no handle for an empty registry result %#',
    async response => {
      jest.mocked(fetch).mockResolvedValue(jsonResponse(response))
      const methods = createMessageBoxMethods(createCore())

      await expect(methods.getMessageBoxHandle()).resolves.toBeNull()
    }
  )

  it('lists and revokes every MessageBox certification', async () => {
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ success: true, tags: [{ tag: 'alice' }, { tag: 'secondary' }] })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
    const methods = createMessageBoxMethods(createCore())

    await expect(methods.revokeMessageBoxCertification()).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(jest.mocked(fetch).mock.calls[1][0].toString()).toBe(`${REGISTRY_URL}?action=revoke`)
    expect(jest.mocked(fetch).mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tag: 'alice', identityKey: IDENTITY_KEY })
      })
    )
  })

  it('does not report successful revocation when the registry list fails', async () => {
    jest.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }))
    const methods = createMessageBoxMethods(createCore())

    await expect(methods.revokeMessageBoxCertification()).rejects.toThrow(
      'MessageBox revocation failed: Registry list failed'
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('registers, looks up, lists, and revokes identity tags', async () => {
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ success: true, tag: 'alice@bsv' }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          results: [{ tag: 'alice@bsv', identityKey: IDENTITY_KEY }]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          tags: [{ tag: 'alice@bsv', createdAt: '2026-07-26T00:00:00.000Z' }]
        })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
    const methods = createMessageBoxMethods(createCore())

    await expect(methods.registerIdentityTag('alice')).resolves.toEqual({ tag: 'alice@bsv' })
    await expect(methods.lookupIdentityByTag('alice')).resolves.toEqual([
      { tag: 'alice@bsv', identityKey: IDENTITY_KEY }
    ])
    await expect(methods.listMyTags()).resolves.toEqual([
      { tag: 'alice@bsv', createdAt: '2026-07-26T00:00:00.000Z' }
    ])
    await expect(methods.revokeIdentityTag('alice@bsv')).resolves.toBeUndefined()
  })

  it('rejects truthy non-boolean operation verdicts and HTTP failures', async () => {
    const methods = createMessageBoxMethods(createCore())
    jest.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: 'false', tag: 'alice' }))

    await expect(methods.registerIdentityTag('alice')).rejects.toThrow('Registration failed')

    jest.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true, tag: 'alice' }, 500))
    await expect(methods.registerIdentityTag('alice')).rejects.toThrow('Registry returned HTTP 500')
  })

  it('rejects malformed and oversized lookup results', async () => {
    const methods = createMessageBoxMethods(createCore())
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ success: true, results: [{ tag: 'alice', identityKey: 'not-a-key' }] })
      )

    await expect(methods.lookupIdentityByTag('alice')).rejects.toThrow(
      'Registry identityKey must be a compressed public key'
    )

    jest.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        success: true,
        results: Array.from({ length: 257 }, () => ({ tag: 'alice', identityKey: IDENTITY_KEY }))
      })
    )
    await expect(methods.lookupIdentityByTag('alice')).rejects.toThrow(
      'Registry returned a malformed lookup collection'
    )

    jest.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true, results: [null] }))
    await expect(methods.lookupIdentityByTag('alice')).rejects.toThrow(
      'Registry returned a malformed lookup row'
    )
  })

  it('rejects declared oversized registry responses before consuming the body', async () => {
    const methods = createMessageBoxMethods(createCore())
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({ success: true }, 200, { 'Content-Length': String(256 * 1024 + 1) })
      )

    await expect(methods.registerIdentityTag('alice')).rejects.toThrow(
      'Registry response exceeds the configured limit'
    )
  })

  it('rejects private registry destinations unless an explicit trusted transport is supplied', async () => {
    const methods = createMessageBoxMethods(
      createCore({ registryUrl: 'https://127.0.0.1/private-registry', registryFetch: undefined })
    )

    await expect(methods.registerIdentityTag('alice')).rejects.toThrow(
      'Restricted HTTPS request targets a non-public address'
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
