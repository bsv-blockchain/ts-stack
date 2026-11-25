interface FetchManifestParams {
  domain: string
}

/**
 * Fetches and returns the contents of `/manifest.json` for a given domain.
 *
 * - Strips **all** protocol prefixes from the supplied domain.
 * - Forces `http` for `localhost`, defaults to `https` otherwise.
 * - Uses an `AbortController` to aggressively timeout stalled requests so that
 *   sites *without* a manifest don’t block the caller.
 * - Always resolves to an **object** – falling back to an empty object `{}`
 *   on any kind of failure (network error, non‑2xx status, invalid JSON, etc.).
 *
 * @param {FetchManifestParams} params – `{ domain }` to query
 * @param {number} [timeout=800] – hard timeout in **milliseconds** before aborting
 */
export function appMetadataUrl(
  domain: string,
  file: 'manifest.json' | 'favicon.ico'
): URL | undefined {
  let cleanDomain = domain
  while (/^https?:\/\//i.test(cleanDomain)) {
    cleanDomain = cleanDomain.slice(cleanDomain.indexOf('//') + 2)
  }
  if (!cleanDomain || cleanDomain.includes('\\')) return undefined
  const protocol = cleanDomain.startsWith('localhost:') ? 'http' : 'https'
  try {
    const url = new URL(`${protocol}://${cleanDomain}/${file}`)
    if (!url.username && !url.password && !url.search && !url.hash) return url
    return undefined
  } catch {
    return undefined
  }
}

export default async function fetchManifest(
  { domain }: FetchManifestParams,
  timeout = 800
): Promise<Record<string, unknown>> {
  const url = appMetadataUrl(domain, 'manifest.json')
  if (!url) return {}

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit' })
    if (!res.ok) return {}
    const data: unknown = await res.json()
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}
