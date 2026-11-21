import { promiseFromSync } from '../../utility/promiseFromSync'
import {
  Brc38SemanticStage,
  type Brc38StageRecord,
  type Brc38StageStore,
  type Brc38SemanticStageOptions
} from './Brc38SemanticStage'
import { readBrc38JsonStream } from './Brc38JsonStream'
import { jsonStreamFixture } from './Brc38JsonStreamFixture'
import type { BRC38WalletData } from './index'
import type { PortableRow } from './Brc38PortableRows'

export function semanticStageFixture(): BRC38WalletData {
  const data = jsonStreamFixture()
  Object.assign(data.sourceStorage, {
    dbtype: 'SQLite',
    maxOutputScript: 10000
  })
  Object.assign(data.tables.provenTxs[0], {
    height: 1,
    index: 0,
    blockHash: 'b'.repeat(64),
    merkleRoot: 'c'.repeat(64)
  })
  Object.assign(data.tables.provenTxReqs[0], {
    status: 'completed',
    attempts: 2,
    notified: true,
    notify: { transactionIds: [14, 999] },
    rawTx: 'AQI='
  })
  Object.assign(data.tables.outputBaskets[0], {
    numberOfDesiredUTXOs: 32,
    minimumDesiredUTXOValue: 1000
  })
  Object.assign(data.tables.transactions[0], {
    status: 'completed',
    reference: 'archive-ref',
    isOutgoing: true,
    satoshis: 5,
    description: 'original'
  })
  Object.assign(data.tables.commissions[0], {
    satoshis: 1,
    keyOffset: 'original',
    isRedeemed: false,
    lockingScript: 'AQI='
  })
  Object.assign(data.tables.outputs[0], {
    spendable: false,
    change: true,
    outputDescription: 'original',
    vout: 0,
    satoshis: 5,
    providedBy: 'you',
    purpose: 'change',
    type: 'P2PKH'
  })
  data.tables.outputTagMaps[0].isDeleted = true
  data.tables.txLabelMaps[0].isDeleted = false
  Object.assign(data.tables.certificates[0], {
    type: 'type',
    serialNumber: 'serial',
    certifier: 'certifier',
    subject: 'subject',
    revocationOutpoint: 'outpoint',
    signature: 'signature',
    isDeleted: true
  })
  data.tables.certificateFields[0].masterKey = 'key'
  Object.assign(data.tables.syncStates[0], {
    storageName: 'original source',
    status: 'completed',
    init: true,
    refNum: 'original-sync-ref',
    syncMap: { output: { idMap: { '160': 16 } } }
  })
  return data
}
/** Small pure oracle only. The production store must separately prove actual
 * indexed queries, physical quotas, transactions, ownership and recovery. */
export function memoryStageStore() {
  const rows = new Map<string, Readonly<PortableRow>>(),
    unique = new Set<string>(),
    members = new Set<string>()
  let header: Readonly<BRC38WalletData> | undefined,
    sealed = 0,
    discarded = 0,
    maximumReturnedRows = 0
  const store: Brc38StageStore = {
    append(record: Brc38StageRecord) {
      return promiseFromSync(() => {
        const rowKey = JSON.stringify([record.table, record.index])
        if (rows.has(rowKey)) throw new Error('Duplicate staged row')
        const keys = record.uniqueKeys.map(value => JSON.stringify([value.namespace, value.key]))
        if (keys.some(value => unique.has(value))) throw new Error('Duplicate staged unique key')
        rows.set(rowKey, JSON.parse(JSON.stringify(record.row)) as PortableRow)
        for (const value of keys) unique.add(value)
        for (const value of record.memberships) members.add(JSON.stringify([value.namespace, value.key]))
      })
    },
    count(table) {
      return promiseFromSync(() => {
        return [...rows.keys()].filter(value => (JSON.parse(value) as [string, number])[0] === table).length
      })
    },
    row(table, index) {
      return promiseFromSync(() => {
        maximumReturnedRows = Math.max(maximumReturnedRows, 1)
        return rows.get(JSON.stringify([table, index]))
      })
    },
    has(namespace, key) {
      return promiseFromSync(() => {
        const value = JSON.stringify([namespace, key])
        return unique.has(value) || members.has(value)
      })
    },
    seal(value) {
      return promiseFromSync(() => {
        header = value
        sealed++
      })
    },
    discard() {
      return promiseFromSync(() => {
        rows.clear()
        unique.clear()
        members.clear()
        discarded++
      })
    }
  }
  return {
    store,
    rows,
    get header() {
      return header
    },
    get sealed() {
      return sealed
    },
    get discarded() {
      return discarded
    },
    get maximumReturnedRows() {
      return maximumReturnedRows
    }
  }
}
export const options: Brc38SemanticStageOptions = {
  expectedIdentityKey: 'original-identity',
  expectedChain: 'test',
  expectedSourceStorageIdentityKey: 'original-source',
  maximumRows: 10000
}
export async function* source(data: BRC38WalletData) {
  const bytes = new TextEncoder().encode(JSON.stringify(data))
  for (let index = 0; index < bytes.length; index += 127) yield Promise.resolve(bytes.slice(index, index + 127))
}
export async function importToMemoryStage(data: BRC38WalletData, selected: Brc38SemanticStageOptions = options) {
  const state = memoryStageStore(),
    stage = new Brc38SemanticStage(state.store, selected)
  await readBrc38JsonStream(source(data), stage, {
    maximumArchiveBytes: 1048576,
    maximumRowAllocationBytes: 65536
  })
  return state
}
