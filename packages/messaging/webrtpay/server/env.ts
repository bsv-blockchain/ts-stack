import {
  DEFAULT_RELAY_LIMITS,
  DEFAULT_RELAY_PORT,
  DEFAULT_TURN_TTL_SECONDS,
  isHeaderName,
  isLoopbackHost
} from './relay.js'
import type { RelayLimits, RelayServerOptions } from './relay.js'

/** `HOST` when it is unset: every IPv4 interface. */
export const DEFAULT_HOST = '0.0.0.0'

/**
 * Limits read from the environment, each a whole number of at least 1 (see
 * `RelayLimits`); unset ones keep `DEFAULT_RELAY_LIMITS`. The TURN ones need TURN.
 */
const LIMIT_VARIABLES: ReadonlyArray<[string, keyof RelayLimits, { turn?: boolean }?]> = [
  ['MAX_SOCKETS', 'maxSockets'],
  ['MAX_UNAUTHENTICATED_SOCKETS', 'maxUnauthenticatedSockets'],
  ['SOCKETS_PER_IP', 'maxSocketsPerIp'],
  ['CONNECTIONS_PER_IP_PER_MINUTE', 'connectionsPerIpPerMinute'],
  ['SOCKETS_PER_48', 'maxSocketsPer48'],
  ['CONNECTIONS_PER_48_PER_MINUTE', 'connectionsPer48PerMinute'],
  ['SIGNALS_PER_RECIPIENT_PER_MINUTE', 'signalsPerRecipientPerMinute'],
  ['SIGNALS_PER_PAIR_PER_MINUTE', 'signalsPerPairPerMinute'],
  ['MAX_OVER_RATE_FRAMES', 'maxOverRateFrames'],
  ['TURN_PER_IP_PER_HOUR', 'turnPerIpPerHour', { turn: true }],
  ['TURN_PER_48_PER_HOUR', 'turnPer48PerHour', { turn: true }],
  ['TURN_PER_HOUR', 'turnPerHour', { turn: true }]
]

/**
 * Relay options from environment variables: `PORT` (default `DEFAULT_RELAY_PORT`),
 * `HOST` (default `DEFAULT_HOST`), and comma-separated `PUBLIC_URLS`, `STUN_URLS`
 * and `TURN_URLS`; `TURN_SECRET` and `TURN_URLS` go together and `TURN_TTL` is in
 * seconds (unset, the relay's `DEFAULT_TURN_TTL_SECONDS`). `TRUSTED_IP_HEADER` names
 * the header the outermost proxy sets to the client's single address:
 * `cf-connecting-ip` behind Cloudflare. A list value is not used, so
 * `x-forwarded-for` is right only behind exactly one proxy that overwrites it (see
 * `trustedIpHeader`). Empty variables count as unset.
 * `PUBLIC_URLS` is required unless `HOST` is a loopback address (`localhost`,
 * `127.x.x.x` or `::1`), because without it clients sign a url built from the Host
 * header they send.
 *
 * Limits (whole numbers, `limits.*`): `MAX_SOCKETS`, `MAX_UNAUTHENTICATED_SOCKETS`,
 * `SOCKETS_PER_IP`, `CONNECTIONS_PER_IP_PER_MINUTE`, `SOCKETS_PER_48`,
 * `CONNECTIONS_PER_48_PER_MINUTE`, `SIGNALS_PER_RECIPIENT_PER_MINUTE`,
 * `SIGNALS_PER_PAIR_PER_MINUTE`, `MAX_OVER_RATE_FRAMES`, and, with TURN configured,
 * `TURN_PER_IP_PER_HOUR`, `TURN_PER_48_PER_HOUR` and `TURN_PER_HOUR`.
 *
 * Throws `Error` naming the variable on an invalid or missing value.
 */
export function relayOptionsFromEnv(env: Record<string, string | undefined>): RelayServerOptions {
  const host = env.HOST?.trim() || DEFAULT_HOST
  const o: RelayServerOptions = {
    port: env.PORT ? wholeNumber('PORT', env.PORT, 0, 65535) : DEFAULT_RELAY_PORT,
    host
  }
  const publicUrls = list(env.PUBLIC_URLS)
  if (publicUrls.length > 0) o.publicUrls = publicUrls
  else if (!isLoopbackHost(host)) {
    throw new Error(
      `PUBLIC_URLS is required when HOST (${host}) is not a loopback address: list the ` +
        'wss:// urls clients dial, e.g. PUBLIC_URLS=wss://relay.example.com. A relay ' +
        'behind a proxy needs it even when it listens on loopback (set HOST=127.0.0.1 ' +
        'without PUBLIC_URLS only for local development)'
    )
  }
  const trustedIpHeader = env.TRUSTED_IP_HEADER?.trim()
  if (trustedIpHeader) {
    if (!isHeaderName(trustedIpHeader)) {
      throw new Error('TRUSTED_IP_HEADER must be an HTTP header name, e.g. cf-connecting-ip')
    }
    o.trustedIpHeader = trustedIpHeader
  }
  const stunUrls = list(env.STUN_URLS)
  if (stunUrls.length > 0) o.stunUrls = stunUrls

  const secret = env.TURN_SECRET ?? ''
  const turnUrls = list(env.TURN_URLS)
  const turnLimits = LIMIT_VARIABLES.filter(([name, , o]) => o?.turn === true && env[name]?.trim())
  if (secret !== '' || turnUrls.length > 0 || env.TURN_TTL || turnLimits.length > 0) {
    if (secret === '') {
      const set = [
        ...(turnUrls.length > 0 ? ['TURN_URLS'] : []),
        ...(env.TURN_TTL ? ['TURN_TTL'] : []),
        ...turnLimits.map(([name]) => name)
      ]
      throw new Error(`TURN_SECRET is required when ${set.join(' or ')} is set`)
    }
    if (turnUrls.length === 0) throw new Error('TURN_URLS is required when TURN_SECRET is set')
    o.turn = { secret, urls: turnUrls }
    if (env.TURN_TTL) o.turn.ttlSeconds = wholeNumber('TURN_TTL', env.TURN_TTL, 1, 2 ** 31 - 1)
  }

  const limits: Partial<RelayLimits> = {}
  for (const [name, limit] of LIMIT_VARIABLES) {
    const value = env[name]?.trim()
    if (value) limits[limit] = wholeNumber(name, value, 1, 2 ** 31 - 1)
  }
  if (Object.keys(limits).length > 0) o.limits = limits
  return o
}

/** The settings `relayOptionsFromEnv` reads besides the limits, as `--help` lists them. */
const SETTING_VARIABLES: ReadonlyArray<[string, string]> = [
  ['PORT', `port to listen on (default ${DEFAULT_RELAY_PORT})`],
  ['HOST', `address to listen on (default ${DEFAULT_HOST})`],
  ['PUBLIC_URLS', 'comma-separated wss:// urls clients dial; required unless HOST is loopback'],
  ['TRUSTED_IP_HEADER', "header the outermost proxy sets to the client's address"],
  ['STUN_URLS', 'comma-separated STUN urls handed to clients'],
  ['TURN_SECRET', 'coturn static-auth-secret; requires TURN_URLS'],
  ['TURN_URLS', 'comma-separated TURN urls to issue credentials for; requires TURN_SECRET'],
  [
    'TURN_TTL',
    `lifetime of issued TURN credentials in seconds (default ${DEFAULT_TURN_TTL_SECONDS})`
  ]
]

/** What `webrtpay-relay --help` prints: every variable `relayOptionsFromEnv` reads. */
export function relayUsage(): string {
  const width = Math.max(...[...SETTING_VARIABLES, ...LIMIT_VARIABLES].map(([n]) => n.length)) + 2
  return [
    'Usage: webrtpay-relay [--help]',
    '',
    'Runs the @bsv/webrtpay signaling relay, configured by environment variables.',
    'Empty variables count as unset. SIGTERM or SIGINT closes it.',
    '',
    ...SETTING_VARIABLES.map(([name, what]) => `  ${name.padEnd(width)}${what}`),
    '',
    'Limits, whole numbers of at least 1 (default shown):',
    ...LIMIT_VARIABLES.map(([name, limit, o]) => {
      const turn = o?.turn === true ? ', requires TURN_SECRET' : ''
      return `  ${name.padEnd(width)}${DEFAULT_RELAY_LIMITS[limit]}${turn}`
    })
  ].join('\n')
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
}

function wholeNumber(name: string, v: string, min: number, max: number): number {
  const n = /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN
  if (!(n >= min && n <= max)) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  }
  return n
}
