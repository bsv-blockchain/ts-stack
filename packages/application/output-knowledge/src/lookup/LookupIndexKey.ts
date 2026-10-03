import { OutputProtocolError } from '@bsv/sdk'

/** Internal versioned-index order key: at most 128 bytes, canonically hex encoded. */
export function lookupIndexKey(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > 256 ||
    input.length % 2 !== 0 ||
    /[^0-9a-f]/.test(input)
  )
    throw new OutputProtocolError('invalid', 'Invalid lookup index order key')
  return input
}
