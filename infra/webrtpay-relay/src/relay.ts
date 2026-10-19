/**
 * Starts the @bsv/webrtpay signalling relay from environment variables.
 *
 * Configuration parsing, `/health` and `/ready`, CORS and the WebSocket protocol
 * all belong to the published package (`@bsv/webrtpay/server`); this image only
 * adds structured logging and telemetry around it.
 */
import { createRelayServer, relayOptionsFromEnv, relayUsage } from '@bsv/webrtpay/server'
import type { RelayServer } from '@bsv/webrtpay/server'

/** The pino methods the relay wrapper uses. */
export interface RelayLogger {
  info: (fields: Record<string, unknown>, message: string) => void
  error: (fields: Record<string, unknown>, message: string) => void
}

/** Every environment variable the relay reads, as `webrtpay-relay --help` prints them. */
export const usage = (): string => relayUsage()

/**
 * Parse `env` and start listening. Rejects, naming the variable, on invalid or
 * missing configuration (for example `PUBLIC_URLS` on a non-loopback `HOST`).
 */
export async function startRelay(
  env: Record<string, string | undefined>,
  log: RelayLogger
): Promise<RelayServer> {
  const options = relayOptionsFromEnv(env)
  const started = Date.now()
  const relay = await createRelayServer({
    ...options,
    log: message => log.info({ operation: 'relay.event' }, message)
  })
  log.info(
    {
      operation: 'listen',
      outcome: 'success',
      duration_ms: Date.now() - started,
      port: relay.port,
      public_urls: options.publicUrls ?? [],
      turn: options.turn?.kind ?? 'none'
    },
    `webrtpay relay listening on ${relay.url}`
  )
  return relay
}

/** Close every socket and stop listening, logging the outcome. */
export async function stopRelay(
  relay: RelayServer,
  signal: string,
  log: RelayLogger
): Promise<void> {
  const started = Date.now()
  try {
    await relay.close()
    log.info(
      { operation: 'shutdown', outcome: 'success', duration_ms: Date.now() - started, signal },
      'webrtpay relay closed'
    )
  } catch (err) {
    log.error(
      { operation: 'shutdown', outcome: 'failure', duration_ms: Date.now() - started, err },
      'webrtpay relay did not close cleanly'
    )
    throw err
  }
}
