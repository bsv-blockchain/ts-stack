#!/usr/bin/env node
import { relayOptionsFromEnv, relayUsage } from './env.js'
import { createRelayServer } from './relay.js'

// webrtpay-relay: configured by environment variables (`--help` lists them; see
// relayOptionsFromEnv), among them TURN_PROVIDER (coturn: TURN_SECRET and TURN_URLS;
// cloudflare: CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN). It refuses to start
// without PUBLIC_URLS unless HOST is a loopback address, and with a half-configured TURN
// provider. SIGTERM or SIGINT closes it.
if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
  console.log(relayUsage())
  process.exit(0)
}

try {
  const relay = await createRelayServer({
    ...relayOptionsFromEnv(process.env),
    log: msg => console.log(msg)
  })
  const stop = (): void => {
    relay.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err)
        process.exit(1)
      }
    )
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
} catch (err) {
  console.error(`webrtpay-relay: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
