import { CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { SQLiteOperationStateStore } from '../../dist/operations/SQLiteOperationStateStore.js'
import {
  ProtectedOperationStateStore,
  protectedOperationBinding
} from '../../dist/operations/ProtectedOperationStateStore.js'
import { WalletProtectedOperationPayload } from '../../dist/operations/WalletProtectedOperationPayload.js'
const [path, stage] = process.argv.slice(2)
const wallet = new CompletedProtoWallet(new PrivateKey(84))
const payload = new WalletProtectedOperationPayload(
  wallet,
  new PrivateKey(84).toPublicKey().toString(),
  2048
)
const options = {
  binding: { scope: 'synthetic-private-buyer', generation: '1' },
  maximumValueBytes: 1024
}
const base = SQLiteOperationStateStore.open(
  path,
  'buyer-one',
  protectedOperationBinding(options, payload)
)
const stop = async point => {
  if (stage !== point) return
  process.send?.({ phase: point })
  await new Promise(() => {})
}
const write = base.compareAndSwap.bind(base)
base.compareAndSwap = async (...args) => {
  await stop('before-commit')
  const result = await write(...args)
  await stop('after-commit')
  return result
}
const seal = payload.seal.bind(payload)
payload.seal = async (...args) => {
  await stop('before-encryption')
  const result = await seal(...args)
  await stop('after-encryption')
  return result
}
const owner = await ProtectedOperationStateStore.open(base, payload, options)
await owner.compareAndSwap('1', { phase: 'signed', payment: 'original-retained-payment' })
throw new Error('Expected process interruption did not occur')
