// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class Logger {
  private static isEnabled = false

  static enable(): void {
    this.isEnabled = true
  }

  static disable(): void {
    this.isEnabled = false
  }

  static log(...args: unknown[]): void {
    if (this.isEnabled) {
      console.log(...args)
    }
  }

  static warn(...args: unknown[]): void {
    if (this.isEnabled) {
      console.warn(...args)
    }
  }

  static error(...args: unknown[]): void {
    console.error(...args)
  }
}