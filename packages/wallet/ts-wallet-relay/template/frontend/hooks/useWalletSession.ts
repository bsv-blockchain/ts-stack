// Session management is now handled by the library.
// useWalletRelayClient is a drop-in replacement for the old manual hook —
// same { session, log, error, createSession, sendRequest } return shape.
//
// Options (all optional):
//   apiUrl       — backend base URL, default '/api'
//   pollInterval — status poll interval in ms, default 3000
//   autoCreate   — create session on mount, default true
//
// Example with options:
//   useWalletRelayClient({ apiUrl: 'https://api.example.com' })
export { useWalletRelayClient as useWalletSession } from '@bsv/wallet-relay/react'
