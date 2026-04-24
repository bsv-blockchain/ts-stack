let isEnabled = false

export function enable (): void {
  isEnabled = true
}

export function disable (): void {
  isEnabled = false
}

export function log (...args: unknown[]): void {
  if (isEnabled) {
    console.log(...args)
  }
}

export function warn (...args: unknown[]): void {
  if (isEnabled) {
    console.warn(...args)
  }
}

export function error (...args: unknown[]): void {
  console.error(...args)
}
