/**
 * Credential Issuer Handler — issue, verify, revoke W3C Verifiable Credentials.
 *
 * Handles both:
 *   - Query-param based endpoints (?action=info|schema|certify|issue|verify|revoke|status)
 *   - Legacy path-based endpoints (/api/info, /api/certify) for backward compatibility
 *
 * createCredentialIssuerHandler() returns Next.js App Router compatible { GET, POST }.
 */

import { compareCodeUnits } from '../core/code-unit-order'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import {
  canonicalIdentityKey,
  snapshotPlainDataRecord,
  validateCredentialFields,
  validateSchemaId
} from '../core/certificate-validation'
import { CredentialIssuerHandlerConfig } from '../core/types'
import { CredentialSchema } from '../modules/credentials'
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

function validatedIssuerPrivateKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Credential issuer key is invalid')
  }
  try {
    const privateKey = PrivateKey.fromHex(value)
    if (privateKey.isZero() || privateKey.toHex() !== value) {
      throw new Error('Credential issuer key is invalid')
    }
  } catch {
    throw new Error('Credential issuer key is invalid')
  }
  return value
}

function validateStoredIssuerKey(value: unknown): { privateKey: string; publicKey: string } {
  const record = snapshotPlainDataRecord(value)
  if (record == null) throw new Error('Stored credential issuer key is invalid')
  const keys = Object.keys(record).sort(compareCodeUnits)
  if (keys.length !== 2 || keys[0] !== 'privateKey' || keys[1] !== 'publicKey') {
    throw new Error('Stored credential issuer key is invalid')
  }
  if (typeof record.privateKey !== 'string' || typeof record.publicKey !== 'string') {
    throw new Error('Stored credential issuer key is invalid')
  }
  try {
    const privateKey = PrivateKey.fromHex(validatedIssuerPrivateKey(record.privateKey))
    if (privateKey.toPublicKey().toString() !== record.publicKey) {
      throw new Error('Stored credential issuer key is invalid')
    }
  } catch {
    throw new Error('Stored credential issuer key is invalid')
  }
  return { privateKey: record.privateKey, publicKey: record.publicKey }
}

function createIssuerFactory(config: CredentialIssuerHandlerConfig): () => Promise<any> {
  let issuerInstance: any = null
  let issuerInitPromise: Promise<any> | null = null

  const envVar = config.envVar ?? 'CREDENTIAL_ISSUER_KEY'
  const keyFile = config.keyFile ?? join(process.cwd(), '.credential-issuer-key.json')
  const keyStore = new JsonFileStore<{ privateKey: string; publicKey: string }>(keyFile)

  return async () => {
    if (issuerInstance != null) return issuerInstance
    if (issuerInitPromise != null) return await issuerInitPromise

    issuerInitPromise = (async () => {
      const { CredentialIssuer } = await import('../modules/credentials')
      const { generatePrivateKey } = await import('./generate-private-key')

      const environmentValue = process.env[envVar]
      const environmentKey =
        environmentValue == null ? undefined : validatedIssuerPrivateKey(environmentValue)
      const savedValue = environmentKey == null ? keyStore.load() : null
      const savedData = savedValue == null ? null : validateStoredIssuerKey(savedValue)
      const privateKey = environmentKey ?? savedData?.privateKey ?? generatePrivateKey()

      // Prepare revocation config
      let revocationConfig: any = { enabled: false }
      if (config.serverWalletManager != null) {
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

function getLegacySubPath(url: string): string | null {
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

type IssuerFactory = () => Promise<any>

type IssuerAuthorization = Parameters<NonNullable<CredentialIssuerHandlerConfig['authorize']>>[0]

async function isAuthorized(
  config: CredentialIssuerHandlerConfig,
  req: HandlerRequest,
  request: Omit<IssuerAuthorization, 'url' | 'headers'>
): Promise<boolean> {
  if (config.authorize == null) return false
  try {
    const requestRecord = snapshotPlainDataRecord(request)
    if (requestRecord == null) return false
    const ownedRequest = Object.assign(Object.create(null) as IssuerAuthorization, {
      ...requestRecord,
      ...(requestRecord.fields !== undefined
        ? {
            fields: Object.assign(
              Object.create(null) as Record<string, string>,
              requestRecord.fields as Record<string, string>
            )
          }
        : {}),
      url: req.url,
      ...(req.headers == null ? {} : { headers: req.headers })
    })
    return (await config.authorize(ownedRequest)) === true
  } catch {
    return false
  }
}

function canonicalSerialNumber(value: unknown): string {
  if (typeof value !== 'string' || value.length > 44) throw new TypeError('Invalid serial number')
  try {
    const bytes = toArray(value, 'base64')
    if (bytes.length !== 32 || toBase64(bytes) !== value)
      throw new TypeError('Invalid serial number')
  } catch {
    throw new TypeError('Invalid serial number')
  }
  return value
}

async function certifyIdentity(
  body: unknown,
  req: HandlerRequest,
  config: CredentialIssuerHandlerConfig,
  getIssuer: IssuerFactory,
  defaultSchemaId: string | undefined
): Promise<HandlerResponse> {
  const record = snapshotPlainDataRecord(body)
  if (record == null || record.identityKey == null || record.fields == null) {
    return jsonResponse({ error: 'Missing identityKey or fields' }, 400)
  }
  const identityKey = canonicalIdentityKey(record.identityKey, 'credential subject')
  const schemaId = validateSchemaId(record.schemaId ?? defaultSchemaId)
  const fields = validateCredentialFields(record.fields)
  if (
    !(await isAuthorized(config, req, {
      action: 'certify',
      subjectIdentityKey: identityKey,
      schemaId,
      fields
    }))
  ) {
    return jsonResponse({ error: 'Certificate issuance is not authorized' }, 403)
  }
  const issuer = await getIssuer()
  const vc = await issuer.issue(identityKey, schemaId, fields)
  return jsonResponse(vc._bsv.certificate)
}

async function issueCredential(
  body: unknown,
  req: HandlerRequest,
  config: CredentialIssuerHandlerConfig,
  getIssuer: IssuerFactory,
  defaultSchemaId: string | undefined
): Promise<HandlerResponse> {
  const record = snapshotPlainDataRecord(body)
  if (record == null || record.subjectKey == null || record.fields == null) {
    return jsonResponse({ success: false, error: 'Missing subjectKey or fields' }, 400)
  }
  const subjectKey = canonicalIdentityKey(record.subjectKey, 'credential subject')
  const schemaId = validateSchemaId(record.schemaId ?? defaultSchemaId)
  const fields = validateCredentialFields(record.fields)
  if (
    !(await isAuthorized(config, req, {
      action: 'issue',
      subjectIdentityKey: subjectKey,
      schemaId,
      fields
    }))
  ) {
    return jsonResponse({ success: false, error: 'Credential issuance is not authorized' }, 403)
  }
  const issuer = await getIssuer()
  const vc = await issuer.issue(subjectKey, schemaId, fields)
  return jsonResponse({ success: true, credential: vc })
}

async function verifyCredential(body: unknown, getIssuer: IssuerFactory): Promise<HandlerResponse> {
  const record = snapshotPlainDataRecord(body)
  if (record == null || record.credential == null) {
    return jsonResponse({ success: false, error: 'Missing credential' }, 400)
  }
  const issuer = await getIssuer()
  const result = await issuer.verify(record.credential)
  return jsonResponse({ success: true, verification: result })
}

async function revokeCredential(
  body: unknown,
  req: HandlerRequest,
  config: CredentialIssuerHandlerConfig,
  getIssuer: IssuerFactory
): Promise<HandlerResponse> {
  const record = snapshotPlainDataRecord(body)
  if (record == null || record.serialNumber == null || record.serialNumber === '') {
    return jsonResponse({ success: false, error: 'Missing serialNumber' }, 400)
  }
  const serialNumber = canonicalSerialNumber(record.serialNumber)
  if (!(await isAuthorized(config, req, { action: 'revoke', serialNumber }))) {
    return jsonResponse({ success: false, error: 'Credential revocation is not authorized' }, 403)
  }
  const issuer = await getIssuer()
  const result = await issuer.revoke(serialNumber)
  return jsonResponse({ success: true, ...result })
}

async function handleCredentialPost(
  req: HandlerRequest,
  config: CredentialIssuerHandlerConfig,
  getIssuer: IssuerFactory,
  defaultSchemaId: string | undefined
): Promise<HandlerResponse> {
  const body = await req.json()
  const legacyPath = getLegacySubPath(req.url)
  const action = getSearchParams(req.url).get('action')

  if (legacyPath === 'certify' || action === 'certify') {
    return await certifyIdentity(body, req, config, getIssuer, defaultSchemaId)
  }
  if (action === 'issue')
    return await issueCredential(body, req, config, getIssuer, defaultSchemaId)
  if (action === 'verify') return await verifyCredential(body, getIssuer)
  if (action === 'revoke') return await revokeCredential(body, req, config, getIssuer)

  return jsonResponse({ success: false, error: 'Unknown credential issuer action' }, 400)
}

function snapshotCredentialIssuerConfig(
  config: CredentialIssuerHandlerConfig
): CredentialIssuerHandlerConfig {
  const record = snapshotPlainDataRecord(config)
  if (record == null || !Array.isArray(record.schemas)) {
    throw new TypeError('Credential issuer requires between 1 and 100 schemas')
  }
  if (record.schemas.length < 1 || record.schemas.length > 100) {
    throw new TypeError('Credential issuer requires between 1 and 100 schemas')
  }
  const schemas = [] as CredentialIssuerHandlerConfig['schemas']
  for (let index = 0; index < record.schemas.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(record.schemas, String(index))
    if (descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null) {
      throw new TypeError('Credential issuer schemas must be a dense own-data array')
    }
    schemas.push(new CredentialSchema(descriptor.value as never).getConfig())
  }
  return Object.assign(Object.create(null) as CredentialIssuerHandlerConfig, {
    schemas,
    ...(record.envVar === undefined ? {} : { envVar: record.envVar as string }),
    ...(record.keyFile === undefined ? {} : { keyFile: record.keyFile as string }),
    ...(record.serverWalletManager === undefined
      ? {}
      : { serverWalletManager: record.serverWalletManager }),
    ...(record.revocationStorePath === undefined
      ? {}
      : { revocationStorePath: record.revocationStorePath as string }),
    ...(record.maxRequestBytes === undefined
      ? {}
      : { maxRequestBytes: record.maxRequestBytes as number }),
    ...(record.authorize === undefined
      ? {}
      : { authorize: record.authorize as CredentialIssuerHandlerConfig['authorize'] })
  })
}

// ============================================================================
// Next.js handler factory
// ============================================================================

export function createCredentialIssuerHandler(
  config: CredentialIssuerHandlerConfig
): ReturnType<typeof toNextHandlers> {
  const ownedConfig = snapshotCredentialIssuerConfig(config)
  const getIssuer = createIssuerFactory(ownedConfig)

  const coreHandlers = {
    async GET(req: HandlerRequest): Promise<HandlerResponse> {
      try {
        const legacyPath = getLegacySubPath(req.url)
        const params = getSearchParams(req.url)

        // Legacy path: GET .../api/info — used by acquireCredential() in older versions
        if (legacyPath === 'info') {
          const issuer = await getIssuer()
          const info = issuer.getInfo()
          const certificateType = info.schemas[0].certificateTypeBase64
          return jsonResponse({ certifierPublicKey: info.publicKey, certificateType })
        }

        const action = params.get('action') ?? 'info'

        if (action === 'info') {
          const issuer = await getIssuer()
          const info = issuer.getInfo()
          // Also serves as the new query-param endpoint for acquireCredential()
          // When called as ?action=info, include both formats
          const schemas = info.schemas
          const certificateType = schemas[0].certificateTypeBase64
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
          const id = params.get('id') ?? ownedConfig.schemas[0]?.id
          const info = issuer.getInfo()
          const schema = info.schemas?.find((s: any) => s.id === id)
          if (schema == null)
            return jsonResponse({ success: false, error: `Schema "${String(id)}" not found` }, 404)
          return jsonResponse({ success: true, schema })
        }

        if (action === 'status') {
          const issuer = await getIssuer()
          const sn = params.get('serialNumber')
          if (sn == null || sn === '')
            return jsonResponse({ success: false, error: 'Missing serialNumber' }, 400)
          const serialNumber = canonicalSerialNumber(sn)
          const revoked = await issuer.isRevoked(serialNumber)
          return jsonResponse({ success: true, serialNumber, revoked })
        }

        // ?action=certify via GET (used by new acquireCredential URL pattern with query params)
        if (action === 'certify') {
          // Certify only works via POST — return info about expected format
          return jsonResponse({ success: false, error: 'Use POST for certify action' }, 405)
        }

        return jsonResponse({ success: false, error: 'Unknown credential issuer action' }, 400)
      } catch {
        return jsonResponse({ success: false, error: 'Credential issuer operation failed' }, 500)
      }
    },

    async POST(req: HandlerRequest): Promise<HandlerResponse> {
      try {
        return await handleCredentialPost(req, ownedConfig, getIssuer, ownedConfig.schemas[0]?.id)
      } catch {
        return jsonResponse({ success: false, error: 'Credential issuer operation failed' }, 500)
      }
    }
  }

  return toNextHandlers(coreHandlers, { maxRequestBytes: ownedConfig.maxRequestBytes })
}
