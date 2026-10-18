import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

/**
 * The IP address in `req`'s `header` (a lowercase header name) when the header holds
 * exactly one; undefined when it is missing, is a list (comma-separated, or sent more
 * than once) or is not an IP address.
 *
 * No entry of a list is ever taken. Proxies append the address they saw to a list
 * such as `X-Forwarded-For`, so which entry is the client depends on how many proxies
 * the request crossed: behind two (Cloudflare, then Traefik) the last entry is the
 * first proxy's address for every client, and the first entry is chosen by the client.
 */
export function headerAddress(req: IncomingMessage, header: string): string | undefined {
  const value = req.headers[header]
  if (typeof value !== 'string' || value.includes(',')) return undefined
  const a = bare(value)
  return isIP(a) === 0 ? undefined : a
}

/**
 * The key per-source limits count `address` under: an IPv4 address as is (also
 * when it is IPv4-mapped IPv6), and an IPv6 address as its /64 prefix, e.g.
 * `2001:db8:0:1::/64`, because one subscriber is usually handed a whole /64. Any
 * other string is returned unchanged.
 */
export function addressGroup(address: string): string {
  const a = bare(address)
  const family = isIP(a)
  if (family === 4) return a
  if (family !== 6) return address
  const g = ipv6Groups(a)
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.')
  }
  return `${g
    .slice(0, 4)
    .map(x => x.toString(16))
    .join(':')}::/64`
}

/**
 * The /48 an IPv6 address belongs to, e.g. `2001:db8:1::/48`: the coarser group per-source
 * limits also count, because a /48 (one free tunnel-broker allocation) holds 65,536 /64s.
 * Undefined for IPv4, IPv4-mapped IPv6 and anything that is not an IP address.
 */
export function ipv6Block48(address: string): string | undefined {
  const a = bare(address)
  if (isIP(a) !== 6) return undefined
  const g = ipv6Groups(a)
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return undefined
  return `${g
    .slice(0, 3)
    .map(x => x.toString(16))
    .join(':')}::/48`
}

/** `address` trimmed, without IPv6 brackets or a zone index. */
function bare(address: string): string {
  let a = address.trim()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1)
  const zone = a.indexOf('%')
  return zone === -1 ? a : a.slice(0, zone)
}

/** The eight 16-bit groups of a valid IPv6 address (`isIP(a) === 6`). */
function ipv6Groups(a: string): number[] {
  let s = a.toLowerCase()
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const [b0, b1, b2, b3] = tail.split('.').map(Number)
    const hi = ((b0 << 8) | b1).toString(16)
    const lo = ((b2 << 8) | b3).toString(16)
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const [head, rest] = s.split('::')
  const left = head === '' ? [] : head.split(':')
  if (rest === undefined) return left.map(h => Number.parseInt(h, 16))
  const right = rest === '' ? [] : rest.split(':')
  const zeros = Array.from({ length: 8 - left.length - right.length }, () => '0')
  return [...left, ...zeros, ...right].map(h => Number.parseInt(h, 16))
}
