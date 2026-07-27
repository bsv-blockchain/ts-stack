import {
  computeBasmRoot,
  computeTac,
  serializeErrorForLog,
  serializeLogValue
} from '../../packages/overlays/overlay/dist/esm/mod.js'
import { attempt, invariant, utf8 } from '../lib.mjs'

function transactionIds(data) {
  const values = []
  for (let offset = 0; offset < data.length && values.length < 64; offset += 32) {
    values.push(
      Buffer.from(data.subarray(offset, offset + 32))
        .toString('hex')
        .padEnd(64, '0')
    )
  }
  return values.length === 0 ? ['00'.repeat(32)] : values
}

export function fuzz(data) {
  const txids = transactionIds(data)
  const records = txids.map((txid, blockIndex) => ({ txid, blockIndex })).reverse()
  const root = computeBasmRoot(txids)
  invariant(computeBasmRoot(records) === root, 'Overlay BASM root ignored block ordering')
  invariant(
    computeBasmRoot(txids.map(txid => txid.toUpperCase())) === root,
    'Overlay BASM root changed with hexadecimal case'
  )
  invariant(/^[0-9a-f]{64}$/.test(root), 'Overlay BASM root is not a 32-byte hash')
  invariant(
    /^[0-9a-f]{64}$/.test(computeTac('00'.repeat(32), txids[0], root)),
    'Overlay TAC is not a 32-byte hash'
  )

  const raw = attempt(() => JSON.parse(utf8(data, 65_536)))
  const value = raw.ok ? raw.value : utf8(data, 65_536)
  const serialized = serializeLogValue(value)
  invariant(
    !/[\r\n\u0080-\u009f\u2028\u2029]/.test(serialized),
    'Overlay log serializer admitted a forged line boundary'
  )
  invariant(serializeErrorForLog(value) === serialized, 'Overlay error logging diverged')
}
