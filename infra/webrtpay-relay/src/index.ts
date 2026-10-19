/**
 * webrtpay-relay container entry point. Preload ./telemetry.js before this file
 * (see the Dockerfile and the `start` script).
 */
import { log } from './logger.js'
import { startRelay, stopRelay, usage } from './relay.js'

if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
  console.log(usage())
  process.exit(0)
}

try {
  const relay = await startRelay(process.env, log)
  const stop = (signal: NodeJS.Signals): void => {
    stopRelay(relay, signal, log).then(
      () => process.exit(0),
      () => process.exit(1)
    )
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
} catch (err) {
  log.error(
    { operation: 'config.summary', outcome: 'failure', err },
    `webrtpay-relay: ${err instanceof Error ? err.message : String(err)}`
  )
  process.exit(1)
}
