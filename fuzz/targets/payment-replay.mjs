import { InMemoryPaymentReplayStore } from '../../packages/middleware/payment-express-middleware/dist/mod.mjs'
import { invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const transactionIds = [
    ...new Set(
      utf8(data, 65_536)
        .split('\0')
        .filter(value => value.length > 0)
        .slice(0, 64)
    )
  ]
  if (transactionIds.length === 0) transactionIds.push('seed')

  const store = new InMemoryPaymentReplayStore(transactionIds.length)
  for (const transactionId of transactionIds) {
    invariant(store.claim(transactionId), 'Payment replay store rejected a new transaction')
    invariant(!store.claim(transactionId), 'Payment replay store accepted a duplicate transaction')
  }

  let overflow = 'overflow'
  while (transactionIds.includes(overflow)) overflow += '-next'
  let capacityRejected = false
  try {
    store.claim(overflow)
  } catch {
    capacityRejected = true
  }
  invariant(capacityRejected, 'Payment replay store exceeded its governed capacity')
}
