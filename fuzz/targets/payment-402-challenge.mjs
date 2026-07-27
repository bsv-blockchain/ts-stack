import { HEADERS, send402 } from '../../packages/middleware/402-pay/dist/index.mjs'
import { attempt, invariant, utf8 } from '../lib.mjs'

const IDENTITY_KEY = '03f8104e2b313136ef1b84fcd9c8aadb775beb89a8207c942b31ab89e160ba4c86'

function responseRecorder() {
  const response = {
    statusCode: undefined,
    headers: {},
    ended: false,
    status(code) {
      response.statusCode = code
      return response
    },
    set(headers) {
      Object.assign(response.headers, headers)
      return response
    },
    end() {
      response.ended = true
    }
  }
  return response
}

export function fuzz(data) {
  const priceBytes = Buffer.alloc(6)
  data.copy(priceBytes, 0, 0, Math.min(data.length, priceBytes.length))
  const sats = priceBytes.readUIntBE(0, priceBytes.length) + 1
  const validResponse = responseRecorder()
  send402(validResponse, IDENTITY_KEY, sats)
  invariant(validResponse.statusCode === 402 && validResponse.ended, '402 challenge did not end')
  invariant(validResponse.headers[HEADERS.SATS] === String(sats), '402 price changed')
  invariant(validResponse.headers[HEADERS.SERVER] === IDENTITY_KEY, '402 identity changed')

  const response = responseRecorder()
  const result = attempt(() => send402(response, utf8(data, 512), sats))
  if (!result.ok) {
    invariant(
      response.statusCode === undefined &&
        Object.keys(response.headers).length === 0 &&
        !response.ended,
      'Rejected 402 input partially mutated the response'
    )
  }
}
