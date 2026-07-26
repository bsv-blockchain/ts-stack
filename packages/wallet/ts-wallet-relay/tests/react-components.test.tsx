import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { RequestLogEntry, SessionInfo } from '../src/types.js'
import { QRDisplay } from '../src/react/QRDisplay.js'
import { RequestLog } from '../src/react/RequestLog.js'
import { WalletConnectionModal } from '../src/react/WalletConnectionModal.js'
import { WalletClient } from '@bsv/sdk'

jest.mock('@bsv/sdk', () => ({
  WalletClient: jest.fn()
}))

const mockWalletClient = WalletClient as unknown as jest.Mock
let mockIsAuthenticated: jest.Mock

const session = (status: SessionInfo['status']): SessionInfo => ({
  sessionId: 'session-1',
  status,
  qrDataUrl: 'data:image/png;base64,test',
  pairingUri: 'wallet://pair?topic=session-1'
})

describe('QRDisplay', () => {
  it('renders a configurable loading state without a session', () => {
    render(
      <QRDisplay
        session={null}
        onRefresh={jest.fn()}
        loadingProps={{ 'aria-label': 'Loading wallet session', className: 'loading' }}
      />
    )
    expect(screen.getByLabelText('Loading wallet session')).toHaveAttribute('data-state', 'loading')
    expect(screen.getByLabelText('Loading wallet session')).toHaveClass('loading')
  })

  it('renders the QR code and human-readable connection state', () => {
    render(<QRDisplay session={session('connected')} onRefresh={jest.fn()} />)

    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,test')
    expect(screen.getByText('Mobile connected')).toHaveAttribute('data-qr-status', 'connected')
    expect(screen.queryByRole('button', { name: 'Generate new QR' })).not.toBeInTheDocument()
  })

  it.each(['expired', 'disconnected'] as const)('offers refresh when the session is %s', status => {
    const onRefresh = jest.fn()
    render(<QRDisplay session={session(status)} onRefresh={onRefresh} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate new QR' }))

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText(status === 'expired' ? 'Session expired' : 'Mobile disconnected')
    ).toBeInTheDocument()
  })

  it('uses child content and preserves unknown server status text', () => {
    render(
      <QRDisplay
        session={{ sessionId: 'session-1', status: 'future-status' as never }}
        onRefresh={jest.fn()}
      >
        <span>Custom pairing content</span>
      </QRDisplay>
    )

    expect(screen.getByText('Custom pairing content')).toBeInTheDocument()
    expect(screen.getByText('future-status')).toBeInTheDocument()
  })
})

function entry(requestId: string, state: 'pending' | 'error' | 'ok'): RequestLogEntry {
  return {
    request: {
      requestId,
      method: 'getPublicKey',
      params: {},
      timestamp: 1
    },
    pending: state === 'pending',
    response:
      state === 'pending'
        ? undefined
        : {
            requestId,
            timestamp: 2,
            ...(state === 'error'
              ? { error: { code: 500, message: 'failed' } }
              : { result: { publicKey: '02abc' } })
          }
  }
}

describe('RequestLog', () => {
  it('renders the default and custom empty states', () => {
    const { rerender } = render(<RequestLog entries={[]} />)
    expect(screen.getByText('No requests yet')).toHaveAttribute('data-state', 'empty')

    rerender(<RequestLog entries={[]}>Nothing has happened</RequestLog>)
    expect(screen.getByText('Nothing has happened')).toBeInTheDocument()
  })

  it('labels pending, error, and successful responses', () => {
    render(
      <RequestLog
        entries={[entry('pending', 'pending'), entry('error', 'error'), entry('ok', 'ok')]}
        aria-label="request history"
      />
    )

    expect(screen.getByLabelText('request history').querySelectorAll('[data-state]')).toHaveLength(
      3
    )
    expect(screen.getByText(/"message": "failed"/)).toBeInTheDocument()
    expect(screen.getByText(/02abc/)).toBeInTheDocument()
    expect(screen.getAllByText('pending')).toHaveLength(1)
    expect(screen.getAllByText('error')).toHaveLength(1)
    expect(screen.getAllByText('ok')).toHaveLength(1)
  })
})

describe('WalletConnectionModal', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockIsAuthenticated = jest.fn()
    mockWalletClient.mockReset().mockImplementation(() => ({
      isAuthenticated: mockIsAuthenticated
    }))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('calls back without rendering choices when a local wallet is authenticated', async () => {
    mockIsAuthenticated.mockResolvedValueOnce(true)
    const onLocalWallet = jest.fn()
    render(<WalletConnectionModal onLocalWallet={onLocalWallet} onMobileQR={jest.fn()} />)

    await act(async () => {
      await jest.runAllTimersAsync()
    })

    expect(onLocalWallet).toHaveBeenCalledWith(
      expect.objectContaining({ isAuthenticated: mockIsAuthenticated })
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers install and mobile choices when no local wallet is available', async () => {
    mockIsAuthenticated.mockResolvedValueOnce(false)
    const onMobileQR = jest.fn()
    render(
      <WalletConnectionModal
        onLocalWallet={jest.fn()}
        onMobileQR={onMobileQR}
        installLabel="Get a wallet"
        mobileLabel="Use phone"
      />
    )

    await act(async () => {
      await jest.runAllTimersAsync()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use phone' }))

    expect(screen.getByRole('link', { name: 'Get a wallet' })).toHaveAttribute(
      'href',
      'https://desktop.bsvb.tech'
    )
    expect(onMobileQR).toHaveBeenCalledTimes(1)
  })

  it('supports custom fallback content', async () => {
    mockIsAuthenticated.mockRejectedValueOnce(new Error('wallet unavailable'))
    render(
      <WalletConnectionModal onLocalWallet={jest.fn()} onMobileQR={jest.fn()}>
        <span>Choose another wallet</span>
      </WalletConnectionModal>
    )

    await act(async () => {
      await jest.runAllTimersAsync()
    })

    expect(screen.getByText('Choose another wallet')).toBeInTheDocument()
  })
})
