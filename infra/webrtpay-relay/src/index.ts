/**
 * webrtpay-relay container entry point. Preload ./telemetry.js before this file
 * (see the Dockerfile and the `start` script).
 *
 * The process never calls process.exit: it sets process.exitCode and lets the
 * event loop drain, so the telemetry bootstrap can flush on shutdown.
 */
import { log } from './logger.js'
import { readRelayOptions, startRelay, stopRelay, usage } from './relay.js'

if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
  console.log(usage())
} else {
  await run()
}

async function run(): Promise<void> {
  let options: ReturnType<typeof readRelayOptions>
  try {
    options = readRelayOptions(process.env)
  } catch (err) {
    log.error(
      { operation: 'config.summary', outcome: 'failure', err },
      `webrtpay-relay: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exitCode = 1
    return
  }
  try {
    const relay = await startRelay(options, log)
    const stop = (signal: NodeJS.Signals): void => {
      stopRelay(relay, signal, log).catch(() => {
        process.exitCode = 1
      })
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  } catch (err) {
    log.error(
      { operation: 'listen', outcome: 'failure', err },
      `webrtpay-relay: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exitCode = 1
  }
}
