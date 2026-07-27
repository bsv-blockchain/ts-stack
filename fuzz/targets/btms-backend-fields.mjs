import BTMSTopicManager from '../../packages/overlays/btms-backend/dist/esm/src/topic-managers/BTMSTopicManager.js'
import { invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const manager = new BTMSTopicManager()
  const raw = utf8(data, 4096)
  const expected = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN
  const amount = manager.parseTokenAmount(raw)
  if (Number.isSafeInteger(expected)) {
    invariant(amount === expected, 'BTMS backend rejected a canonical safe token amount')
  } else {
    invariant(amount === undefined, 'BTMS backend admitted a non-canonical token amount')
  }

  const txid = Buffer.from(data.subarray(0, 32)).toString('hex').padEnd(64, '0')
  const indexBytes = Buffer.alloc(4)
  data.copy(indexBytes, 0, 32, Math.min(data.length, 36))
  const outputIndex = indexBytes.readUInt32LE(0)
  invariant(
    manager.canonicalAssetId('ISSUE', txid, outputIndex) === `${txid}.${outputIndex}`,
    'BTMS backend derived the wrong issuance asset ID'
  )
  if (raw !== 'ISSUE') {
    invariant(
      manager.canonicalAssetId(raw, txid, outputIndex) === raw,
      'BTMS backend changed an existing asset ID'
    )
  }
}
