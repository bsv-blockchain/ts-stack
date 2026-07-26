const DEFAULT_HTTP_PORT = 8080
const MAX_TCP_PORT = 65_535

interface HttpPortEnvironment {
  PORT?: string
  HTTP_PORT?: string
}

function parsePort(value: string | undefined, name: string): number | undefined {
  if (value == null || value.trim() === '') return undefined
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_TCP_PORT}.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TCP_PORT) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_TCP_PORT}.`)
  }
  return parsed
}

/**
 * PORT is the cloud/container convention. HTTP_PORT remains a compatibility
 * fallback for existing operators. The service itself listens directly on the
 * selected port; there is no hidden in-container reverse proxy.
 */
export function resolveHttpPort(environment: HttpPortEnvironment = process.env): number {
  return (
    parsePort(environment.PORT, 'PORT') ??
    parsePort(environment.HTTP_PORT, 'HTTP_PORT') ??
    DEFAULT_HTTP_PORT
  )
}
