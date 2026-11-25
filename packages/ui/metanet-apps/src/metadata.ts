import type { PublishedAppMetadata } from './types/index.js'

export type AppMetadataValidationCode =
  | 'ERR_METADATA_INVALID'
  | 'ERR_METADATA_UNSUPPORTED_SCHEMA'

export class AppMetadataValidationError extends Error {
  constructor (readonly code: AppMetadataValidationCode, message: string) {
    super(message)
    this.name = 'AppMetadataValidationError'
  }
}

function requireString (value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new AppMetadataValidationError('ERR_METADATA_INVALID', `${field} must be a string`)
  }
}

function optionalString (value: unknown, field: string): void {
  if (value !== undefined) requireString(value, field)
}

function optionalStringArray (value: unknown, field: string): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new AppMetadataValidationError('ERR_METADATA_INVALID', `${field} must be an array of strings`)
  }
}

/**
 * Validate the canonical Metanet Apps v0.1 metadata shape.
 *
 * This intentionally mirrors the Apps topic manager. It does not rewrite
 * domains, URLs, dates, or assets: metadata admitted by the canonical overlay
 * remains valid and byte-for-byte application data stays under publisher
 * control.
 */
export function normalizeAppMetadata (metadata: PublishedAppMetadata): PublishedAppMetadata {
  if (metadata === null || typeof metadata !== 'object') {
    throw new AppMetadataValidationError('ERR_METADATA_INVALID', 'metadata must be an object')
  }

  const raw = metadata as unknown as Record<string, unknown>
  if (raw.version !== '0.1.0') {
    throw new AppMetadataValidationError('ERR_METADATA_UNSUPPORTED_SCHEMA', 'version must be 0.1.0')
  }

  requireString(raw.name, 'name')
  requireString(raw.description, 'description')
  requireString(raw.icon, 'icon')
  requireString(raw.domain, 'domain')
  requireString(raw.release_date, 'release_date')
  optionalString(raw.publisher, 'publisher')

  if (typeof raw.httpURL !== 'string' && typeof raw.uhrpURL !== 'string') {
    throw new AppMetadataValidationError('ERR_METADATA_INVALID', 'httpURL or uhrpURL must be a string')
  }

  optionalString(raw.httpURL, 'httpURL')
  optionalString(raw.uhrpURL, 'uhrpURL')
  optionalString(raw.short_name, 'short_name')
  optionalString(raw.category, 'category')
  optionalString(raw.changelog, 'changelog')
  optionalString(raw.banner_image_url, 'banner_image_url')
  optionalStringArray(raw.tags, 'tags')
  optionalStringArray(raw.screenshot_urls, 'screenshot_urls')

  return { ...metadata }
}

export function validateAppMetadata (metadata: PublishedAppMetadata): void {
  normalizeAppMetadata(metadata)
}
