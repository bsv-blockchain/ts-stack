import { Base64String, PubKeyHex, HexString } from '@bsv/sdk'
import { ProcessingStatus, ProvenTxReqStatus, SyncStatus, TransactionStatus } from '../../sdk'
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
  TableProvenTx,
  TableProvenTxReq,
  TableSyncState,
  TableSettings,
  TableTransaction,
  TableTransactionNew,
  TableTxAudit,
  TableTxLabel,
  TableTxLabelMap,
  TableUser
} from './tables'

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
      transactionId: number
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
      userId: number
      transactionId: number
      basketId: number
      spentBy: string
      transactionId_vout_userId: [number, number, number]
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
  provenTxs: {
    key: number
    value: TableProvenTx
    indexes: {
      txid: HexString
    }
  }
  provenTxReqs: {
    key: number
    value: TableProvenTxReq
    indexes: {
      provenTxId: number
      txid: HexString
      status: ProvenTxReqStatus
      batch: string
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
  transactions: {
    key: number
    value: TableTransaction
    indexes: {
      userId: number
      provenTxId: number
      reference: string
      status: TransactionStatus
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
      transactionId: number
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
  // New additive object stores. Existing stores remain unchanged for compatibility.
  transactionsNew: {
    key: number
    value: TableTransactionNew
    indexes: {
      txid: HexString
      processing: ProcessingStatus
      batch: string
      idempotencyKey: string
    }
  }
  actions: {
    key: number
    value: TableAction
    indexes: {
      userId: number
      transactionId: number
      userId_transactionId: [number, number]
      userId_reference: [number, string]
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
      transactionId: number
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
