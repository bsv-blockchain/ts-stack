/**
 * WalletConnectionModal
 *
 * Detects whether a local BSV wallet (MetaNet Client / BabbageSDK) is available.
 * If found, calls onLocalWallet immediately — no UI shown.
 * If not found, shows a modal giving the user two options:
 *   1. Install a BSV wallet
 *   2. Connect via mobile QR (your existing mobile pairing flow)
 *
 * Usage:
 *   <WalletConnectionModal
 *     onLocalWallet={(wallet) => { ... }}
 *     onMobileQR={() => { ... }}
 *   />
 *
 * TODO: Update installUrl to point to your target wallet's download/install page.
 */

import { WalletConnectionModal as WalletConnectionModalBase } from 'qr-lib/react'
import type { WalletClient } from '@bsv/sdk'

interface Props {
  /** Called immediately when a local wallet is detected and authenticated. */
  onLocalWallet: (wallet: WalletClient) => void
  /** Called when the user clicks "Connect via Mobile QR". */
  onMobileQR: () => void
  /**
   * URL to send the user to if they want to install a BSV wallet.
   * TODO: replace with the correct install URL for your target platform.
   */
  installUrl?: string
}

export function WalletConnectionModal({ onLocalWallet, onMobileQR, installUrl }: Props) {
  return (
    <WalletConnectionModalBase
      onLocalWallet={onLocalWallet}
      onMobileQR={onMobileQR}
      installUrl={installUrl}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
    >
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm mx-4">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Connect your wallet</h2>
        <p className="text-sm text-gray-500 mb-6">
          No local wallet detected. Install a BSV wallet or connect your
          mobile wallet by scanning a QR code.
        </p>
        <div className="flex flex-col gap-3">
          <a
            href={installUrl ?? 'https://desktop.bsvb.tech'}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-3 px-4 rounded-xl bg-blue-600 text-white text-sm font-medium text-center hover:bg-blue-700 transition-colors"
          >
            Install BSV Wallet
          </a>
          <button
            type="button"
            onClick={onMobileQR}
            className="w-full py-3 px-4 rounded-xl border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            Connect via Mobile QR
          </button>
        </div>
      </div>
    </WalletConnectionModalBase>
  )
}
