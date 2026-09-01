import { Base64String } from '@bsv/sdk'
import * as sdk from '../../../sdk'
import type {
  Brc177NoSendExpiryMode,
  Brc177NoSendExpiryState
} from '../../../utility/brc177NoSendExpiry'

export interface TableTransaction extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  transactionId: number
  userId: number
  provenTxId?: number
  status: sdk.TransactionStatus
  /**
   * max length of 64, hex encoded
   */
  reference: Base64String
  /**
   * true if transaction originated in this wallet, change returns to it.
   * false for a transaction created externally and handed in to this wallet.
   */
  isOutgoing: boolean
  satoshis: number
  description: string
  /**
   * If not undefined, must match value in associated rawTransaction.
   */
  version?: number
  /**
   * Optional. Default is zero.
   * When the transaction can be processed into a block:
   * >= 500,000,000 values are interpreted as minimum required unix time stamps in seconds
   * < 500,000,000 values are interpreted as minimum required block height
   */
  lockTime?: number
  txid?: string
  inputBEEF?: number[]
  rawTx?: number[]
  /** Internal BRC-177 lifecycle metadata. These fields are synchronized with the action. */
  noSendExpiryMode?: Brc177NoSendExpiryMode
  noSendExpiryValue?: number
  /** Resolved Unix seconds for time modes, or the absolute height for blockheight. */
  noSendExpiryDeadline?: number
  noSendExpiryState?: Brc177NoSendExpiryState
  noSendExpiryAnchorTxid?: string
  noSendExpiryAnchorVout?: number
  noSendExpiryReleasedAt?: number
  noSendExpiryObservedAt?: number
  noSendExpiryReclaimTxid?: string
  noSendExpiryReclaimRawTx?: number[]
  noSendExpiryReclaimDerivationPrefix?: string
  noSendExpiryReclaimDerivationSuffix?: string
  noSendExpiryReclaimSatoshis?: number
}

export const transactionColumnsWithoutRawTx = [
  'created_at',
  'updated_at',
  'transactionId',
  'userId',
  'provenTxId',
  'status',
  'reference',
  'isOutgoing',
  'satoshis',
  'version',
  'lockTime',
  'description',
  'txid',
  'noSendExpiryMode',
  'noSendExpiryValue',
  'noSendExpiryDeadline',
  'noSendExpiryState',
  'noSendExpiryAnchorTxid',
  'noSendExpiryAnchorVout',
  'noSendExpiryReleasedAt',
  'noSendExpiryObservedAt',
  'noSendExpiryReclaimTxid',
  'noSendExpiryReclaimDerivationPrefix',
  'noSendExpiryReclaimDerivationSuffix',
  'noSendExpiryReclaimSatoshis'
  //   'inputBEEF',
  //   'rawTx',
  //   'noSendExpiryReclaimRawTx',
]
