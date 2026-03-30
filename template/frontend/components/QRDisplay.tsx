import { QRDisplay as QRDisplayBase } from '@bsv/wallet-relay/react'
import type { SessionInfo } from '@bsv/wallet-relay/client'

// TODO: Adjust status colours to match your design system.
const statusColor: Record<string, string> = {
  pending:      'bg-yellow-100 text-yellow-800',
  connected:    'bg-green-100 text-green-800',
  disconnected: 'bg-gray-100 text-gray-600',
  expired:      'bg-red-100 text-red-700',
}

interface Props {
  session: SessionInfo | null
  onRefresh: () => void
}

export function QRDisplay({ session, onRefresh }: Props) {
  const status = session?.status ?? 'pending'
  return (
    <QRDisplayBase
      session={session}
      onRefresh={onRefresh}
      className="flex flex-col items-center gap-4"
      loadingProps={{ className: 'w-64 h-64 bg-gray-100 rounded-xl animate-pulse' }}
      qrProps={{
        className: 'w-64 h-64 rounded-xl overflow-hidden border border-gray-200 shadow-sm',
        imageProps: { className: 'w-full h-full', alt: 'Scan to connect mobile wallet' },
      }}
      statusProps={{
        className: `px-3 py-1 rounded-full text-xs font-medium ${statusColor[status] ?? 'bg-gray-100 text-gray-600'}`,
      }}
      refreshButtonProps={{ className: 'text-sm text-blue-600 hover:underline' }}
    />
  )
}
