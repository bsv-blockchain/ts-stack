let isEnabled = false

const MAX_DIAGNOSTIC_EVENT_BYTES = 512

/**
 * Diagnostics are intentionally event-only. Callers must not attach wallet
 * errors, message bodies, identity keys, URLs, tokens, transactions, or other
 * application data: browser and host consoles are often retained or exported.
 */
function safeEvent(event: string): string | undefined {
  if (typeof event !== 'string') return undefined
  const encoded = new TextEncoder().encode(event)
  if (encoded.length === 0 || encoded.length > MAX_DIAGNOSTIC_EVENT_BYTES) return undefined
  return event
}

export function enable(): void {
  isEnabled = true
}

export function disable(): void {
  isEnabled = false
}

export function log(event: string): void {
  const safe = safeEvent(event)
  if (isEnabled && safe !== undefined) console.log(safe)
}

export function warn(event: string): void {
  const safe = safeEvent(event)
  if (isEnabled && safe !== undefined) console.warn(safe)
}

export function error(event: string): void {
  const safe = safeEvent(event)
  if (isEnabled && safe !== undefined) console.error(safe)
}
