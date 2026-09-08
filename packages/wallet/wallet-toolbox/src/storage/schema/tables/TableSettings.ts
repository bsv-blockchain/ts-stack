import * as sdk from '../../../sdk'

export interface TableSettings extends sdk.StorageIdentity, sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  /**
   * The identity key (public key) assigned to this storage
   */
  storageIdentityKey: string
  /**
   * The human readable name assigned to this storage.
   */
  storageName: string
  chain: sdk.Chain
  dbtype: 'SQLite' | 'MySQL' | 'IndexedDB'
  /** Runtime-only RPC capability advertisement; never persisted as a settings column. */
  syncCheckpointVersion?: 1
  maxOutputScript: number
}
