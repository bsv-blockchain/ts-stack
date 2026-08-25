import type { Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import createUHRPAdvertisement from '../utils/createUHRPAdvertisement'
import getPriceForFile from '../utils/getPriceForFile'
import { log } from '../logger'
import { readBodyLimitBytes, readResourceLimit } from '../security/edgePolicy'
import { CHIRP_OPENAPI_DOCUMENT } from './openapi'
import { getChirpStore } from './store'
import { decodeCHIRPNode } from './core/codec'
import { CHIRPError } from './core/errors'
import { hashForObjectIdentifier, verifyObjectBytes } from './core/hash'
import { parseCHIRPURL } from './core/uri'
import { validateCHIRPClosure } from './core/validation'
import type { ChirpCommitRecord } from './contracts'

const MAX_OBJECT_BYTES = readBodyLimitBytes('CHIRP_OBJECT', 4_194_304)
const MAX_LOGICAL_BYTES = BigInt(unboundedResourceLimit('MAX_LOGICAL_BYTES', 11_000_000_000))
const MAX_OBJECTS = unboundedResourceLimit('MAX_OBJECTS', 100_000)
const MAX_RETENTION_SECONDS = unboundedResourceLimit('MAX_RETENTION_SECONDS', 31_536_000)

interface AuthenticatedRequest extends Request {
  auth: { identityKey?: string }
}

export const chirpPreAuthRoutes = [
  { type: 'get', path: '/chirp/v1/openapi.json', unsecured: true, func: openapiHandler },
  {
    type: 'get',
    path: '/chirp/v1/:rootIdentifier/objects/:objectIdentifier',
    unsecured: true,
    func: getObjectHandler
  },
  {
    type: 'head',
    path: '/chirp/v1/:rootIdentifier/objects/:objectIdentifier',
    unsecured: true,
    func: headObjectHandler
  }
]

export const chirpPostAuthRoutes = [
  { type: 'post', path: '/chirp/v1/uploads', func: createSessionHandler },
  {
    type: 'head',
    path: '/chirp/v1/uploads/:uploadId/objects/:objectIdentifier',
    func: headStagedObjectHandler
  },
  {
    type: 'put',
    path: '/chirp/v1/uploads/:uploadId/objects/:objectIdentifier',
    func: putStagedObjectHandler
  },
  { type: 'post', path: '/chirp/v1/uploads/:uploadId/commit', func: commitHandler }
]

export async function getChirpCommitPrice(req: AuthenticatedRequest): Promise<number> {
  const match = /^\/chirp\/v1\/uploads\/([^/]+)\/commit$/.exec(req.path)
  const identityKey = authenticatedIdentity(req)
  const rootIdentifier = objectIdentifier(req.body?.rootIdentifier)
  if (match == null || identityKey == null || rootIdentifier == null) return 0
  const uploadId = decodeURIComponent(match[1])
  const store = getChirpStore()
  const session = await store.getSession(uploadId, identityKey)
  if (session == null) return 0
  const rootBytes = await store.readStagedObject(uploadId, identityKey, rootIdentifier)
  verifyObjectBytes(rootIdentifier, rootBytes)
  const root = decodeCHIRPNode(rootBytes)
  if (root.nodeKind !== 0 || root.logicalLength > BigInt(Number.MAX_SAFE_INTEGER)) return 0
  return await getPriceForFile({
    fileSize: Number(root.logicalLength),
    retentionPeriod: Math.ceil(Number(BigInt(session.retentionSeconds)) / 60)
  })
}

function openapiHandler(_req: Request, res: Response): Response {
  return res.status(200).json(CHIRP_OPENAPI_DOCUMENT)
}

async function createSessionHandler(req: AuthenticatedRequest, res: Response): Promise<Response> {
  const identityKey = authenticatedIdentity(req)
  if (identityKey == null) return authError(res)
  const retentionSeconds = canonicalDecimal(req.body?.retentionSeconds, false)
  const logicalLength =
    req.body?.logicalLength === null ? null : canonicalDecimal(req.body?.logicalLength, true)
  const minimum = Math.max(1, (Number(process.env.MIN_HOSTING_MINUTES) || 0) * 60)
  if (
    retentionSeconds == null ||
    logicalLength === undefined ||
    BigInt(retentionSeconds) < BigInt(minimum) ||
    BigInt(retentionSeconds) > BigInt(MAX_RETENTION_SECONDS) ||
    (logicalLength != null && BigInt(logicalLength) > MAX_LOGICAL_BYTES)
  ) {
    return error(res, 400, 'ERR_CHIRP_SESSION', 'Invalid CHIRP retentionSeconds or logicalLength.')
  }
  const session = await getChirpStore().createSession(identityKey, retentionSeconds, logicalLength)
  return res.status(201).json({
    uploadId: session.uploadId,
    stagingExpiresAt: String(session.stagingExpiresAt)
  })
}

async function headStagedObjectHandler(
  req: AuthenticatedRequest,
  res: Response
): Promise<Response> {
  const identityKey = authenticatedIdentity(req)
  if (identityKey == null) return authError(res)
  const uploadId = routeParameter(req.params.uploadId)
  const identifier = objectIdentifier(req.params.objectIdentifier)
  if (uploadId == null || identifier == null)
    return error(res, 400, 'ERR_CHIRP_IDENTIFIER', 'Invalid upload or object identifier.')
  const exists = await getChirpStore().hasStagedObject(uploadId, identityKey, identifier)
  return exists ? res.sendStatus(200) : res.sendStatus(404)
}

async function putStagedObjectHandler(req: AuthenticatedRequest, res: Response): Promise<Response> {
  const identityKey = authenticatedIdentity(req)
  if (identityKey == null) return authError(res)
  const uploadId = routeParameter(req.params.uploadId)
  const identifier = objectIdentifier(req.params.objectIdentifier)
  if (uploadId == null || identifier == null) {
    drain(req)
    return error(res, 400, 'ERR_CHIRP_IDENTIFIER', 'Invalid object identifier.')
  }
  const encoding = req.get('content-encoding')
  if (encoding != null && encoding.toLowerCase() !== 'identity') {
    drain(req)
    return error(res, 415, 'ERR_CHIRP_ENCODING', 'CHIRP objects require identity content encoding.')
  }
  const declaredLength = parseContentLength(req.get('content-length'))
  if (declaredLength === 'invalid') {
    drain(req)
    return error(res, 400, 'ERR_CHIRP_LENGTH', 'Invalid Content-Length.')
  }
  if (declaredLength != null && declaredLength > MAX_OBJECT_BYTES) {
    drain(req)
    return error(res, 413, 'ERR_CHIRP_OBJECT_SIZE', 'CHIRP object exceeds the upload limit.')
  }
  const outcome = await getChirpStore().stageObject(
    uploadId,
    identityKey,
    identifier,
    req,
    declaredLength,
    MAX_OBJECT_BYTES
  )
  if (outcome === 'created') return res.sendStatus(201)
  if (outcome === 'exists') return res.sendStatus(204)
  if (outcome === 'session_missing')
    return error(res, 404, 'ERR_CHIRP_SESSION', 'Unknown or expired CHIRP upload session.')
  if (outcome === 'too_large')
    return error(res, 413, 'ERR_CHIRP_OBJECT_SIZE', 'CHIRP object exceeds the upload limit.')
  if (outcome === 'size_mismatch')
    return error(res, 400, 'ERR_CHIRP_LENGTH', 'Object length differs from Content-Length.')
  return error(res, 400, 'ERR_CHIRP_OBJECT_HASH', 'Object bytes do not match objectIdentifier.')
}

async function commitHandler(req: AuthenticatedRequest, res: Response): Promise<Response> {
  const identityKey = authenticatedIdentity(req)
  if (identityKey == null) return authError(res)
  const rootIdentifier = objectIdentifier(req.body?.rootIdentifier)
  if (rootIdentifier == null)
    return error(res, 400, 'ERR_CHIRP_IDENTIFIER', 'Invalid rootIdentifier.')
  const uploadId = routeParameter(req.params.uploadId)
  if (uploadId == null) return error(res, 400, 'ERR_CHIRP_SESSION', 'Invalid upload session.')
  const store = getChirpStore()
  try {
    return await store.withCommitLock(uploadId, async () => {
      const session = await store.getSession(uploadId, identityKey)
      if (session == null)
        return error(res, 404, 'ERR_CHIRP_SESSION', 'Unknown or expired CHIRP upload session.')
      const existing = await store.getCommit(rootIdentifier)
      if (
        existing?.state === 'active' &&
        existing.identityFingerprint === identityFingerprint(identityKey)
      ) {
        return commitResponse(res, existing)
      }
      const validated = await validateCHIRPClosure(
        rootIdentifier,
        async identifier => await store.readStagedObject(uploadId, identityKey, identifier),
        {
          maxLogicalLength: MAX_LOGICAL_BYTES,
          maxObjects: MAX_OBJECTS,
          maxObjectBytes: MAX_OBJECT_BYTES
        }
      )
      if (
        session.logicalLength != null &&
        BigInt(session.logicalLength) !== validated.logicalLength
      ) {
        return error(
          res,
          400,
          'ERR_CHIRP_LENGTH',
          'Committed root differs from declared logicalLength.'
        )
      }
      const expiryTime = Math.floor(Date.now() / 1000) + Number(BigInt(session.retentionSeconds))
      const record: ChirpCommitRecord = {
        rootIdentifier,
        identityFingerprint: identityFingerprint(identityKey),
        expiryTime,
        rootLength: validated.rootBytes.byteLength,
        logicalLength: validated.logicalLength.toString(),
        closure: validated.closure,
        nodeIdentifiers: validated.nodeIdentifiers,
        state: 'pending',
        preparedAt: Math.floor(Date.now() / 1000)
      }
      await store.prepareCommit(record)
      const hostedFileLocation = committedObjectURL(rootIdentifier)
      try {
        await createUHRPAdvertisement({
          hash: Array.from(hashForObjectIdentifier(rootIdentifier)),
          objectIdentifier: rootIdentifier,
          url: hostedFileLocation,
          uploaderIdentityKey: identityKey,
          expiryTime,
          contentLength: validated.rootBytes.byteLength,
          contentType: 'application/vnd.bsv.chirp-node'
        })
        await store.activateCommit(rootIdentifier)
      } catch (cause) {
        await store.abortCommit(rootIdentifier)
        throw cause
      }
      record.state = 'active'
      return commitResponse(res, record)
    })
  } catch (cause) {
    const code = cause instanceof CHIRPError ? cause.code : 'ERR_CHIRP_COMMIT'
    log.error(
      { operation: 'chirp.commit', outcome: 'error', code, err: cause },
      'CHIRP commit failed'
    )
    return error(res, 400, code, 'CHIRP closure validation or advertisement failed.')
  }
}

async function getObjectHandler(req: Request, res: Response): Promise<Response | void> {
  return await serveCommittedObject(req, res, false)
}

async function headObjectHandler(req: Request, res: Response): Promise<Response | void> {
  return await serveCommittedObject(req, res, true)
}

async function serveCommittedObject(
  req: Request,
  res: Response,
  headOnly: boolean
): Promise<Response | void> {
  const rootIdentifier = objectIdentifier(req.params.rootIdentifier)
  const objectId = objectIdentifier(req.params.objectIdentifier)
  if (rootIdentifier == null || objectId == null) return res.sendStatus(404)
  const object = await getChirpStore().getCommittedObject(rootIdentifier, objectId)
  if (object == null) return res.sendStatus(404)
  res.status(200)
  res.setHeader('Content-Type', object.contentType)
  res.setHeader('Content-Encoding', 'identity')
  res.setHeader('Content-Length', String(object.length))
  res.setHeader(
    'Cache-Control',
    `public, immutable, max-age=${Math.max(0, object.expiryTime - Math.floor(Date.now() / 1000))}`
  )
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (headOnly) {
    object.stream.destroy()
    return res.end()
  }
  await new Promise<void>((resolve, reject) => {
    object.stream.once('error', reject)
    res.once('error', reject)
    res.once('close', resolve)
    res.once('finish', resolve)
    object.stream.pipe(res)
  })
}

function committedObjectURL(rootIdentifier: string): string {
  const configured = process.env.HOSTING_DOMAIN
  if (configured == null || configured.trim() === '') {
    throw new CHIRPError('ERR_CHIRP_HOST', 'HOSTING_DOMAIN is required for CHIRP commitments.')
  }
  let origin: string
  if (/^https?:\/\//i.test(configured)) {
    origin = new URL(configured).origin
  } else {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http'
    origin = `${protocol}://${configured}`
  }
  const parsed = new URL(origin)
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new CHIRPError('ERR_CHIRP_HOST', 'Production CHIRP commitments require HTTPS.')
  }
  return `${origin}/chirp/v1/${rootIdentifier}/objects/${rootIdentifier}`
}

function commitResponse(res: Response, record: ChirpCommitRecord): Response {
  return res.status(201).json({
    chirpURL: `chirp://${record.rootIdentifier}`,
    uhrpURL: `uhrp://${record.rootIdentifier}`,
    hostedFileLocation: committedObjectURL(record.rootIdentifier),
    expiryTime: record.expiryTime
  })
}

function authenticatedIdentity(req: AuthenticatedRequest): string | null {
  const identityKey = req.auth?.identityKey
  return identityKey == null || identityKey === '' || identityKey === 'unknown' ? null : identityKey
}

function identityFingerprint(identityKey: string): string {
  return createHash('sha256').update(identityKey, 'utf8').digest('hex')
}

function objectIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    return parseCHIRPURL(`chirp://${value}`).rootIdentifier
  } catch {
    return null
  }
}

function routeParameter(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function canonicalDecimal(value: unknown, allowZero: boolean): string | null | undefined {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return undefined
  const parsed = BigInt(value)
  if (parsed < (allowZero ? 0n : 1n) || parsed > 0xffffffffffffffffn) return undefined
  return parsed.toString()
}

function parseContentLength(value: string | undefined): number | null | 'invalid' {
  if (value == null) return null
  if (!/^\d+$/.test(value)) return 'invalid'
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 'invalid'
}

function authError(res: Response): Response {
  return error(res, 400, 'ERR_MISSING_IDENTITY_KEY', 'Missing AuthFetch identityKey.')
}

function error(res: Response, status: number, code: string, description: string): Response {
  return res.status(status).json({ status: 'error', code, description })
}

function drain(req: Request): void {
  if (Readable.isReadable(req)) req.resume()
}

function unboundedResourceLimit(name: string, fallback: number): number {
  const value = readResourceLimit('CHIRP', name, fallback)
  return value === -1 ? Number.MAX_SAFE_INTEGER : value
}
