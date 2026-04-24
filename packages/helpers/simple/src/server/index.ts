/**
 * Server-side handler utilities — re-exports.
 */

// Handler types & utilities
export {
  HandlerRequest,
  HandlerResponse,
  RouteHandler,
  getSearchParams,
  jsonResponse,
  toNextHandlers
} from './handler-types'

// File persistence
export { JsonFileStore } from './json-file-store'

// Identity Registry
export { IdentityRegistry, RegistryResult, createIdentityRegistryHandler } from './identity-registry'

// DID Resolver
export { DIDResolverService, createDIDResolverHandler } from './did-resolver'

// Server Wallet Manager
export { ServerWalletManager, createServerWalletHandler } from './server-wallet-manager'

// Credential Issuer Handler
export { createCredentialIssuerHandler } from './credential-issuer-handler'
