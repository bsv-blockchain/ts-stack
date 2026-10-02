import { CompletedProtoWallet, PrivateKey, Hash, Utils } from '@bsv/sdk'
import { IndexedDBProtectedOperationObjectStore } from '@bsv/output-knowledge/operations/objects'
import { WalletProtectedOperationPayload } from '@bsv/output-knowledge/operations/protected'
const id = '96'.repeat(32),
  secondId = '97'.repeat(32),
  binding = { role: 'original-delivery', context: 'synthetic-private-context' }
const key = new PrivateKey(85),
  identity = key.toPublicKey().toString()
const configuration = {
  storeId: '95'.repeat(32),
  recipient: identity,
  binding: { purpose: 'real-browser-custody-fixture' },
  maximumObjects: 2,
  maximumObjectBytes: 4194304
}
function codec(n = 85) {
  const k = new PrivateKey(n)
  return new WalletProtectedOperationPayload(
    new CompletedProtoWallet(k),
    k.toPublicKey().toString()
  )
}
let owner: IndexedDBProtectedOperationObjectStore
async function init(create: boolean) {
  owner = create
    ? await IndexedDBProtectedOperationObjectStore.create(
        'operation-objects-native-browser',
        configuration,
        codec()
      )
    : await IndexedDBProtectedOperationObjectStore.open(
        'operation-objects-native-browser',
        configuration,
        codec()
      )
  return await inspect()
}
async function inspect() {
  const stored = await owner.read(id, binding)
  return stored.state === 'stored'
    ? {
        state: stored.state,
        receipt: stored.receipt,
        length: stored.bytes.length,
        digest: Utils.toHex(Hash.sha256(stored.bytes)),
        first: stored.bytes[0],
        last: stored.bytes[stored.bytes.length - 1]
      }
    : stored
}
async function save() {
  await owner.reserve(id, binding, 4194304)
  return await owner.put(id, binding, new Uint8Array(4194304).fill(65))
}
async function reserveSecond() {
  return await owner.reserve(secondId, binding, 100)
}
async function compete(byte: number) {
  try {
    const receipt = await owner.put(secondId, binding, new Uint8Array([byte]))
    return { status: 'stored', receipt }
  } catch (error) {
    return { status: (error as { code?: string }).code }
  }
}
async function second() {
  const row = await owner.read(secondId, binding)
  return row.state === 'stored' ? { receipt: row.receipt, bytes: Array.from(row.bytes) } : row
}
async function wrongWallet() {
  try {
    await IndexedDBProtectedOperationObjectStore.open(
      'operation-objects-native-browser',
      configuration,
      codec(86)
    )
    return 'unexpected-success'
  } catch (error) {
    return (error as { code?: string }).code
  }
}
async function raw() {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open('operation-objects-native-browser')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result,
        tx = db.transaction('protected-operation-objects'),
        rows = tx.objectStore('protected-operation-objects').getAll()
      tx.oncomplete = () => {
        db.close()
        resolve(JSON.stringify(rows.result))
      }
      tx.onabort = () => reject(tx.error)
    }
  })
}
export const protectedObjectsBrowser = {
  init,
  inspect,
  save,
  reserveSecond,
  compete,
  second,
  wrongWallet,
  raw
}
