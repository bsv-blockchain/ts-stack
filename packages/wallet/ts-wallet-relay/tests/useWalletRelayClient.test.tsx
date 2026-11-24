import { act, renderHook } from '@testing-library/react'
import { WalletRelayClient } from '../src/client/WalletRelayClient.js'
import { useWalletRelayClient } from '../src/react/useWalletRelayClient.js'

jest.mock('../src/client/WalletRelayClient.js', () => ({
  WalletRelayClient: jest.fn().mockImplementation(() => ({
    createSession: jest.fn(async () => ({ sessionId: 'session', status: 'pending' })),
    disconnect: jest.fn(async () => undefined)
  }))
}))

const ClientMock = WalletRelayClient as unknown as jest.Mock

describe('useWalletRelayClient', () => {
  beforeEach(() => ClientMock.mockClear())

  it.each([true, false, undefined])(
    'forwards allowLocalNetworkHttp=%s to WalletRelayClient',
    async allowLocalNetworkHttp => {
      const { result, unmount } = renderHook(() =>
        useWalletRelayClient({
          apiUrl: 'http://192.168.1.20:3000',
          allowLocalNetworkHttp,
          autoCreate: false
        })
      )
      await result.current.createSession()
      expect(ClientMock).toHaveBeenCalledTimes(1)
      expect(ClientMock.mock.calls[0][0]).toMatchObject({
        apiUrl: 'http://192.168.1.20:3000',
        allowLocalNetworkHttp
      })
      unmount()
    }
  )

  it('surfaces client errors reported after creation as hook error state', async () => {
    const { result, unmount } = renderHook(() => useWalletRelayClient({ autoCreate: false }))
    await result.current.createSession()
    const { onError } = ClientMock.mock.calls[0][0] as { onError: (error: string) => void }

    act(() => onError('relay URL must be WSS, except for loopback development'))

    expect(result.current.error).toBe('relay URL must be WSS, except for loopback development')
    unmount()
  })
})
