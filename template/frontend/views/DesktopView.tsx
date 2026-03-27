/**
 * DesktopView — drop this into your app and render it on whatever route
 * should handle wallet connection.
 *
 * Flow:
 *   1. Silently checks for a local BSV wallet (MetaNet Client / BabbageSDK).
 *   2. Found    → calls onLocalWallet; you can use that wallet directly in your app.
 *   3. Not found → shows a modal: "Install wallet" or "Connect via Mobile QR".
 *   4. Mobile QR chosen → QR session is created and the pairing UI is shown.
 *
 * Example (App.tsx with react-router-dom):
 *
 *   import { BrowserRouter, Route, Routes } from 'react-router-dom'
 *   import { DesktopView } from './views/DesktopView'
 *
 *   export default function App() {
 *     return (
 *       <BrowserRouter>
 *         <Routes>
 *           <Route path="/" element={<DesktopView />} />
 *         </Routes>
 *       </BrowserRouter>
 *     )
 *   }
 *
 * TODO: Tailor the heading / description text to your application.
 * TODO: In onLocalWallet, store the wallet and use it for your app's wallet calls.
 */

import { useCallback, useState } from 'react'
import { WalletClient } from '@bsv/sdk'
import { WalletConnectionModal } from '../components/WalletConnectionModal'
import { QRDisplay }             from '../components/QRDisplay'
import { WalletActions }         from '../components/WalletActions'
import { RequestLog }            from '../components/RequestLog'
import { useWalletSession }      from '../hooks/useWalletSession'

type WalletMode = 'detecting' | 'local' | 'mobile'

// ── Mobile QR content ─────────────────────────────────────────────────────────
// Separated into its own component so useWalletSession (which creates a backend
// session on mount) only runs when the user has actually chosen the mobile path.

export function MobileQRContent() {
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

// ── Main view ─────────────────────────────────────────────────────────────────

export function DesktopView() {
  const [mode, setMode] = useState<WalletMode>('detecting')

  const handleLocalWallet = useCallback((wallet: WalletClient) => {
    setMode('local')
    // TODO: store `wallet` in your app state / context and use it for wallet calls.
    // e.g. setAppWallet(wallet) or dispatch({ type: 'WALLET_READY', wallet })
    console.log('[DesktopView] local wallet connected', wallet)
  }, [])

  const handleMobileQR = useCallback(() => {
    setMode('mobile')
  }, [])

  return (
    <>
      {/* Modal is rendered (but invisible) during detection, shown if no wallet found */}
      {mode === 'detecting' && (
        <WalletConnectionModal
          onLocalWallet={handleLocalWallet}
          onMobileQR={handleMobileQR}
        />
      )}

      {/* Local wallet — TODO: replace this placeholder with your app's main UI */}
      {mode === 'local' && (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-1">Wallet connected</h2>
            <p className="text-sm text-gray-500">
              {/* TODO: render your app content here using the local wallet */}
              Local BSV wallet is ready. Wire it into your app above in handleLocalWallet.
            </p>
          </div>
        </div>
      )}

      {/* Mobile QR — session only created when user explicitly chose this path */}
      {mode === 'mobile' && <MobileQRContent />}
    </>
  )
}
