/**
 * Makes constructor-owned configuration effective at runtime as well as at
 * compile time. TypeScript's `readonly` modifier alone does not prevent a
 * JavaScript caller from replacing a provider URL, credential, or client.
 */
export function lockConfiguration(target: object, names: string[]): void {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(target, name)) {
      throw new Error(`Cannot lock missing configuration property ${name}.`)
    }
    Object.defineProperty(target, name, {
      configurable: false,
      writable: false
    })
  }
}
