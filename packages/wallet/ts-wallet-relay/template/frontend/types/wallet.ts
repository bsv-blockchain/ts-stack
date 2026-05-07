/**
 * UI-layer types for WalletActions and RequestLog.
 *
 * WalletRequest, WalletResponse, RequestLogEntry, and WalletMethodName are
 * provided by the library and re-exported here so existing component imports
 * keep working.
 *
 * NOTE: Extend WalletMethod with any additional methods your app will call
 *       on the mobile wallet (e.g. 'createAction', 'signAction').
 *       Keep this in sync with the actions array in components/WalletActions.tsx.
 */

export type { WalletRequest, WalletResponse, RequestLogEntry, WalletMethodName } from '@bsv/wallet-relay/client'

export type WalletMethod =
  | 'getPublicKey'
  // NOTE: add more methods as needed, e.g.:
  // | 'listOutputs'
  // | 'createAction'
  // | 'signAction'
