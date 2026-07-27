import {
  GASP,
  GASPVersionMismatchError,
  LogLevel
} from '../../packages/overlays/gasp-core/dist/esm/mod.js'
import { deepEqual, invariant } from '../lib.mjs'

export async function fuzz(data) {
  const numbers = Buffer.alloc(45)
  data.copy(numbers, 0, 0, Math.min(data.length, numbers.length))
  const since = numbers.readUIntBE(0, 6)
  const limit = (numbers.readUInt16BE(6) % 4096) + 1
  const outputs = [
    {
      txid: Buffer.from(data.subarray(8, 40)).toString('hex').padEnd(64, '0'),
      outputIndex: numbers.readUInt32LE(40),
      score: since
    }
  ]
  const storage = {
    async findKnownUTXOs(requestedSince, requestedLimit) {
      invariant(requestedSince === since, 'GASP changed the requested timestamp')
      invariant(requestedLimit === limit, 'GASP changed the requested limit')
      return outputs
    }
  }
  const gasp = new GASP(storage, {}, since, '[fuzz] ', false, false, LogLevel.NONE)
  deepEqual(
    await gasp.buildInitialRequest(since, limit),
    { version: 1, since, limit },
    'GASP generated the wrong initial request'
  )
  deepEqual(
    await gasp.getInitialResponse({ version: 1, since, limit }),
    { since, UTXOList: outputs },
    'GASP generated the wrong initial response'
  )

  const foreignVersion = 2 + numbers[44]
  let mismatch
  try {
    await gasp.getInitialResponse({ version: foreignVersion, since, limit })
  } catch (error) {
    mismatch = error
  }
  invariant(mismatch instanceof GASPVersionMismatchError, 'GASP accepted a foreign version')
  invariant(
    mismatch.currentVersion === 1 && mismatch.foreignVersion === foreignVersion,
    'GASP lost version mismatch evidence'
  )
}
