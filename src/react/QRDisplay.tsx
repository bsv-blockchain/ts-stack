import React from 'react'
import type { SessionInfo } from '../types.js'
import { QRPairingCode, type QRPairingCodeProps } from './QRPairingCode.js'

export type QRDisplayProps = {
  /**
   * Current session. Renders a loading placeholder (data-state="loading") when null.
   * Pass the SessionInfo returned by WalletRelayClient or useWalletRelayClient.
   */
  session: SessionInfo | null
  /**
   * Called when the user clicks the refresh button (shown when status is "expired" or "disconnected").
   * Typically: `() => createSession()`
   */
  onRefresh: () => void
  /**
   * Props forwarded to the loading placeholder element.
   * Use to set className / style on the placeholder shown while session is null.
   */
  loadingProps?: React.HTMLAttributes<HTMLDivElement>
  /**
   * Props forwarded to the status text element.
   * The element also gets a `data-qr-status` attribute set to the current status value.
   */
  statusProps?: React.HTMLAttributes<HTMLSpanElement>
  /**
   * Props forwarded to the refresh button (rendered when status is "expired" or "disconnected").
   */
  refreshButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>
  /**
   * Props forwarded to the inner QRPairingCode component.
   * Use `qrProps.imageProps` to style the QR image, or `qrProps.onPress` to override deeplink.
   */
  qrProps?: Omit<QRPairingCodeProps, 'qrDataUrl' | 'pairingUri'>
} & React.HTMLAttributes<HTMLDivElement>

const STATUS_TEXT: Record<string, string> = {
  pending:      'Waiting for mobile...',
  connected:    'Mobile connected',
  disconnected: 'Mobile disconnected',
  expired:      'Session expired',
}

/**
 * Unstyled QR display with status indicator and session refresh.
 *
 * Shows a loading placeholder while `session` is null, then the QR code
 * with a status label. When the session expires a refresh button appears.
 *
 * All visual styling is up to the consumer — use `className` / `style` on
 * the root and element-level props for sub-elements. The root div and each
 * sub-element carry `data-*` attributes you can target with CSS selectors.
 *
 * @example
 * ```tsx
 * <QRDisplay
 *   session={session}
 *   onRefresh={createSession}
 *   className="flex flex-col items-center gap-4"
 *   qrProps={{ imageProps: { className: 'w-64 h-64' } }}
 *   statusProps={{ className: 'text-sm font-medium' }}
 *   refreshButtonProps={{ className: 'text-blue-600 hover:underline text-sm' }}
 * />
 * ```
 */
export function QRDisplay({
  session,
  onRefresh,
  loadingProps,
  statusProps,
  refreshButtonProps,
  qrProps,
  children,
  ...rootProps
}: QRDisplayProps) {
  if (!session) {
    return <div data-state="loading" {...loadingProps} />
  }

  const { status, qrDataUrl, pairingUri } = session
  const statusText     = STATUS_TEXT[status] ?? status
  const isExpired      = status === 'expired'
  const isDisconnected = status === 'disconnected'

  return (
    <div data-state={status} {...rootProps}>
      {qrDataUrl && pairingUri
        ? <QRPairingCode qrDataUrl={qrDataUrl} pairingUri={pairingUri} {...qrProps} />
        : children
      }
      <span data-qr-status={status} {...statusProps}>{statusText}</span>
      {(isExpired || isDisconnected) && (
        <button type="button" onClick={onRefresh} {...refreshButtonProps}>
          Generate new QR
        </button>
      )}
    </div>
  )
}
