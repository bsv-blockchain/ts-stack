import type { RelayIceServer } from '../src/signaling/RelaySignaler.js'
import type { CloudflareTurnProvider, TurnIssuer } from './turn.js'

/** Longest lifetime Cloudflare gives TURN credentials: 48 hours, in seconds. */
export const CLOUDFLARE_MAX_TTL_SECONDS = 172800
/** Time Cloudflare has to answer a credentials request, body included. */
export const CLOUDFLARE_TIMEOUT_MS = 5000
/** Longest answer the relay reads: 64 KiB, some 20 times what Cloudflare sends. */
export const CLOUDFLARE_MAX_BODY_BYTES = 65536
/** Most TURN urls the relay forwards: Cloudflare lists 6. */
export const CLOUDFLARE_MAX_TURN_URLS = 8

const API_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys/'
/** A TURN key id, which becomes a path segment of the API url. */
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,256}$/
/** A bearer token: visible ASCII, without spaces. */
const API_TOKEN_RE = /^[\x21-\x7e]+$/
const STUN_URL_RE = /^stuns?:/i
const TURN_URL_RE = /^turns?:/i
/**
 * A url on port 53, Cloudflare's former alternate port. Browsers block it, so a gather that
 * does not trickle would wait for it to time out.
 */
const PORT_53_RE = /:53(?:[?/]|$)/
/** What a failure may say about itself: a code such as `ECONNREFUSED`, or `AbortError`. */
const DIAGNOSTIC_CODE_RE = /^[A-Z_]{1,40}$/
const DIAGNOSTIC_NAME_RE = /^[A-Za-z]{1,40}Error$/

/** A failure whose message is fixed text: no secret, credential or url. */
class CloudflareTurnError extends Error {
  constructor(reason: string) {
    super(`Cloudflare TURN: ${reason}`)
    this.name = 'CloudflareTurnError'
  }
}

/**
 * An issuer that asks Cloudflare Realtime TURN for each set of credentials:
 * `POST https://rtc.live.cloudflare.com/v1/turn/keys/<keyId>/credentials/generate-ice-servers`
 * with `Authorization: Bearer <apiToken>` and `{ "ttl": <ttl> }`, the ttl capped at 48
 * hours. It never sends the identity key. A request has 5 s, its body included; an answer
 * other than 200 or 201, a timeout, a body over 64 KiB or a body without TURN credentials
 * rejects. Cloudflare's answer says nothing of the lifetime, so `expiresAt` is the time the
 * request started plus the ttl, which can only be early.
 */
export function cloudflareTurnIssuer(p: CloudflareTurnProvider, ttlSeconds: number): TurnIssuer {
  if (typeof p.keyId !== 'string' || !KEY_ID_RE.test(p.keyId)) {
    throw new TypeError('turn.keyId must be a Cloudflare TURN key id (letters, digits, - and _)')
  }
  if (typeof p.apiToken !== 'string' || !API_TOKEN_RE.test(p.apiToken)) {
    throw new TypeError('turn.apiToken must be a Cloudflare API token, without spaces')
  }
  const fetchFn = p.fetch ?? globalThis.fetch
  if (typeof fetchFn !== 'function') throw new TypeError('turn.fetch must be a fetch function')
  const ttl = Math.min(ttlSeconds, CLOUDFLARE_MAX_TTL_SECONDS)
  const url = `${API_URL}${p.keyId}/credentials/generate-ice-servers`
  const headers = { authorization: `Bearer ${p.apiToken}`, 'content-type': 'application/json' }
  const body = JSON.stringify({ ttl })
  return {
    kind: 'cloudflare',
    ttlSeconds: ttl,
    async issue() {
      const now = Date.now()
      try {
        const iceServers = await withDeadline(async signal => {
          const res = await fetchFn(url, { method: 'POST', headers, body, signal })
          if (res.status !== 200 && res.status !== 201) {
            res.body?.cancel().catch(() => {})
            throw new CloudflareTurnError(`HTTP ${Number(res.status)}`)
          }
          const text = await readText(res)
          let answer: unknown
          try {
            answer = JSON.parse(text)
          } catch {
            throw new CloudflareTurnError('the answer is not JSON')
          }
          return cloudflareIceServers(answer)
        })
        return { iceServers, expiresAt: now + ttl * 1000 }
      } catch (e) {
        // Only this module's own messages leave it: what fetch or the body throws may hold
        // the url or more. The one thing taken from it is a code or a name that fits an
        // allow-list, so the log says why a request failed, such as `ECONNREFUSED`.
        if (e instanceof CloudflareTurnError) throw e
        const why = diagnostic(e)
        throw new CloudflareTurnError(
          why === undefined ? 'request failed' : `request failed (${why})`
        )
      }
    }
  }
}

/**
 * The ICE servers in Cloudflare's answer, as the relay hands them out: one entry with
 * every STUN url, then each TURN entry with its urls and credentials. `iceServers` may be a
 * list (today's answer: a STUN entry and a TURN entry; until 2025 a single entry mixing
 * both) or one object (the older `/credentials/generate`). Entries are told apart by url
 * scheme, never by position; urls on port 53 and of other schemes are dropped, and so is a
 * TURN entry without a username and credential. At most 8 TURN urls are kept, the first
 * ones listed. Throws when no TURN url is left.
 */
export function cloudflareIceServers(answer: unknown): RelayIceServer[] {
  const entries = iceServerEntries(isRecord(answer) ? answer.iceServers : undefined)
  if (entries.length === 0) throw new CloudflareTurnError('the answer lists no ICE servers')
  const stun: string[] = []
  const turn: RelayIceServer[] = []
  let turnUrlCount = 0
  for (const entry of entries.filter(isRecord)) {
    const urls = entryUrls(entry)
    addStunUrls(stun, urls)
    const server = turnServer(entry, urls, CLOUDFLARE_MAX_TURN_URLS - turnUrlCount)
    if (server !== undefined) {
      turn.push(server)
      turnUrlCount += server.urls.length
    }
  }
  if (turn.length === 0) throw new CloudflareTurnError('the answer has no TURN server')
  return stun.length > 0 ? [{ urls: stun }, ...turn] : turn
}

/** The answer's `iceServers` as a list: a list as it is, one object as a list of one. */
function iceServerEntries(listed: unknown): unknown[] {
  if (Array.isArray(listed)) return listed
  return isRecord(listed) ? [listed] : []
}

/** An entry's urls, a list or a single one, without those that are not strings or use port 53. */
function entryUrls(entry: Record<string, unknown>): string[] {
  const listed: unknown[] = Array.isArray(entry.urls) ? entry.urls : [entry.urls]
  return listed.filter((u): u is string => typeof u === 'string' && !PORT_53_RE.test(u))
}

/** Add the STUN urls among `urls` to `stun`, each once. */
function addStunUrls(stun: string[], urls: string[]): void {
  for (const u of urls) if (STUN_URL_RE.test(u) && !stun.includes(u)) stun.push(u)
}

/**
 * The entry's TURN server: the first `room` of its TURN urls, with its username and
 * credential. Undefined when no TURN url fits, or the username or credential is missing or
 * empty.
 */
function turnServer(
  entry: Record<string, unknown>,
  urls: string[],
  room: number
): { urls: string[]; username: string; credential: string } | undefined {
  const turnUrls = urls.filter(u => TURN_URL_RE.test(u)).slice(0, room)
  const { username, credential } = entry
  if (turnUrls.length > 0 && nonEmpty(username) && nonEmpty(credential)) {
    return { urls: turnUrls, username, credential }
  }
  return undefined
}

/**
 * The body of `res` as text, read in at most 64 KiB: a `content-length` over the limit is
 * refused unread, and a body without one is read chunk by chunk until it ends or passes the
 * limit. A body that is refused or fails is released.
 */
async function readText(res: Response): Promise<string> {
  // absent, empty or not a number: the count of the bytes read decides
  if (Number(res.headers.get('content-length')) > CLOUDFLARE_MAX_BODY_BYTES) {
    res.body?.cancel().catch(() => {})
    throw new CloudflareTurnError('the answer is too large')
  }
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > CLOUDFLARE_MAX_BODY_BYTES) throw new CloudflareTurnError('the answer is too large')
      chunks.push(value)
    }
  } catch (e) {
    reader.cancel().catch(() => {})
    throw e
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * What a failure may tell: its `cause.code` (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`) or
 * else its `name` (`TypeError`, `AbortError`), when it is made of letters and fits, never
 * its message, which may hold the url. Undefined when neither fits.
 */
function diagnostic(e: unknown): string | undefined {
  try {
    const cause = isRecord(e) ? e.cause : undefined
    const code = isRecord(cause) ? cause.code : undefined
    if (typeof code === 'string' && DIAGNOSTIC_CODE_RE.test(code)) return code
    const name = isRecord(e) ? e.name : undefined
    if (typeof name === 'string' && DIAGNOSTIC_NAME_RE.test(name)) return name
  } catch {
    // a property that throws tells nothing
  }
  return undefined
}

/**
 * Run `work`, aborting its signal and rejecting once `CLOUDFLARE_TIMEOUT_MS` have passed,
 * even when `work` does not stop on the abort.
 */
async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new CloudflareTurnError(`no answer within ${CLOUDFLARE_TIMEOUT_MS / 1000} s`))
    }, CLOUDFLARE_TIMEOUT_MS)
    // a request still waiting does not keep a process that is shutting down alive
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    // race() handles a rejection from whichever of the two loses
    return await Promise.race([work(controller.signal), expired])
  } finally {
    clearTimeout(timer)
  }
}

function nonEmpty(x: unknown): x is string {
  return typeof x === 'string' && x !== ''
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
