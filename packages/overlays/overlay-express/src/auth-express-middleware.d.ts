declare module '@bsv/auth-express-middleware' {
  import type { RequestHandler } from 'express'

  export interface AuthRequest {
    auth?: {
      identityKey?: string
      certificates?: Array<{
        certifier?: string
        type?: string
        decryptedFields?: Record<string, any>
      }>
    }
  }

  export function createAuthMiddleware (config: Record<string, any>): RequestHandler
}
