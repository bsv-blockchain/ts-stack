import { toUTF8Strict } from '../../primitives/utils.js'

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
    const values = Object.create(null) as Record<string, string | string[]>
    for (const [key, value] of new URLSearchParams(toUTF8Strict(body))) {
      const prior = values[key]
      if (prior === undefined) values[key] = value
      else if (Array.isArray(prior)) prior.push(value)
      else values[key] = [prior, value]
    }
    return values
  }
  return body
}
