import type { SessionInfo } from '@bsv/wallet-relay/client'
import type { WalletMethod } from '../types/wallet'

interface Props {
  session: SessionInfo | null
  onRequest: (method: WalletMethod, params?: unknown) => void
}

// ── TODO: Define your wallet actions ─────────────────────────────────────────
//
// Each entry in this array becomes one button in the UI.
//
//   method — must match a WalletMethod in types/wallet.ts AND a method the
//            mobile wallet handler actually implements. If the mobile returns
//            a 501, the method is not handled on the mobile side.
//
//   label  — human-readable button text.
//
//   params — the params object forwarded to wallet[method](params) on the
//            mobile. Refer to the @bsv/sdk WalletInterface for the full
//            parameter shapes.
//
// Example actions (uncomment / extend as needed):
//
//   { method: 'getPublicKey',  label: 'Get Identity Key',  params: { identityKey: true } },
//   { method: 'listOutputs',   label: 'List Outputs',       params: { basket: 'default' } },
//   { method: 'createAction',  label: 'Create Action',      params: { description: 'test tx', outputs: [] } },

const actions: { method: WalletMethod; label: string; params?: unknown }[] = [
  // TODO: Replace or extend this list with your app's wallet actions.
  { method: 'getPublicKey', label: 'Get Public Key', params: { identityKey: true } },
]

// ─────────────────────────────────────────────────────────────────────────────

export function WalletActions({ session, onRequest }: Props) {
  const connected = session?.status === 'connected'

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
        Wallet Actions
      </h2>

      {actions.map(({ method, label, params }) => (
        <button
          key={method}
          disabled={!connected}
          onClick={() => onRequest(method, params)}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium
                     hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed
                     transition-colors"
        >
          {label}
        </button>
      ))}

      {!connected && (
        <p className="text-xs text-gray-400 text-center">
          Connect mobile wallet to enable actions
        </p>
      )}
    </div>
  )
}
