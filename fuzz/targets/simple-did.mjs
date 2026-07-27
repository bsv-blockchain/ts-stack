import { DID } from '../../packages/helpers/simple/dist/index.mjs'
import { deepEqual, invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const raw = utf8(data, 4096)
  const valid = DID.isValid(raw)
  if (valid) {
    const parsed = DID.parse(raw)
    invariant(parsed.method === 'bsv', 'Simple DID parser returned the wrong method')
    invariant(`did:bsv:${parsed.identifier}` === raw, 'Simple DID parser changed its identifier')
  }

  const txid = Buffer.from(data.subarray(0, 32)).toString('hex').padEnd(64, '0')
  const did = DID.fromTxid(txid)
  deepEqual(
    DID.parse(did),
    { method: 'bsv', identifier: txid },
    'Simple DID transaction identifier round trip'
  )
}
