import { Utils } from '@bsv/sdk'

export function base64UrlEncode (bytes: Uint8Array | number[] | string): string {
  const data = typeof bytes === 'string'
    ? Array.from(new TextEncoder().encode(bytes))
    : Array.from(bytes)
  return Utils.toBase64(data)
    .split('+').join('-')
    .split('/').join('_')
    .split('=', 1)[0]
}

export function base64UrlDecode (value: string): number[] {
  const base64 = value
    .split('-').join('+')
    .split('_').join('/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Utils.toArray(base64, 'base64')
}

export function base64UrlEncodeJson (value: unknown): string {
  return base64UrlEncode(JSON.stringify(value))
}

export function base64UrlDecodeJson<T> (value: string): T {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(base64UrlDecode(value)))) as T
}
