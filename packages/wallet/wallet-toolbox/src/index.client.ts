export * as sdk from './sdk/index'

export * from './utility/index.client'
export * from './storage/index.client'
export * from './services/chaintracker/index.client'

export * from './SetupClient'
export * from './SetupWallet'

export * from './CWIStyleWalletManager'
export * from './monitor/Monitor'
export * from './sdk/PrivilegedKeyManager'
export * from './services/Services'
export * from './services/createDefaultWalletServicesOptions'
export * from './signer/WalletSigner'
export * from './SimpleWalletManager'
export * from './wab-client/auth-method-interactors/AuthMethodInteractor'
export * from './wab-client/auth-method-interactors/PersonaIDInteractor'
export * from './wab-client/auth-method-interactors/TwilioPhoneInteractor'
export * from './wab-client/auth-method-interactors/DevConsoleInteractor'
export * from './wab-client/WABClient'
export * from './wab-client/WABTransport'
export * from './Wallet'
export * from './WalletLogger'
export * from './WalletAuthenticationManager'
export * from './WalletPermissionsManager'
export * from './WalletSettingsManager'

// Additive, for parity with index.mobile.ts: @bsv/wallet-toolbox-client is
// also published as a single bundle with no deep-import subpaths (see
// client/package.json `exports`), so browser hosts hit the same gap mobile
// hosts do for custom Monitor.addTask tasks, posting signed requests to the
// network directly, the storage remoting wire format, and unlock-script
// verification. Named exports only, matching index.mobile.ts.
export { WalletMonitorTask } from './monitor/tasks/WalletMonitorTask'
export { attemptToPostReqsToNetwork } from './storage/methods/attemptToPostReqsToNetwork'
export type { PostReqsToNetworkResult } from './storage/methods/attemptToPostReqsToNetwork'
export { parseJsonRpc, stringifyJsonRpc } from './storage/remoting/BinaryJson'
export { verifyUnlockScripts } from './signer/methods/verifyUnlockScripts'
export type { UnlockScriptVerificationResult } from './signer/methods/verifyUnlockScripts'
