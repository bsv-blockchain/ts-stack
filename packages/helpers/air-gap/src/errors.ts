/**
 * The single error type this package throws.
 *
 * Only the *encoder* throws: it is fed by trusted local code, so a bad message
 * or a bad block size is a programming error worth surfacing loudly. The
 * decoder is fed by a camera and never throws — see {@link AirGapDecoder}.
 */
export class AirGapError extends Error {
  override readonly name = 'AirGapError'

  constructor(message: string) {
    super(message)
    // Keeps `instanceof` working when this package is transpiled down to ES5
    // by a consumer's bundler, which otherwise loses the prototype link.
    Object.setPrototypeOf(this, AirGapError.prototype)
  }
}
