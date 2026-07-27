import {
  createMinimallyEncodedScriptChunk,
  decodeAssetId,
  decodeScriptNum,
  decodeScriptNumChunk,
  encodeAssetId,
  encodeScriptNum
} from '../../packages/helpers/ts-templates/dist/src/mandala-encoding.js'
import { invariant } from '../lib.mjs'

export function fuzz(data) {
  let magnitude = 0
  for (const byte of data.subarray(0, 6)) magnitude = magnitude * 256 + byte
  const value = (data[6] ?? 0) % 2 === 0 ? magnitude : -magnitude
  const scriptNumber = encodeScriptNum(value)
  invariant(decodeScriptNum(scriptNumber) === value, 'Mandala script-number byte round trip')
  invariant(
    decodeScriptNumChunk(createMinimallyEncodedScriptChunk(scriptNumber)) === value,
    'Mandala minimal script-number chunk round trip'
  )

  const txid = Buffer.from(data.subarray(7, 39)).toString('hex').padEnd(64, '0')
  const voutBytes = Buffer.alloc(4)
  data.copy(voutBytes, 0, 39, 43)
  const vout = voutBytes.readUInt32LE(0)
  const assetId = `${txid}.${vout}`
  invariant(decodeAssetId(encodeAssetId(assetId)) === assetId, 'Mandala asset outpoint round trip')
}
