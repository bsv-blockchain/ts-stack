/**
 * Checks whether a topic manager or lookup service name is canonical: the
 * `tm_` or `ls_` prefix, then lowercase letters and digits in segments joined
 * by single underscores, at most 256 bytes. This admits BRC-87 names and the
 * per-asset BRC-207 names (`tm_color_<txid>_<vout>`, `ls_color_<txid>_<vout>`).
 *
 * Mirrors `OVERLAY_TOPIC_NAME_PATTERN` and `OVERLAY_LOOKUP_SERVICE_NAME_PATTERN`
 * in @bsv/sdk `src/overlay-tools/OverlayNames.ts`. Kept local because the
 * @bsv/sdk peer range includes releases that do not export them.
 * @param service - The name to validate.
 * @returns True if the name is valid, false otherwise.
 */
export const isValidTopicOrServiceName = (service: string): boolean => {
  const serviceRegex = /^(?=.{1,256}$)(?:tm_|ls_)[a-z0-9]+(?:_[a-z0-9]+)*$/
  return serviceRegex.test(service)
}
