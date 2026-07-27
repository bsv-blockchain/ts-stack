import { LockingScript, OP, Utils } from '../../packages/sdk/dist/esm/mod.js'
import {
  addOpReturnData,
  extractOpReturnData,
  isP2PKH
} from '../../packages/helpers/bsv-wallet-helper/dist/index.mjs'
import { deepEqual, invariant } from '../lib.mjs'

function baseScript(hash) {
  return new LockingScript([
    { op: OP.OP_DUP },
    { op: OP.OP_HASH160 },
    { op: 20, data: Array.from(hash) },
    { op: OP.OP_EQUALVERIFY },
    { op: OP.OP_CHECKSIG }
  ])
}

export function fuzz(data) {
  const hash = Uint8Array.from(data.subarray(0, 20))
  const paddedHash = Uint8Array.from({ length: 20 }, (_, index) => hash[index] ?? 0)
  const original = baseScript(paddedHash)
  const originalHex = original.toHex()

  const fields = []
  let offset = 20
  while (offset < data.length && fields.length < 16) {
    const length = Math.min((data[offset] ?? 0) + 1, data.length - offset - 1)
    fields.push(Array.from(data.subarray(offset + 1, offset + 1 + length)))
    offset += length + 1
  }
  if (fields.length === 0) fields.push([0])
  const encoded = addOpReturnData(original, fields)
  invariant(original.toHex() === originalHex, 'Wallet helper mutated the base locking script')
  deepEqual(
    extractOpReturnData(encoded),
    fields.map(field => Utils.toBase64(field)),
    'Wallet helper changed OP_RETURN fields'
  )

  const canonical = `76a914${Utils.toHex(Array.from(paddedHash))}88ac`
  invariant(isP2PKH(canonical), 'Wallet helper rejected a generated P2PKH script')
  const rawHex = data.toString('hex')
  invariant(
    isP2PKH(rawHex) === /^76a914[0-9a-f]{40}88ac$/.test(rawHex),
    'Wallet helper P2PKH classifier diverged from the canonical shape'
  )
}
