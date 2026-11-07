import { outputAssert, OutputProtocolError } from './OutputProtocolError.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'

/**
 * Canonical BRC-194 base, including its path prefix. This validates URI spelling;
 * it does not authorize a destination or replace DNS/address/network policy.
 * Local HTTP must be selected by trusted caller configuration.
 */
export function canonicalOutputBase(input: string, allowLocalHTTP = false): string {
  outputAssert(
    typeof input === 'string' && input.length > 0 && input.length <= 2048,
    'Invalid overlay base length'
  )
  canonicalOutputJSON(input)
  outputAssert(
    !Array.from(input).some(character => {
      const point = character.codePointAt(0)!
      return point <= 32 || point === 127 || String.raw`\?#`.includes(character)
    }),
    'Invalid overlay base characters'
  )
  const parts = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(input)
  outputAssert(parts !== null, 'Overlay base must be HTTP(S)')
  const scheme = parts[1].toLowerCase(),
    authority = parts[2],
    path = parts[3] ?? ''
  outputAssert(scheme === 'https' || allowLocalHTTP, 'Overlay base requires HTTPS')
  outputAssert(!/[@%\u0080-\uffff]/.test(authority), 'Invalid overlay authority')
  const labels = path.split('/').slice(1)
  for (let i = 0; i < labels.length; i++) {
    outputAssert(labels[i] !== '.' && labels[i] !== '..', 'Overlay dot segment')
    outputAssert(labels[i] !== '' || i === labels.length - 1, 'Empty overlay path segment')
  }
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== '%') continue
    const escape = path.slice(i + 1, i + 3)
    outputAssert(/^[0-9a-fA-F]{2}$/.test(escape), 'Malformed overlay percent escape')
    const decoded = String.fromCodePoint(Number.parseInt(escape, 16))
    outputAssert(
      decoded.codePointAt(0) !== 0 && !/[A-Za-z0-9\-._~/\\%]/.test(decoded),
      'Ambiguous overlay path escape'
    )
    i += 2
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new OutputProtocolError('invalid', 'Invalid overlay base URL')
  }
  outputAssert(
    url.username === '' && url.password === '' && url.search === '' && url.hash === '',
    'Invalid overlay base components'
  )
  if (authority.startsWith('[')) {
    outputAssert(/^\[[0-9a-fA-F:]+\](?::\d+)?$/.test(authority), 'Invalid IPv6 overlay authority')
  } else {
    const match = /^([^:]+)(?::(\d+))?$/.exec(authority)
    outputAssert(match !== null, 'Invalid overlay host or port')
    const host = match[1].toLowerCase()
    outputAssert(host.length <= 253 && host === url.hostname, 'Noncanonical overlay host')
    outputAssert(
      host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
      'Invalid overlay DNS labels'
    )
  }
  // URL canonicalizes IPv6/default ports and escapes raw UTF-8 path characters.
  const canonicalPath = url.pathname
    .replace(/%[0-9a-fA-F]{2}/g, escape => escape.toUpperCase())
    .replace(/\/$/, '')
  const result = `${url.origin}${canonicalPath}`
  outputAssert(
    result.length <= 2048 && /^[\x21-\x7e]+$/.test(result),
    'Overlay base exceeds URI bound'
  )
  return result
}

/** Endpoint suffixes are literal protocol paths, never origin-relative URLs. */
export function outputEndpoint(base: string, suffix: string, allowLocalHTTP = false): string {
  outputAssert(
    /^\/overlay\/v1\/[a-z-]+(?:\/[a-z-]+)?$/.test(suffix),
    'Invalid overlay endpoint suffix'
  )
  return canonicalOutputBase(base, allowLocalHTTP) + suffix
}
