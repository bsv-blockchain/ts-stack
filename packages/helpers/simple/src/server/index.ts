/**
 * Server-side handler utilities — re-exports.
 */

// Handler types & utilities
export type { HandlerRequest, HandlerResponse, RouteHandler } from './handler-types'
export { getSearchParams, jsonResponse, toNextHandlers } from './handler-types'

// File persistence
export { JsonFileStore } from './json-file-store'

// Identity Registry
export type { RegistryResult } from './identity-registry'
export { IdentityRegistry, createIdentityRegistryHandler } from './identity-registry'

// DID Resolver
export { DIDResolverService, createDIDResolverHandler } from './did-resolver'

// Server Wallet Manager
export { ServerWalletManager, createServerWalletHandler } from './server-wallet-manager'

// Credential Issuer Handler
export { createCredentialIssuerHandler } from './credential-issuer-handler'
