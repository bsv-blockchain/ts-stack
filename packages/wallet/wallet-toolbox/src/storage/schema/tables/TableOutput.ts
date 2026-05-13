import { Base64String, DescriptionString5to50Bytes, PubKeyHex } from '@bsv/sdk'
import { TableOutputBasket } from './TableOutputBasket'
import { TableOutputTag } from './TableOutputTag'
import * as sdk from '../../../sdk'

export interface TableOutput extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  outputId: number
  userId: number
  transactionId: number
  basketId?: number
  spendable: boolean
  change: boolean
  outputDescription: DescriptionString5to50Bytes
  vout: number
  satoshis: number
  providedBy: sdk.StorageProvidedBy
  purpose: string
  type: string
  txid?: string
  senderIdentityKey?: PubKeyHex
  derivationPrefix?: Base64String
  derivationSuffix?: Base64String
  customInstructions?: string
  spentBy?: number
  sequenceNumber?: number
  spendingDescription?: string
  scriptLength?: number
  scriptOffset?: number
  lockingScript?: number[]
  /**
   * new-schema: minimum block height at which a coinbase output becomes spendable.
   * NULL for non-coinbase outputs and for pre-new schema rows that have not yet been
   * backfilled. The §4 spendability rule treats a non-coinbase output as
   * mature regardless of this column.
   */
  maturesAtHeight?: number
}

export interface TableOutputX extends TableOutput {
  basket?: TableOutputBasket
  tags?: TableOutputTag[]
}

export const outputColumnsWithoutLockingScript = [
  'created_at',
  'updated_at',
  'outputId',
  'userId',
  'transactionId',
  'basketId',
  'spendable',
  'change',
  'vout',
  'satoshis',
  'providedBy',
  'purpose',
  'type',
  'outputDescription',
  'txid',
  'senderIdentityKey',
  'derivationPrefix',
  'derivationSuffix',
  'customInstructions',
  'spentBy',
  'sequenceNumber',
  'spendingDescription',
  'scriptLength',
  'scriptOffset'
  // 'lockingScript',
]
