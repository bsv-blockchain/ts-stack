import { AsyncLocalStorage } from 'node:async_hooks'
import type { StorageKnex } from './StorageKnex'
import type { AuthId, TrxToken } from '../sdk/WalletStorage.interfaces'
import type { StorageActiveWrite, StorageWriterAdmission } from './StorageActiveWrite'
import { WERR_INVALID_OPERATION } from '../sdk/WERR_errors'
interface Operation {
  readonly auth: { userId: number | undefined; identityKey: string }
  readonly write: StorageActiveWrite
  readonly admission: StorageWriterAdmission
  open: boolean
}
interface Context {
  readonly operation: Operation
  readonly trx?: TrxToken
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION(
    'Wallet write needs its original live manager admission and explicit nested transaction'
  )
}
/** Local-only scheduling state attached to genuine provider-issued captures.
 * No proxy provider, JSON token, source actor or database permission is created.
 * Other profiles retain their own independently captured financial writers. */
export class KnexWalletWriteAdmission {
  private readonly context = new AsyncLocalStorage<Context>()
  constructor(private readonly storage: StorageKnex) {}
  async run<T>(auth: AuthId, admission: StorageWriterAdmission, work: () => Promise<T>): Promise<T> {
    const actor = { userId: auth.userId, identityKey: auth.identityKey }
    if (this.context.getStore() !== undefined) invalid()
    const write = await this.storage.activeWriteTransaction(actor)
    if (write.prepareOutsideManager !== true) invalid()
    const operation: Operation = { auth: actor, write, admission, open: true }
    try {
      const result = await this.context.run({ operation }, work)
      await admission(async () => await write.assertCurrent())
      return result
    } finally {
      operation.open = false
    }
  }
  captured(auth: AuthId): StorageActiveWrite | undefined {
    const context = this.context.getStore()
    if (
      context === undefined ||
      auth.userId !== context.operation.auth.userId ||
      auth.identityKey !== context.operation.auth.identityKey
    )
      return undefined
    const operation = context.operation
    if (!operation.open) invalid()
    return {
      prepareOutsideManager: true,
      assertCurrent: async () => {
        if (!operation.open) invalid()
        await operation.write.assertCurrent()
      },
      transaction: async <T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T> => {
        if (!operation.open) invalid()
        const current = this.context.getStore()
        if (current?.operation !== operation) invalid()
        if (current.trx !== undefined) {
          if (trx !== current.trx) invalid()
          return await operation.write.transaction(scope, trx)
        }
        return await operation.admission(async () => {
          if (!operation.open) invalid()
          return await operation.write.transaction(
            async token => await this.context.run({ operation, trx: token }, async () => await scope(token)),
            trx
          )
        })
      }
    }
  }
}
