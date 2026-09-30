export {
  ExpressTransport,
  InMemoryCertificateApprovalStore,
  createAuthMiddleware
} from './src/index.js'
export type {
  AuthMiddlewareOptions,
  AuthRequest,
  AuthTransportLimits,
  CertificateApprovalStore,
  LogLevel
} from './src/index.js'

export { guardAuthenticatedResponse } from './src/authenticatedResponseQueue.js'
export type {
  AuthenticatedResponseReplacement,
  AuthenticatedResponseCandidate,
  AuthenticatedResponseQueueGuard
} from './src/authenticatedResponseQueue.js'
