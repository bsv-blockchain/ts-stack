import { IndexedDBOperationStateStore } from '@bsv/output-knowledge/operations'
import {
  CompletedProtoWallet,
  PrivateKey,
  OutputProtocolError,
  OutputPaidLookupTransport,
  canonicalOutputJSON
} from '@bsv/sdk'
import {
  ProtectedOperationStateStore,
  WalletProtectedOperationPayload,
  protectedOperationBinding,
  PROTECTED_OPERATION_INITIAL
} from '@bsv/output-knowledge/operations/protected'

const options = { binding: { recipient: 'synthetic-browser-recipient' }, maximumValueBytes: 1024 }
const initial = { phase: 'selected', privateRequest: 'synthetic-recipient-context' }
let owner: ProtectedOperationStateStore
let base: IndexedDBOperationStateStore
function codec(number = 84): WalletProtectedOperationPayload {
  // Public deterministic fixture key; production custody comes from the user's wallet.
  const key = new PrivateKey(number)
  return new WalletProtectedOperationPayload(
    new CompletedProtoWallet(key),
    key.toPublicKey().toString(),
    2048
  )
}
async function initialize(create: boolean) {
  if (typeof OutputPaidLookupTransport !== 'function')
    throw new Error('Packed SDK paid client export missing')
  const payload = codec(),
    binding = protectedOperationBinding(options, payload)
  base = create
    ? await IndexedDBOperationStateStore.create(
        'browser-protected-control',
        'buyer',
        binding,
        PROTECTED_OPERATION_INITIAL
      )
    : await IndexedDBOperationStateStore.open('browser-protected-control', 'buyer', binding)
  owner = create
    ? await ProtectedOperationStateStore.initialize(base, payload, options, initial)
    : await ProtectedOperationStateStore.open(base, payload, options)
  return await inspect()
}
async function inspect() {
  return { saved: await owner.read(), raw: canonicalOutputJSON((await base.read()).value) }
}
async function cas(revision: string, phase: string) {
  return await owner.compareAndSwap(revision, { phase, privateRequest: initial.privateRequest })
}
async function wrongWallet() {
  try {
    await ProtectedOperationStateStore.open(base, codec(85), options)
    throw new Error('Unexpected custody replacement')
  } catch (error) {
    if (!(error instanceof OutputProtocolError)) throw error
    return error.code
  }
}
export const protectedBrowser = { initialize, inspect, cas, wrongWallet }
