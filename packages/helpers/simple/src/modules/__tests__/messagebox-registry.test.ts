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

function jsonResponse(value: unknown): Response {
  return { json: jest.fn().mockResolvedValue(value) } as unknown as Response
}

function createCore(): WalletCore {
  return {
    defaults: {
      messageBoxHost: 'https://messagebox.example',
      registryUrl: REGISTRY_URL
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
    expect(fetch).toHaveBeenCalledWith(
      `${REGISTRY_URL}?action=register`,
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('returns the first registered MessageBox handle', async () => {
    jest
      .mocked(fetch)
      .mockResolvedValue(
        jsonResponse({ success: true, tags: [{ tag: 'alice' }, { tag: 'secondary' }] })
      )
    const methods = createMessageBoxMethods(createCore())

    await expect(methods.getMessageBoxHandle()).resolves.toBe('alice')
    expect(fetch).toHaveBeenCalledWith(
      `${REGISTRY_URL}?action=list&identityKey=${encodeURIComponent(IDENTITY_KEY)}`
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
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `${REGISTRY_URL}?action=revoke`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tag: 'alice', identityKey: IDENTITY_KEY })
      })
    )
  })

  it('does not revoke certifications when the registry list fails', async () => {
    jest.mocked(fetch).mockResolvedValue(jsonResponse({ success: false }))
    const methods = createMessageBoxMethods(createCore())

    await expect(methods.revokeMessageBoxCertification()).resolves.toBeUndefined()
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
})
