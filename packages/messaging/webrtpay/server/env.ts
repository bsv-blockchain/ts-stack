import { DEFAULT_RELAY_LIMITS, DEFAULT_RELAY_PORT, isHeaderName, isLoopbackHost } from './relay.js'
import type { RelayLimits, RelayServerOptions } from './relay.js'
import { DEFAULT_TURN_TTL_SECONDS } from './turn.js'
import type { CloudflareTurnProvider, CoturnRestTurnProvider, TurnProvider } from './turn.js'

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
 * `HOST` (default `DEFAULT_HOST`), and comma-separated `PUBLIC_URLS` and `STUN_URLS`.
 *
 * TURN: `TURN_PROVIDER` is `coturn` (the default) or `cloudflare`. coturn REST needs
 * `TURN_SECRET` and comma-separated `TURN_URLS`, together; Cloudflare needs
 * `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`, together, and takes no
 * `TURN_SECRET` or `TURN_URLS`. A half-configured or mixed provider is refused rather than
 * started without TURN. `TURN_TTL` is in seconds (unset, `DEFAULT_TURN_TTL_SECONDS`;
 * Cloudflare caps it at 48 hours).
 *
 * `TRUSTED_IP_HEADER` names the header the outermost proxy sets to the client's single
 * address: `cf-connecting-ip` behind Cloudflare. A list value is not used, so
 * `x-forwarded-for` is right only behind exactly one proxy that overwrites it (see
 * `trustedIpHeader`). Empty variables count as unset.
 *
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
  const turn = turnFromEnv(env)
  if (turn !== undefined) o.turn = turn

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
  [
    'TURN_PROVIDER',
    'where TURN credentials come from: coturn (default with TURN_SECRET) or cloudflare'
  ],
  [
    'TURN_SECRET',
    'coturn static-auth-secret; requires TURN_URLS, refused with TURN_PROVIDER=cloudflare'
  ],
  [
    'TURN_URLS',
    'comma-separated TURN urls to issue credentials for; requires TURN_SECRET, refused with ' +
      'TURN_PROVIDER=cloudflare'
  ],
  [
    'CLOUDFLARE_TURN_KEY_ID',
    'Cloudflare TURN key id; requires TURN_PROVIDER=cloudflare and CLOUDFLARE_TURN_API_TOKEN'
  ],
  [
    'CLOUDFLARE_TURN_API_TOKEN',
    "the TURN key's API token (never logged); requires TURN_PROVIDER=cloudflare and " +
      'CLOUDFLARE_TURN_KEY_ID'
  ],
  [
    'TURN_TTL',
    `lifetime of issued TURN credentials in seconds (default ${DEFAULT_TURN_TTL_SECONDS}); ` +
      'Cloudflare caps it at 172800'
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
    'GET /health answers 200 while it runs; GET /ready answers 200, then 503 once closing.',
    '',
    ...SETTING_VARIABLES.map(([name, what]) => `  ${name.padEnd(width)}${what}`),
    '',
    'Limits, whole numbers of at least 1 (default shown):',
    ...LIMIT_VARIABLES.map(([name, limit, o]) => {
      const turn = o?.turn === true ? ', requires a TURN provider' : ''
      return `  ${name.padEnd(width)}${DEFAULT_RELAY_LIMITS[limit]}${turn}`
    })
  ].join('\n')
}

/** The TURN variables, read and checked as far as every provider takes them. */
interface TurnVariables {
  /** `TURN_PROVIDER`: `coturn`, `cloudflare`, or empty when unset. */
  provider: string
  secret: string
  turnUrls: string[]
  keyId: string
  apiToken: string
  ttlSeconds: number | undefined
}

/** The TURN provider the variables configure (see `relayOptionsFromEnv`), if any. */
function turnFromEnv(env: Record<string, string | undefined>): TurnProvider | undefined {
  const turn = turnVariables(env)
  if (turn.provider === 'cloudflare') return cloudflareFromEnv(turn)
  return coturnFromEnv(turn, turnLimitsSet(env))
}

/**
 * Every TURN variable, whichever provider is named, so that the other provider's settings
 * can be refused. `TURN_PROVIDER` is checked first, then `TURN_TTL`, before anything that
 * only one provider needs.
 */
function turnVariables(env: Record<string, string | undefined>): TurnVariables {
  const provider = env.TURN_PROVIDER?.trim() ?? ''
  if (provider !== '' && provider !== 'coturn' && provider !== 'cloudflare') {
    throw new Error('TURN_PROVIDER must be coturn or cloudflare')
  }
  const secret = env.TURN_SECRET ?? ''
  const turnUrls = list(env.TURN_URLS)
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim() ?? ''
  const apiToken = env.CLOUDFLARE_TURN_API_TOKEN?.trim() ?? ''
  const ttl = env.TURN_TTL?.trim() ?? ''
  const ttlSeconds = ttl === '' ? undefined : wholeNumber('TURN_TTL', ttl, 1, 2 ** 31 - 1)
  return { provider, secret, turnUrls, keyId, apiToken, ttlSeconds }
}

/** The TURN limits set (see `LIMIT_VARIABLES`), in the order `--help` lists them. */
function turnLimitsSet(env: Record<string, string | undefined>): string[] {
  return LIMIT_VARIABLES.filter(([name, , o]) => o?.turn === true && env[name]?.trim()).map(
    ([name]) => name
  )
}

/** `TURN_PROVIDER=cloudflare`: the key id and API token, and no coturn settings. */
function cloudflareFromEnv(turn: TurnVariables): CloudflareTurnProvider {
  const coturnSet = namesSet([
    ['TURN_SECRET', turn.secret !== ''],
    ['TURN_URLS', turn.turnUrls.length > 0]
  ])
  if (coturnSet.length > 0) {
    const several = coturnSet.length > 1
    throw new Error(
      `${coturnSet.join(' and ')} ${several ? 'are' : 'is'} for ` +
        'TURN_PROVIDER=coturn; Cloudflare chooses its own urls, so unset ' +
        `${several ? 'them' : 'it'} with TURN_PROVIDER=cloudflare`
    )
  }
  const missing = namesSet([
    ['CLOUDFLARE_TURN_KEY_ID', turn.keyId === ''],
    ['CLOUDFLARE_TURN_API_TOKEN', turn.apiToken === '']
  ])
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} required when ` +
        'TURN_PROVIDER=cloudflare'
    )
  }
  return {
    kind: 'cloudflare',
    keyId: turn.keyId,
    apiToken: turn.apiToken,
    ...(turn.ttlSeconds === undefined ? {} : { ttlSeconds: turn.ttlSeconds })
  }
}

/**
 * `TURN_PROVIDER` unset or `coturn`: coturn REST from `TURN_SECRET` and `TURN_URLS`, or no
 * TURN when neither they nor `TURN_PROVIDER`, `TURN_TTL` or a TURN limit (`turnLimits`, the
 * names set) is set. No Cloudflare settings.
 */
function coturnFromEnv(
  turn: TurnVariables,
  turnLimits: string[]
): CoturnRestTurnProvider | undefined {
  const cloudflareSet = namesSet([
    ['CLOUDFLARE_TURN_KEY_ID', turn.keyId !== ''],
    ['CLOUDFLARE_TURN_API_TOKEN', turn.apiToken !== '']
  ])
  if (cloudflareSet.length > 0) {
    throw new Error(
      `TURN_PROVIDER=cloudflare is required when ${cloudflareSet.join(' or ')} is set`
    )
  }
  if (turn.provider === '' && turn.secret === '' && turn.turnUrls.length === 0) {
    refuseTurnSettingsWithoutProvider(turn.ttlSeconds, turnLimits)
    return undefined
  }
  if (turn.secret === '') {
    const set = namesSet([
      ['TURN_PROVIDER', turn.provider === 'coturn'],
      ['TURN_URLS', turn.turnUrls.length > 0],
      ['TURN_TTL', turn.ttlSeconds !== undefined]
    ])
    throw new Error(`TURN_SECRET is required when ${[...set, ...turnLimits].join(' or ')} is set`)
  }
  if (turn.turnUrls.length === 0) throw new Error('TURN_URLS is required when TURN_SECRET is set')
  return {
    kind: 'coturn-rest',
    secret: turn.secret,
    urls: turn.turnUrls,
    ...(turn.ttlSeconds === undefined ? {} : { ttlSeconds: turn.ttlSeconds })
  }
}

/**
 * With no provider configured, refuse `TURN_TTL` and the TURN limits (`turnLimits`, the
 * names set), the settings every provider takes, naming both ways to configure one.
 */
function refuseTurnSettingsWithoutProvider(
  ttlSeconds: number | undefined,
  turnLimits: string[]
): void {
  const set = [...namesSet([['TURN_TTL', ttlSeconds !== undefined]]), ...turnLimits]
  if (set.length === 0) return
  throw new Error(
    `TURN_SECRET is required when ${set.join(' or ')} is set (or set ` +
      'TURN_PROVIDER=cloudflare with CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN)'
  )
}

/** The names whose flag is true, in order. */
function namesSet(flags: ReadonlyArray<[string, boolean]>): string[] {
  return flags.filter(([, set]) => set).map(([name]) => name)
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
