import { EntityTimeStamp } from '../../../sdk/types'

export type ActionBatchStatus = 'active' | 'prepared' | 'committed' | 'aborted' | 'expired'

export interface TableActionBatch extends EntityTimeStamp {
  actionBatchId: number
  userId: number
  batchId: string
  status: ActionBatchStatus
  expiresAt: Date
  hardExpiresAt: Date
  manifestDigest?: string
  result?: string
}

export interface TableActionBatchOutput extends EntityTimeStamp {
  actionBatchId: number
  outputId: number
}

export interface TableActionBatchBlob extends EntityTimeStamp {
  actionBatchBlobId: number
  actionBatchId: number
  digest: string
  bytes: number[]
}
