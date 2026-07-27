import { Utils } from '@bsv/sdk'

export function base64UrlEncode(bytes: Uint8Array | number[] | string): string {
  const data =
    typeof bytes === 'string' ? Array.from(new TextEncoder().encode(bytes)) : Array.from(bytes)
  return Utils.toBase64(data).replaceAll('+', '-').replaceAll('/', '_').split('=', 1)[0]
}

export function base64UrlDecode(value: string): number[] {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new TypeError('Invalid base64url encoding')
  }
  const remainder = value.length % 4
  const lastSextet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(
    value.at(-1) ?? 'A'
  )
  if (
    (remainder === 2 && (lastSextet & 0x0f) !== 0) ||
    (remainder === 3 && (lastSextet & 0x03) !== 0)
  ) {
    throw new TypeError('Invalid base64url encoding')
  }
  const base64 = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Utils.toArray(base64, 'base64')
}

export function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(JSON.stringify(value))
}

export function base64UrlDecodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(base64UrlDecode(value)))) as T
}
