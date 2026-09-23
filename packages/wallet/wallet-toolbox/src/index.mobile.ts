export * as sdk from './sdk/index'

export * from './utility/index.client'
export * from './storage/index.mobile'
export * from './services/chaintracker/chaintracks/index.mobile'
export * from './services/chaintracker/LocalChainTracker'

export * from './CWIStyleWalletManager'
export * from './monitor/Monitor'
export * from './sdk/PrivilegedKeyManager'
export * from './services/Services'
export * from './services/createDefaultWalletServicesOptions'
export * from './services/providers/ArcSSEClient'
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

// Additive: hosts need these to implement custom Monitor.addTask tasks, post
// signed requests to the network directly, exchange the storage remoting
// wire format, and verify unlocking scripts — none of which were reachable
// from this single-bundle mobile entry point before. Named exports only
// (not `export *`); each source module also exports internals that are not
// part of the mobile host surface.
export { WalletMonitorTask } from './monitor/tasks/WalletMonitorTask'
export { attemptToPostReqsToNetwork } from './storage/methods/attemptToPostReqsToNetwork'
export type { PostReqsToNetworkResult } from './storage/methods/attemptToPostReqsToNetwork'
export { parseJsonRpc, stringifyJsonRpc } from './storage/remoting/BinaryJson'
export { verifyUnlockScripts } from './signer/methods/verifyUnlockScripts'
export type { UnlockScriptVerificationResult } from './signer/methods/verifyUnlockScripts'
