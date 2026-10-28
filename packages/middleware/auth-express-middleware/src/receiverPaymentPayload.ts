/** Receiver-owned protocol decoding. Keep published SDK2 consumers independent
 * of the SDK3 client's optional payment helpers. Raw-byte ownership, transport
 * quotas and authentication are enforced before this decoder is called. */
function toUTF8Strict(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Decode an authenticated application payload while retaining its separately owned raw bytes. */
export function decodePaymentPayload(
  body: Uint8Array | undefined,
  contentType: string | undefined
): unknown {
  if (body === undefined) return undefined
  const mediaType = contentType?.split(';')[0].trim().toLowerCase()
  if (mediaType === 'application/json' || mediaType?.endsWith('+json') === true)
    return JSON.parse(toUTF8Strict(body)) as unknown
  if (mediaType?.startsWith('text/') === true) return toUTF8Strict(body)
  if (mediaType === 'application/x-www-form-urlencoded') {
    const values = new Map<string, string | string[]>()
    for (const [key, value] of new URLSearchParams(toUTF8Strict(body))) {
      const prior = values.get(key)
      if (prior === undefined) values.set(key, value)
      else if (Array.isArray(prior)) prior.push(value)
      else values.set(key, [prior, value])
    }
    // Remote names remain Map keys until the complete data record is built.
    // fromEntries creates own data properties, including __proto__; remove its
    // prototype before publishing the same null-prototype application payload.
    return Object.setPrototypeOf(Object.fromEntries(values), null)
  }
  return body
}

export function isMultipartPaymentType(value: string): boolean {
  return value.split(';')[0].trim().toLowerCase() === 'multipart/form-data'
}

/** Keep released non-multipart preimages; bind the exact multipart boundary and parameters. */
export function authenticatedContentType(value: string): string {
  return isMultipartPaymentType(value) ? value : value.split(';')[0].trim()
}
