import { OutputProtocolError, parseOutputServiceError, type OutputServiceError } from '@bsv/sdk'

export class LookupLimitError extends OutputProtocolError {
  readonly limit: NonNullable<OutputServiceError['error']['limit']>
  constructor(limit: NonNullable<OutputServiceError['error']['limit']>) {
    super('limited', 'Lookup response cannot fit the complete envelope or next whole group')
    const checked = parseOutputServiceError({
      version: 1,
      error: { code: this.code, message: this.message, retryable: false, limit }
    })
    this.limit = Object.freeze(checked.error.limit!)
  }
}
