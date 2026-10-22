import type { Knex } from 'knex'
import { join } from 'node:path'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'

interface PrivateDestinationLease {
  readonly maximumPages: number
  readonly filename: string
  readonly withDatabase: <T>(readOnly: boolean, work: (database: Knex) => Promise<T>) => Promise<T>
  readonly assertLive: () => void
}
const leases = new WeakMap<StorageKnex, Readonly<PrivateDestinationLease>>()

/** Internal authority derives from the actual private owner and shared pool.
 * A caller-supplied flag cannot relax the ordinary destination's WAL contract. */
export function registerBrc38PrivateDestinationLease(storage: StorageKnex, store: KnexBrc38StagingStore): void {
  store.assertPrivateNativeDestination(storage.knex)
  leases.set(
    storage,
    Object.freeze({
      maximumPages: store.privateNativeDestinationPageLimit,
      filename: join(store.directory, 'stage.sqlite'),
      withDatabase: <T>(readOnly: boolean, work: (database: Knex) => Promise<T>) =>
        store.withPrivateNativeDatabase(readOnly, work),
      assertLive: () => store.assertPrivateNativeDestination(storage.knex)
    })
  )
}
export function brc38PrivateDestinationLease(storage: StorageKnex): Readonly<PrivateDestinationLease> | undefined {
  return leases.get(storage)
}
