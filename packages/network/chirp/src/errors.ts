export class CHIRPError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CHIRPError'
    this.code = code
  }
}

export class CHIRPResilienceError extends CHIRPError {
  readonly requiredHosts: number
  readonly successfulHosts: number

  constructor(requiredHosts: number, successfulHosts: number) {
    super(
      'ERR_CHIRP_RESILIENCE',
      `CHIRP publication required ${requiredHosts} complete hosts but only ${successfulHosts} committed.`
    )
    this.name = 'CHIRPResilienceError'
    this.requiredHosts = requiredHosts
    this.successfulHosts = successfulHosts
  }
}
