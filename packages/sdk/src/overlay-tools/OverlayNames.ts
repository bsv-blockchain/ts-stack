/**
 * Topic manager and lookup service name grammar shared by the overlay tools.
 *
 * A name is the `tm_` (topic manager) or `ls_` (lookup service) prefix
 * followed by one or more segments of lowercase letters and digits joined by
 * single underscores, at most {@link MAX_OVERLAY_NAME_BYTES} bytes in total.
 * This admits BRC-87 names such as `tm_uhrp_files` and the per-asset BRC-207
 * names `tm_color_<txid>_<vout>` and `ls_color_<txid>_<vout>`. The length
 * bound matches the overlay engine's topic limit.
 */

/** Maximum UTF-8 byte length of a topic manager or lookup service name. */
export const MAX_OVERLAY_NAME_BYTES = 256

/** Canonical topic manager name: `tm_` then `[a-z0-9]+` segments joined by `_`. */
export const OVERLAY_TOPIC_NAME_PATTERN = /^(?=.{1,256}$)tm_[a-z0-9]+(?:_[a-z0-9]+)*$/

/** Canonical lookup service name: `ls_` then `[a-z0-9]+` segments joined by `_`. */
export const OVERLAY_LOOKUP_SERVICE_NAME_PATTERN = /^(?=.{1,256}$)ls_[a-z0-9]+(?:_[a-z0-9]+)*$/

/** Returns true when `value` is a canonical topic manager name. */
export function isOverlayTopicName(value: unknown): value is string {
  return typeof value === 'string' && OVERLAY_TOPIC_NAME_PATTERN.test(value)
}

/** Returns true when `value` is a canonical lookup service name. */
export function isOverlayLookupServiceName(value: unknown): value is string {
  return typeof value === 'string' && OVERLAY_LOOKUP_SERVICE_NAME_PATTERN.test(value)
}
