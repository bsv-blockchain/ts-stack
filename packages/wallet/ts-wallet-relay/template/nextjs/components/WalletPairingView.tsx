'use client'

/**
 * WalletPairingView — drop this into a Next.js page.
 *
 * Because this component uses client-side hooks it must be used inside a
 * Client Component tree. The simplest approach is a dedicated page:
 *
 *   // app/wallet/page.tsx
 *   import { WalletPairingView } from '../../components/WalletPairingView'
 *   export default function WalletPage() {
 *     return <WalletPairingView />
 *   }
 *
 * TODO: Update the heading and subtitle to match your application.
 */

import { QRDisplay }        from './QRDisplay'
import { WalletActions }    from './WalletActions'
import { RequestLog }       from './RequestLog'
import { useWalletSession } from '../hooks/useWalletSession'

export function WalletPairingView() {
  const { session, log, error, createSession, sendRequest } = useWalletSession()

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-3xl">
        {/* TODO: Update this heading and subtitle for your app */}
        <h1 className="text-3xl font-bold text-gray-900 mb-1">BSV Mobile Wallet</h1>
        <p className="text-gray-500 mb-8 text-sm">
          Scan the QR code with your mobile wallet to connect
        </p>

        {error && (
          <div className="mb-6 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="flex flex-col items-center gap-6">
            <QRDisplay session={session} onRefresh={createSession} />
            {session && (
              <p className="text-xs text-gray-400 text-center break-all">
                Session: {session.sessionId}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-6">
            <WalletActions session={session} onRequest={sendRequest} />
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Request Log
              </h2>
              <RequestLog entries={log} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
