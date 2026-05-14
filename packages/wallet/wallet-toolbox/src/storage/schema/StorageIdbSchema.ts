import { Base64String, PubKeyHex, HexString } from '@bsv/sdk'
import { ProcessingStatus, SyncStatus } from '../../sdk'
import {
  TableAction,
  TableCertificate,
  TableCertificateField,
  TableChainTip,
  TableCommission,
  TableMonitorEvent,
  TableMonitorLease,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableSyncState,
  TableSettings,
  TableTransactionNew,
  TableTxAudit,
  TableTxLabel,
  TableTxLabelMap,
  TableUser
} from './tables'

/**
 * IndexedDB schema for the v3 greenfield wallet-toolbox storage layout.
 *
 * The IDB mirror mirrors the v3 SQL schema 1:1 — there is no bridge period and
 * no `proven_txs` / `proven_tx_reqs` / `transactions_legacy` stores. Per-user
 * intent lives in `actions`; canonical chain state in `transactions` (PK txid).
 *
 * See `KnexMigrations.ts` for the SQL counterpart.
 */
export interface StorageIdbSchema {
  certificates: {
    key: number
    value: TableCertificate
    indexes: {
      userId: number
      userId_type_certifier_serialNumber: [number, Base64String, PubKeyHex, Base64String]
    }
  }
  certificateFields: {
    key: number
    value: TableCertificateField
    indexes: {
      userId: number
      certificateId: number
    }
  }
  commissions: {
    key: number
    value: TableCommission
    indexes: {
      userId: number
      actionId: number
    }
  }
  monitorEvents: {
    key: number
    value: TableMonitorEvent
  }
  outputs: {
    key: number
    value: TableOutput
    indexes: {
      actionId_vout: [number, number]
      userId_basketId_spendable_satoshis: [number, number, boolean, number]
      userId_spendable_outputId: [number, boolean, number]
      userId_txid: [number, HexString]
      spentByActionId: number
      matures_at_height: number
    }
  }
  outputBaskets: {
    key: number
    value: TableOutputBasket
    indexes: {
      userId: number
      name_userId: [string, number]
    }
  }
  outputTags: {
    key: number
    value: TableOutputTag
    indexes: {
      userId: number
      tag_userId: [string, number]
    }
  }
  outputTagMaps: {
    key: number
    value: TableOutputTagMap
    indexes: {
      outputTagId: number
      outputId: number
    }
  }
  syncStates: {
    key: number
    value: TableSyncState
    indexes: {
      userId: number
      refNum: string
      status: SyncStatus
    }
  }
  settings: {
    key: number
    value: TableSettings
    indexes: Record<string, never>
  }
  /**
   * v3 canonical chain record. `txid` is the primary key — there is no
   * integer `transactionId`. Per-user intent lives in `actions`.
   */
  transactions: {
    key: HexString
    value: TableTransactionNew
    indexes: {
      processing: ProcessingStatus
      batch: string
      idempotencyKey: string
    }
  }
  /**
   * Per-user view of a (potential) transaction. PK `actionId`.
   * FK `txid` is NULL while the action is an unsigned draft.
   */
  actions: {
    key: number
    value: TableAction
    indexes: {
      userId: number
      userId_txid: [number, HexString]
      userId_reference: [number, string]
      userId_hidden: [number, boolean]
      txid: HexString
    }
  }
  txLabels: {
    key: number
    value: TableTxLabel
    indexes: {
      userId: number
      label_userId: [string, number]
    }
  }
  txLabelMaps: {
    key: number
    value: TableTxLabelMap
    indexes: {
      actionId: number
      txLabelId: number
    }
  }
  users: {
    key: number
    value: TableUser
    indexes: {
      identityKey: string
    }
  }
  chainTip: {
    key: number
    value: TableChainTip
    indexes: Record<string, never>
  }
  txAudit: {
    key: number
    value: TableTxAudit
    indexes: {
      txid: HexString
      actionId: number
      event: string
    }
  }
  monitorLease: {
    key: string
    value: TableMonitorLease
    indexes: {
      expiresAt: Date
    }
  }
}
