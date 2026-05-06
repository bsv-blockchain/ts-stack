import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { QRPairingCode } from '../src/react/QRPairingCode.js'
import { useQRPairing } from '../src/react/useQRPairing.js'
import { renderHook, act } from '@testing-library/react'

const MOCK_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='
const MOCK_PAIRING_URI = 'wallet://pair?topic=abc&relay=wss%3A%2F%2Fapp.example.com&origin=https%3A%2F%2Fapp.example.com'

describe('QRPairingCode', () => {
  it('renders the QR image with the correct src', () => {
    render(<QRPairingCode qrDataUrl={MOCK_DATA_URL} pairingUri={MOCK_PAIRING_URI} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', MOCK_DATA_URL)
  })

  it('renders with default alt text', () => {
    render(<QRPairingCode qrDataUrl={MOCK_DATA_URL} pairingUri={MOCK_PAIRING_URI} />)
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'Scan with BSV wallet')
  })

  it('forwards imageProps to the img element', () => {
    render(
      <QRPairingCode
        qrDataUrl={MOCK_DATA_URL}
        pairingUri={MOCK_PAIRING_URI}
        imageProps={{ alt: 'Custom alt', className: 'qr-image', style: { width: 256 } }}
      />
    )
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('alt', 'Custom alt')
    expect(img).toHaveClass('qr-image')
  })

  it('spreads extra props onto the wrapper div (className, style, aria-label)', () => {
    render(
      <QRPairingCode
        qrDataUrl={MOCK_DATA_URL}
        pairingUri={MOCK_PAIRING_URI}
        className="wrapper"
        aria-label="QR code wrapper"
        data-testid="qr-wrapper"
      />
    )
    const wrapper = screen.getByTestId('qr-wrapper')
    expect(wrapper).toHaveClass('wrapper')
    expect(wrapper).toHaveAttribute('aria-label', 'QR code wrapper')
  })

  it('renders children instead of the default img when provided', () => {
    render(
      <QRPairingCode qrDataUrl={MOCK_DATA_URL} pairingUri={MOCK_PAIRING_URI}>
        <span data-testid="custom-child">custom renderer</span>
      </QRPairingCode>
    )
    expect(screen.getByTestId('custom-child')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('calls onPress with the pairingUri when clicked', () => {
    const onPress = jest.fn()
    render(
      <QRPairingCode
        qrDataUrl={MOCK_DATA_URL}
        pairingUri={MOCK_PAIRING_URI}
        onPress={onPress}
        data-testid="qr"
      />
    )
    fireEvent.click(screen.getByTestId('qr'))
    expect(onPress).toHaveBeenCalledWith(MOCK_PAIRING_URI)
  })

  it('calls onPress on Enter keydown', () => {
    const onPress = jest.fn()
    render(
      <QRPairingCode
        qrDataUrl={MOCK_DATA_URL}
        pairingUri={MOCK_PAIRING_URI}
        onPress={onPress}
        data-testid="qr"
      />
    )
    fireEvent.keyDown(screen.getByTestId('qr'), { key: 'Enter' })
    expect(onPress).toHaveBeenCalledWith(MOCK_PAIRING_URI)
  })

  it('calls onPress on Space keydown', () => {
    const onPress = jest.fn()
    render(
      <QRPairingCode
        qrDataUrl={MOCK_DATA_URL}
        pairingUri={MOCK_PAIRING_URI}
        onPress={onPress}
        data-testid="qr"
      />
    )
    fireEvent.keyDown(screen.getByTestId('qr'), { key: ' ' })
    expect(onPress).toHaveBeenCalledWith(MOCK_PAIRING_URI)
  })

  it('has role="button" and tabIndex=0 for accessibility', () => {
    render(
      <QRPairingCode qrDataUrl={MOCK_DATA_URL} pairingUri={MOCK_PAIRING_URI} data-testid="qr" />
    )
    const wrapper = screen.getByTestId('qr')
    expect(wrapper).toHaveAttribute('role', 'button')
    expect(wrapper).toHaveAttribute('tabindex', '0')
  })
})

describe('useQRPairing', () => {
  it('does not throw when open() is called without openUrl (uses window.location.href)', () => {
    // jsdom logs "Not implemented: navigation" but must not throw
    const { result } = renderHook(() => useQRPairing(MOCK_PAIRING_URI))
    expect(() => act(() => result.current.open())).not.toThrow()
  })

  it('calls openUrl with the pairingUri instead of navigating', () => {
    const openUrl = jest.fn()
    const { result } = renderHook(() => useQRPairing(MOCK_PAIRING_URI, { openUrl }))
    act(() => result.current.open())
    expect(openUrl).toHaveBeenCalledTimes(1)
    expect(openUrl).toHaveBeenCalledWith(MOCK_PAIRING_URI)
  })

  it('does not call window.location when openUrl is provided', () => {
    const openUrl = jest.fn()
    const hrefBefore = window.location.href
    const { result } = renderHook(() => useQRPairing(MOCK_PAIRING_URI, { openUrl }))
    act(() => result.current.open())
    expect(window.location.href).toBe(hrefBefore)  // unchanged
  })

  it('returns the pairingUri unchanged', () => {
    const { result } = renderHook(() => useQRPairing(MOCK_PAIRING_URI))
    expect(result.current.pairingUri).toBe(MOCK_PAIRING_URI)
  })
})
