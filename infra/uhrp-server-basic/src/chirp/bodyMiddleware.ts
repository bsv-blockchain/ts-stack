import bodyparser from 'body-parser'
import type { RequestHandler } from 'express'
import { readBodyLimitBytes } from '../security/edgePolicy'

export const CHIRP_STAGED_OBJECT_PATH = '/chirp/v1/uploads/:uploadId/objects/:objectIdentifier'
export const CHIRP_OBJECT_MAX_BODY_BYTES = readBodyLimitBytes('CHIRP_OBJECT', 4_194_304)

/** Read bounded identity bytes before authentication signs/verifies req.body. */
export function createChirpObjectBodyParser(): RequestHandler {
  const parse = bodyparser.raw({
    limit: CHIRP_OBJECT_MAX_BODY_BYTES,
    inflate: false,
    // The object route hashes raw bytes regardless of the media type.
    type: () => true
  })
  return (req, res, next) => {
    const encoding = req.get('content-encoding')
    if (encoding != null && encoding.toLowerCase() !== 'identity') {
      res.status(415).json({
        status: 'error',
        code: 'ERR_CHIRP_ENCODING',
        description: 'CHIRP objects require identity content encoding.'
      })
      return
    }
    parse(req, res, next)
  }
}
