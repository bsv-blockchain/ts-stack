/**
 * Credential Issuer Handler — issue, verify, revoke W3C Verifiable Credentials.
 *
 * Handles both:
 *   - Query-param based endpoints (?action=info|schema|certify|issue|verify|revoke|status)
 *   - Legacy path-based endpoints (/api/info, /api/certify) for backward compatibility
 *
 * createCredentialIssuerHandler() returns Next.js App Router compatible { GET, POST }.
 */

import { join } from 'node:path'
import { CredentialIssuerHandlerConfig } from '../core/types'
import { JsonFileStore } from './json-file-store'
import { ServerWalletManager } from './server-wallet-manager'
import {
  HandlerRequest,
  HandlerResponse,
  getSearchParams,
  jsonResponse,
  toNextHandlers
} from './handler-types'

// ============================================================================
// Lazy issuer singleton
// ============================================================================

function createIssuerFactory (
  config: CredentialIssuerHandlerConfig
): () => Promise<any> {
  let issuerInstance: any = null
  let issuerInitPromise: Promise<any> | null = null

  const envVar = config.envVar ?? 'CREDENTIAL_ISSUER_KEY'
  const keyFile = config.keyFile ?? join(process.cwd(), '.credential-issuer-key.json')
  const keyStore = new JsonFileStore<{ privateKey: string, publicKey: string }>(keyFile)

  return async () => {
    if (issuerInstance != null) return issuerInstance
    if (issuerInitPromise != null) return await issuerInitPromise

    issuerInitPromise = (async () => {
      const { CredentialIssuer } = await import('../modules/credentials')
      const { generatePrivateKey } = await import('../server')

      const savedData = keyStore.load()
      const privateKey = process.env[envVar] ?? savedData?.privateKey ?? generatePrivateKey()

      // Prepare revocation config
      let revocationConfig: any = { enabled: false }
      if (config.serverWalletManager != null) {
        try {
          const swm = config.serverWalletManager as ServerWalletManager
          const wallet = await swm.getWallet()
          const { FileRevocationStore } = await import('../modules/file-revocation-store')
          revocationConfig = {
            enabled: true,
            wallet: wallet.getClient(),
            store: new FileRevocationStore(
              config.revocationStorePath ?? join(process.cwd(), '.revocation-secrets.json')
            )
          }
        } catch {
          // Revocation not available — continue without it
        }
      }

      issuerInstance = await CredentialIssuer.create({
        privateKey,
        schemas: config.schemas,
        revocation: revocationConfig
      })

      if (process.env[envVar] == null) {
        keyStore.save({ privateKey, publicKey: issuerInstance.getInfo().publicKey })
      }

      return issuerInstance
    })()

    return await issuerInitPromise
  }
}

// ============================================================================
// Helper: detect legacy path-based requests
// ============================================================================

function getLegacySubPath (url: string): string | null {
  try {
    const pathname = new URL(url).pathname
    // Match patterns like /api/credential-issuer/api/info or /api/credential-issuer/api/certify
    const match = pathname.match(/\/api\/([a-z]+)$/)
    if (match != null) {
      const segment = match[1]
      if (segment === 'info' || segment === 'certify') return segment
    }
  } catch {
    // Not a full URL — skip legacy detection
  }
  return null
}

// ============================================================================
// Next.js handler factory
// ============================================================================

export function createCredentialIssuerHandler (config: CredentialIssuerHandlerConfig): ReturnType<typeof toNextHandlers> {
  const getIssuer = createIssuerFactory(config)

  const coreHandlers = {
    async GET (req: HandlerRequest): Promise<HandlerResponse> {
      try {
        const legacyPath = getLegacySubPath(req.url)
        const params = getSearchParams(req.url)

        // Legacy path: GET .../api/info — used by acquireCredential() in older versions
        if (legacyPath === 'info') {
          const issuer = await getIssuer()
          const info = issuer.getInfo()
          const firstSchema = config.schemas[0]
          const certificateType = Buffer.from(firstSchema.id, 'utf-8').toString('base64')
          return jsonResponse({ certifierPublicKey: info.publicKey, certificateType })
        }

        const action = params.get('action') ?? 'info'

        if (action === 'info') {
          const issuer = await getIssuer()
          const info = issuer.getInfo()
          // Also serves as the new query-param endpoint for acquireCredential()
          // When called as ?action=info, include both formats
          const schemas = info.schemas.map((s: any) => ({
            ...s,
            certificateTypeBase64: Buffer.from(s.id, 'utf-8').toString('base64')
          }))
          const firstSchema = config.schemas[0]
          const certificateType = Buffer.from(firstSchema.id, 'utf-8').toString('base64')
          return jsonResponse({
            success: true,
            certifierPublicKey: info.publicKey,
            certificateType,
            ...info,
            schemas
          })
        }

        if (action === 'schema') {
          const issuer = await getIssuer()
          const id = params.get('id') ?? config.schemas[0]?.id
          const info = issuer.getInfo()
          const schema = info.schemas?.find((s: any) => s.id === id)
          if (schema == null) return jsonResponse({ success: false, error: `Schema "${String(id)}" not found` }, 404)
          return jsonResponse({ success: true, schema })
        }

        if (action === 'status') {
          const issuer = await getIssuer()
          const sn = params.get('serialNumber')
          if (sn == null || sn === '') return jsonResponse({ success: false, error: 'Missing serialNumber' }, 400)
          const revoked = await issuer.isRevoked(sn)
          return jsonResponse({ success: true, serialNumber: sn, revoked })
        }

        // ?action=certify via GET (used by new acquireCredential URL pattern with query params)
        if (action === 'certify') {
          // Certify only works via POST — return info about expected format
          return jsonResponse({ success: false, error: 'Use POST for certify action' }, 405)
        }

        return jsonResponse({ success: false, error: `Unknown action: ${action}` }, 400)
      } catch (error) {
        return jsonResponse({ success: false, error: `Failed: ${(error as Error).message}` }, 500)
      }
    },

    async POST (req: HandlerRequest): Promise<HandlerResponse> {
      try {
        const body = await req.json()
        const legacyPath = getLegacySubPath(req.url)
        const params = getSearchParams(req.url)

        // Legacy path: POST .../api/certify
        if (legacyPath === 'certify') {
          const { identityKey, schemaId, fields } = body
          if ((identityKey == null) || (fields == null)) {
            return jsonResponse({ error: 'Missing identityKey or fields' }, 400)
          }
          const issuer = await getIssuer()
          const vc = await issuer.issue(identityKey, schemaId ?? config.schemas[0]?.id, fields)
          return jsonResponse(vc._bsv.certificate)
        }

        const action = params.get('action')

        // New query-param based certify — also used by acquireCredential()
        if (action === 'certify') {
          const { identityKey, schemaId, fields } = body
          if ((identityKey == null) || (fields == null)) {
            return jsonResponse({ error: 'Missing identityKey or fields' }, 400)
          }
          const issuer = await getIssuer()
          const vc = await issuer.issue(identityKey, schemaId ?? config.schemas[0]?.id, fields)
          return jsonResponse(vc._bsv.certificate)
        }

        if (action === 'issue') {
          const { subjectKey, schemaId, fields } = body
          if ((subjectKey == null) || (fields == null)) {
            return jsonResponse({ success: false, error: 'Missing subjectKey or fields' }, 400)
          }
          const issuer = await getIssuer()
          const vc = await issuer.issue(subjectKey, schemaId ?? config.schemas[0]?.id, fields)
          return jsonResponse({ success: true, credential: vc })
        }

        if (action === 'verify') {
          const { credential } = body
          if (credential == null) return jsonResponse({ success: false, error: 'Missing credential' }, 400)
          const issuer = await getIssuer()
          const result = await issuer.verify(credential)
          return jsonResponse({ success: true, verification: result })
        }

        if (action === 'revoke') {
          const { serialNumber } = body
          if (serialNumber == null || serialNumber === '') return jsonResponse({ success: false, error: 'Missing serialNumber' }, 400)
          const issuer = await getIssuer()
          const result = await issuer.revoke(serialNumber)
          return jsonResponse({ success: true, ...result })
        }

        return jsonResponse({ success: false, error: `Unknown action: ${String(action)}` }, 400)
      } catch (error) {
        return jsonResponse({ success: false, error: `Failed: ${(error as Error).message}` }, 500)
      }
    }
  }

  return toNextHandlers(coreHandlers)
}
