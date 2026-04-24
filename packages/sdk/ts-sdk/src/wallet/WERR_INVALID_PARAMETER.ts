/**
 * The ${parameter} parameter is invalid.
 *
 * This is an example of an error object with a custom property `parameter` and templated `message`.
 */
export class WERR_INVALID_PARAMETER extends Error {
  code: number
  isError: boolean = true

  constructor (
    public parameter: string,
    mustBe?: string
  ) {
    super(`The ${parameter} parameter must be ${mustBe ?? 'valid.'}`)
    this.code = 6
    this.name = this.constructor.name
  }
}

export default WERR_INVALID_PARAMETER
