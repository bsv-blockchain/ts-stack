// ── React entry ───────────────────────────────────────────────────────────────
// Works in React (web) and React Native.
// Peer dependency: react >=17
//
// NOTE: This file is a barrel for consumers OUTSIDE the `react/` subdirectory.
// Files under `react/` MUST import siblings directly (e.g. `from './QRPairingCode.js'`)
// and NEVER through this barrel (`from '../react.js'`), to avoid the
// `react.tsx ↔ react/*` import cycles previously reported by SonarCloud / madge.
// See: https://github.com/bsv-blockchain/ts-stack/issues/41

export { QRPairingCode } from './react/QRPairingCode.js'
export type { QRPairingCodeProps } from './react/QRPairingCode.js'
export { useQRPairing } from './react/useQRPairing.js'

export { useWalletRelayClient } from './react/useWalletRelayClient.js'
export type { UseWalletRelayClientOptions } from './react/useWalletRelayClient.js'

export { QRDisplay } from './react/QRDisplay.js'
export type { QRDisplayProps } from './react/QRDisplay.js'

export { WalletConnectionModal } from './react/WalletConnectionModal.js'
export type { WalletConnectionModalProps } from './react/WalletConnectionModal.js'

export { RequestLog } from './react/RequestLog.js'
export type { RequestLogProps } from './react/RequestLog.js'
