import createUHRPAdvertisement from '../utils/createUHRPAdvertisement';
import { Request, Response } from 'express';
import { Utils } from '@bsv/sdk';
import { getWallet } from '../utils/walletSingleton';
import { IncomingHttpHeaders } from 'http';
import { log } from '../logger';
import {
  resolveCdnObjectPath,
  writeCdnObjectStreamExclusive
} from '../utils/cdnObjectPath';
import { readBodyLimitBytes } from '../security/edgePolicy';

const {
  HOSTING_DOMAIN
} = process.env

const MAX_UPLOAD_BYTES = readBodyLimitBytes(
  'UHRP_UPLOAD',
  64 * 1024 * 1024
)

interface AdvertiseRequest extends Request {
  query: {
    uploader: string
    uhrpUrl: string
    objectID: string
    fileSize: string
    expiry: string
    hmac: string
  },
  headers: IncomingHttpHeaders
}

interface AdvertiseResponse {
  status: 'success' | 'error';
  code?: string;
  description?: string;
}

function drainRequest(req: Request): void {
  if (typeof req.resume === 'function') req.resume()
}

const advertiseHandler = async (req: AdvertiseRequest, res: Response<AdvertiseResponse>) => {
  const objectID = req.query.objectID
  if (resolveCdnObjectPath(objectID) === null) {
    drainRequest(req)
    return res.status(400).json({
      status: 'error',
      code: 'ERR_INVALID_OBJECT_ID',
      description: 'Invalid object identifier'
    })
  }

  const fileSize = Number(req.query.fileSize)
  const expiryMilliseconds = Date.parse(req.query.expiry)
  if (
    !/^\d+$/.test(req.query.fileSize) ||
    !Number.isSafeInteger(fileSize) ||
    fileSize < 0 ||
    !Number.isFinite(expiryMilliseconds) ||
    expiryMilliseconds <= Date.now()
  ) {
    drainRequest(req)
    return res.status(400).json({
      status: 'error',
      code: 'ERR_INVALID_UPLOAD_METADATA',
      description: 'Invalid upload metadata'
    })
  }
  if (fileSize > MAX_UPLOAD_BYTES) {
    drainRequest(req)
    return res.status(413).json({
      status: 'error',
      code: 'ERR_BODY_TOO_LARGE',
      description: 'The upload exceeds the endpoint limit.'
    })
  }

  const contentLength = req.headers['content-length']
  if (
    typeof contentLength === 'string' &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) !== fileSize)
  ) {
    drainRequest(req)
    return res.status(400).json({
      status: 'error',
      code: 'ERR_SIZE_MISMATCH',
      description: 'Upload size does not match the authorization.'
    })
  }

  const wallet = await getWallet()

  // Verify authorization before consuming or storing the potentially large body.
  const str = `fileSize=${req.query.fileSize}&objectID=${objectID}&expiry=${req.query.expiry}&uploader=${req.query.uploader}`
  let valid = false
  try {
    const result = await wallet.verifyHmac({
      protocolID: [2, 'storage upload'],
      keyID: '1',
      data: Utils.toArray(str, 'utf8'),
      hmac: Utils.toArray(req.query.hmac, 'hex')
    })
    valid = result.valid
  } catch {
    valid = false
  }
  if (!valid) {
    drainRequest(req)
    return res.status(401).json({
      status: 'error',
      code: 'ERR_INVALID_HMAC',
      description: 'Invalid upload authorization'
    })
  }

  // Stream to a private temporary file, hash incrementally, and atomically
  // create the public object without ever overwriting an existing path.
  const writeResult = await writeCdnObjectStreamExclusive(
    objectID,
    req,
    fileSize,
    MAX_UPLOAD_BYTES
  )
  if (writeResult.status === 'exists') {
    return res.status(400).json({
      status: 'error',
      code: 'ERR_OBJECT_EXISTS',
      description: 'File exists'
    })
  }
  if (writeResult.status === 'invalid') {
    return res.status(400).json({
      status: 'error',
      code: 'ERR_INVALID_OBJECT_ID',
      description: 'Invalid object identifier'
    })
  }
  if (writeResult.status === 'too_large') {
    return res.status(413).json({
      status: 'error',
      code: 'ERR_BODY_TOO_LARGE',
      description: 'The upload exceeds the endpoint limit.'
    })
  }
  if (writeResult.status === 'size_mismatch') {
    return res.status(400).json({
      status: 'error',
      code: 'ERR_SIZE_MISMATCH',
      description: 'Upload size does not match the authorization.'
    })
  }
  if (writeResult.status !== 'stored') {
    throw new Error('Unexpected object stream result')
  }

  // Create UHRP ad under /cdn
  try {
    if (HOSTING_DOMAIN?.startsWith('localhost')) {
      log.warn({ operation: 'advertisement.skip', reason: 'localhost', hosting_domain: HOSTING_DOMAIN }, 'Not advertising on localhost')
      throw new Error('Not advertising in localhost')
    }
    const expiryTime = Math.floor(new Date(req.query.expiry).getTime() / 1000)
    await createUHRPAdvertisement({
      hash: writeResult.hash,
      objectIdentifier: objectID,
      url: `https://${HOSTING_DOMAIN}/cdn/${objectID}`,
      uploaderIdentityKey: req.query.uploader,
      expiryTime,
      contentLength: writeResult.byteLength,
      contentType: req.headers['content-type'] || 'application/octet-stream'
    })
    res.status(200).json({ status: 'success' })
  } catch (error) {
    log.error({ operation: 'advertisement.process', outcome: 'error', err: error }, 'Error processing advertisement')
    res.status(500).json({
      status: 'error',
      code: 'ERR_INTERNAL',
      description: 'An internal error occurred while processing the request.'
    })
  }
}

export default {
  type: 'put',
  path: '/put',
  func: advertiseHandler
}
