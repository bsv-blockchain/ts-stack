/** Convert an untrusted diagnostic to bounded, single-line text suitable for logs and status APIs. */
export function safeDiagnostic(value: unknown, maximum = 512): string {
  const source = value instanceof Error ? value.message : String(value)
  let result = ''
  let replacingControl = false
  for (let index = 0; index < source.length && result.length < maximum; index++) {
    const code = source.charCodeAt(index)
    const control = code <= 31 || code === 127
    if (control) {
      if (!replacingControl && result.length < maximum) result += ' '
      replacingControl = true
    } else {
      result += source[index]
      replacingControl = false
    }
  }
  return result
}

export function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}
