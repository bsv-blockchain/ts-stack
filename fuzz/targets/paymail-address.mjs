import { parsePaymail } from '../../packages/messaging/ts-paymail/dist/src/paymailAddress.js'
import { invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const raw = utf8(data, 4096)
  const parsed = parsePaymail(raw)
  if (parsed !== undefined) {
    invariant(`${parsed.name}@${parsed.domain}` === raw, 'Paymail parser changed input spelling')
    invariant(parsed.name.length > 0 && parsed.name.length <= 64, 'Paymail alias bounds')
    invariant(parsed.domain.length > 0 && parsed.domain.length <= 253, 'Paymail domain bounds')
    invariant(
      parsed.domain.split('.').every(label => label.length > 0 && label.length <= 63),
      'Paymail DNS label bounds'
    )
  }

  const alias = data.subarray(0, 32).toString('hex') || '0'
  const domain = `${data.subarray(32, 48).toString('hex') || 'seed'}.example`
  const valid = `${alias}@${domain}`
  const roundTrip = parsePaymail(valid)
  invariant(roundTrip?.name === alias && roundTrip.domain === domain, 'Paymail valid round trip')
}
