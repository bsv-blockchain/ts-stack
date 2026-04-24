import { Request, Response, NextFunction } from 'express'
import path from 'path'
import fs from 'fs'
import { getWallet } from './walletSingleton'
import { Utils } from '@bsv/sdk'

/**
 * Cache to store MIME types for object identifiers to avoid repeated database lookups
 */
const mimeTypeCache = new Map<string, string>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes in milliseconds
const cacheTimestamps = new Map<string, number>()

/**
 * Fallback MIME type mapping based on common file extensions
 * This is used as a last resort if we can't find the MIME type in the UHRP advertisements
 */
const extensionMimeMap: { [key: string]: string } = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

/**
 * Get MIME type from UHRP advertisement tags
 */
async function getMimeTypeFromAdvertisement(objectIdentifier: string): Promise<string | null> {
  // Check cache first
  const cacheKey = objectIdentifier
  const cachedMimeType = mimeTypeCache.get(cacheKey)
  const cacheTime = cacheTimestamps.get(cacheKey)
  
  if (cachedMimeType && cacheTime && (Date.now() - cacheTime) < CACHE_TTL) {
    return cachedMimeType
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
        const expiryTime = parseInt(expiryTag.substring('expiry_time_'.length), 10) || 0
        
        // Only consider non-expired advertisements
        if (expiryTime > Date.now() / 1000 && expiryTime > maxExpiry) {
          maxExpiry = expiryTime
          mimeType = contentTypeTag.substring('content_type_'.length)
        }
      }
    }

    // Cache the result (even if null)
    if (mimeType) {
      mimeTypeCache.set(cacheKey, mimeType)
      cacheTimestamps.set(cacheKey, Date.now())
    }

    return mimeType
  } catch (error) {
    console.error('Error fetching MIME type from advertisement:', error)
    return null
  }
}

/**
 * Detect MIME type from file content using magic bytes (simple detection)
 */
function detectMimeTypeFromContent(filePath: string): string {
  try {
    const buffer = fs.readFileSync(filePath, { encoding: null })
    const firstBytes = buffer.slice(0, 16)

    // Check for common file signatures (magic bytes)
    if (firstBytes[0] === 0xFF && firstBytes[1] === 0xD8 && firstBytes[2] === 0xFF) {
      return 'image/jpeg'
    }
    if (firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4E && firstBytes[3] === 0x47) {
      return 'image/png'
    }
    if (firstBytes[0] === 0x47 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46) {
      return 'image/gif'
    }
    if (firstBytes[0] === 0x25 && firstBytes[1] === 0x50 && firstBytes[2] === 0x44 && firstBytes[3] === 0x46) {
      return 'application/pdf'
    }
    if (firstBytes[0] === 0x50 && firstBytes[1] === 0x4B) {
      return 'application/zip'
    }
    
    // Check if it's text-based content
    const textSample = buffer.slice(0, 512).toString('utf8', 0, Math.min(512, buffer.length))
    if (/^[\x20-\x7E\s]*$/.test(textSample)) {
      if (textSample.trim().startsWith('<!DOCTYPE html') || textSample.trim().startsWith('<html')) {
        return 'text/html'
      }
      if (textSample.trim().startsWith('{') || textSample.trim().startsWith('[')) {
        try {
          JSON.parse(textSample.trim())
          return 'application/json'
        } catch (e) {
          // Not valid JSON
        }
      }
      return 'text/plain'
    }

    return 'application/octet-stream'
  } catch (error) {
    return 'application/octet-stream'
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

  const filePath = path.join(__dirname, '../../public/cdn', objectIdentifier)
  
  // Check if file exists
  if (!fs.existsSync(filePath)) {
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
    
    // Send the file
    res.sendFile(filePath)
  } catch (error) {
    console.error('Error in CDN MIME type middleware:', error)
    next()
  }
}

export default cdnMimeTypeMiddleware
