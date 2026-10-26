const MAX_QR_DATA_URL_BYTES = 256 * 1024

function utf8Length(value: string): number {
  let length = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x7f) length += 1
    else if (codePoint <= 0x7ff) length += 2
    else if (codePoint <= 0xffff) length += 3
    else length += 4
  }
  return length
}

function boundedString(value: unknown, context: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || utf8Length(value) > maximum) {
    throw new TypeError(`${context} must be a non-empty string of at most ${maximum} UTF-8 bytes`)
  }
  return value
}

/** Reject browser-executable URLs before a server-provided pairing artifact reaches UI code. */
export function requirePairingUri(value: unknown, context = 'pairing URI'): string {
  const uri = boundedString(value, context, 8_192)
  const match = /^([a-z][a-z0-9+.-]{0,31}):\/\/pair\?[^#]+$/iu.exec(uri)
  if (match == null) throw new TypeError(`${context} must be a bounded non-web pair deep link`)
  const scheme = match[1]!.toLowerCase()
  if (
    scheme === 'blob' ||
    scheme === 'data' ||
    scheme === 'file' ||
    scheme === 'ftp' ||
    scheme === 'http' ||
    scheme === 'https' ||
    scheme === 'javascript' ||
    scheme === 'vbscript'
  ) {
    throw new TypeError(`${context} must use a non-web wallet deep-link scheme`)
  }
  return uri
}

/** Limit rendered server artwork to an inert PNG data URL. */
export function requireQrDataUrl(value: unknown, context = 'QR data URL'): string {
  const dataUrl = boundedString(value, context, MAX_QR_DATA_URL_BYTES)
  const prefix = 'data:image/png;base64,'
  const payload = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : ''
  if (
    payload.length === 0 ||
    payload.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload) ||
    !payload.startsWith('iVBORw0KGgo')
  ) {
    throw new TypeError(`${context} must be a bounded base64 PNG data URL`)
  }
  return dataUrl
}
