import { Request, Response, NextFunction } from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { getWallet } from './walletSingleton'
import { Utils } from '@bsv/sdk'
import { log } from '../logger'
import { CDN_ROOT } from './cdnObjectPath'
import { profileValue, readResourceLimit, readResourceProfile } from '../security/edgePolicy'

/**
 * Cache to store MIME types for object identifiers to avoid repeated database lookups
 */
const mimeTypeCache = new Map<string, string>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes in milliseconds
const cacheTimestamps = new Map<string, number>()
const MAX_MIME_CACHE_ENTRIES = readResourceLimit(
  'UHRP',
  'MIME_CACHE_MAX_ENTRIES',
  profileValue(readResourceProfile('UHRP'), {
    small: 2_500,
    standard: 10_000,
    highThroughput: 50_000
  })
)
const FILE_SIGNATURES = [
  { bytes: [0xff, 0xd8, 0xff], mimeType: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mimeType: 'image/png' },
  { bytes: [0x47, 0x49, 0x46], mimeType: 'image/gif' },
  { bytes: [0x25, 0x50, 0x44, 0x46], mimeType: 'application/pdf' },
  { bytes: [0x50, 0x4b], mimeType: 'application/zip' }
] as const

/**
 * Get MIME type from UHRP advertisement tags
 */
async function getMimeTypeFromAdvertisement(objectIdentifier: string): Promise<string | null> {
  // Check cache first
  const cacheKey = objectIdentifier
  const cachedMimeType = mimeTypeCache.get(cacheKey)
  const cacheTime = cacheTimestamps.get(cacheKey)

  if (cachedMimeType && cacheTime && Date.now() - cacheTime < CACHE_TTL) {
    // Refresh insertion order so the maps act as a bounded LRU cache.
    mimeTypeCache.delete(cacheKey)
    cacheTimestamps.delete(cacheKey)
    mimeTypeCache.set(cacheKey, cachedMimeType)
    cacheTimestamps.set(cacheKey, cacheTime)
    return cachedMimeType
  }
  if (cacheTime != null) {
    mimeTypeCache.delete(cacheKey)
    cacheTimestamps.delete(cacheKey)
  }

  try {
    const wallet = await getWallet()
    const { outputs } = await wallet.listOutputs({
      basket: 'uhrp advertisements',
      tags: [`object_identifier_${Utils.toHex(Utils.toArray(objectIdentifier, 'utf8'))}`],
      tagQueryMode: 'all',
      includeTags: true,
      limit: 50
    })

    let mimeType: string | null = null
    let maxExpiry = 0

    // Find the advertisement with the latest expiry time (most recent)
    for (const output of outputs) {
      if (!output.tags) continue

      const contentTypeTag = output.tags.find(t => t.startsWith('content_type_'))
      const expiryTag = output.tags.find(t => t.startsWith('expiry_time_'))

      if (contentTypeTag && expiryTag) {
        const expiryTime = Number.parseInt(expiryTag.substring('expiry_time_'.length), 10) || 0

        // Only consider non-expired advertisements
        if (expiryTime > Date.now() / 1000 && expiryTime > maxExpiry) {
          maxExpiry = expiryTime
          mimeType = contentTypeTag.substring('content_type_'.length)
        }
      }
    }

    // Cache the result (even if null)
    if (mimeType) {
      if (MAX_MIME_CACHE_ENTRIES !== -1) {
        while (mimeTypeCache.size >= MAX_MIME_CACHE_ENTRIES) {
          const oldest = mimeTypeCache.keys().next().value
          if (oldest == null) break
          mimeTypeCache.delete(oldest)
          cacheTimestamps.delete(oldest)
        }
      }
      mimeTypeCache.set(cacheKey, mimeType)
      cacheTimestamps.set(cacheKey, Date.now())
    }

    return mimeType
  } catch (error) {
    log.error(
      { operation: 'mime.detect', outcome: 'error', source: 'advertisement', err: error },
      'Error fetching MIME type from advertisement'
    )
    return null
  }
}

/**
 * Detect MIME type from file content using magic bytes (simple detection)
 */
function detectBinaryMimeType(buffer: Buffer): string | undefined {
  return FILE_SIGNATURES.find(signature =>
    signature.bytes.every((byte, index) => buffer[index] === byte)
  )?.mimeType
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function detectMimeTypeFromContent(filePath: string): string {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(512)
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
    const sample = buffer.subarray(0, bytesRead)
    const binaryMimeType = detectBinaryMimeType(sample)
    if (binaryMimeType != null) return binaryMimeType

    const textSample = sample.toString('utf8')
    if (!/^[\x21-\x7E\s]*$/.test(textSample)) return 'application/octet-stream'

    const trimmedSample = textSample.trim()
    if (trimmedSample.startsWith('<!DOCTYPE html') || trimmedSample.startsWith('<html')) {
      return 'text/html'
    }
    if ((trimmedSample.startsWith('{') || trimmedSample.startsWith('[')) && isJson(trimmedSample))
      return 'application/json'

    return 'text/plain'
  } catch {
    return 'application/octet-stream'
  } finally {
    if (descriptor != null) fs.closeSync(descriptor)
  }
}

function resolveCdnFilePath(objectIdentifier: string): string | null {
  try {
    const decodedIdentifier = decodeURIComponent(objectIdentifier)
    if (!decodedIdentifier || decodedIdentifier.includes('\0')) {
      return null
    }

    const filePath = path.resolve(CDN_ROOT, decodedIdentifier)
    const relativePath = path.relative(CDN_ROOT, filePath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null
    }

    return filePath
  } catch {
    return null
  }
}

/**
 * Middleware to set correct MIME type for CDN files
 */
export const cdnMimeTypeMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  // Only handle requests to /cdn/ path
  if (!req.path.startsWith('/cdn/')) {
    return next()
  }

  const objectIdentifier = req.path.substring('/cdn/'.length)

  // Skip if no object identifier
  if (!objectIdentifier) {
    return next()
  }

  const filePath = resolveCdnFilePath(objectIdentifier)
  if (filePath == null) {
    return next()
  }

  try {
    // Try to get MIME type from UHRP advertisement
    let mimeType = await getMimeTypeFromAdvertisement(objectIdentifier)

    // If not found in advertisement, try to detect from content
    if (!mimeType || mimeType === 'application/octet-stream') {
      mimeType = detectMimeTypeFromContent(filePath)
    }

    // Set the content type header
    res.setHeader('Content-Type', mimeType || 'application/octet-stream')

    res.sendFile(filePath, error => {
      if (error != null) {
        next()
      }
    })
  } catch (error) {
    log.error(
      { operation: 'mime.middleware', outcome: 'error', err: error },
      'Error in CDN MIME type middleware'
    )
    next()
  }
}

export default cdnMimeTypeMiddleware
