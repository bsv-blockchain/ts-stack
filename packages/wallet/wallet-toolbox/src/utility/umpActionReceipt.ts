import { Beef, type WalletInterface } from '@bsv/sdk'
import type { Wallet } from '../Wallet'
import { verifyUnlockScripts } from '../signer/methods/verifyUnlockScripts'

type ReceiptReader = (operationId: string, originator: string) => Promise<number[] | undefined>

const receiptReaders = new WeakMap<WalletInterface, ReceiptReader>()

/** Local capability. A BRC-100 caller cannot invoke it by choosing an originator or action label. */
export function registerUMPActionReceiptReader(wallet: WalletInterface, read: ReceiptReader): void {
  receiptReaders.set(wallet, read)
}

export async function readUMPActionReceipt(
  wallet: WalletInterface,
  operationId: string,
  originator: string
): Promise<number[] | undefined> {
  if (!/^[0-9a-f]{32}$/.test(operationId)) throw new Error('Invalid UMP operation identifier.')
  return await receiptReaders.get(wallet)?.(operationId, originator)
}

export function umpUpdateActionLabel(operationId: string): string {
  return `ump-update:${operationId}`
}

/** Read the signed request only after binding its transaction ID to the authorized account and operation label. */
export async function readStoredUMPActionReceipt(
  wallet: Pick<Wallet, 'listActions' | 'storage' | 'scriptVerifier'>,
  operationId: string,
  originator: string
): Promise<number[] | undefined> {
  if (!wallet.storage.isActiveStorageProvider()) return undefined
  const label = umpUpdateActionLabel(operationId)
  const { totalActions, actions } = await wallet.listActions(
    { labels: [label], includeLabels: true, limit: 2 },
    originator
  )
  if (totalActions === 0 && actions.length === 0) return undefined
  const [action] = actions
  if (totalActions !== 1 || actions.length !== 1 || !action.isOutgoing || action.labels?.includes(label) !== true)
    throw new Error('Could not bind the retained wallet action to its UMP update.')
  if (action.status === 'unsigned') return undefined

  return await wallet.storage.runAsStorageProvider(async storage => {
    const requests = await storage.findProvenTxReqs({ partial: { txid: action.txid }, paged: { limit: 2 } })
    if (requests.length !== 1) return undefined
    const [request] = requests
    if (request.inputBEEF == null || request.status === 'invalid' || request.status === 'doubleSpend') return undefined
    const beef = new Beef()
    await storage.mergeReqToBeefToShareExternally(request, beef, [])
    await verifyUnlockScripts(action.txid, beef, wallet.scriptVerifier)
    return beef.toBinaryAtomic(action.txid)
  })
}
