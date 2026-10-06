import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
export const EDGES = 'snapshot_global_edges'
export const KEYS = 'snapshot_global_keys'
export const GUARDS = 'snapshot_global_guards'
export const PROGRESS = 'snapshot_global_index_progress'
export const PAGE_ROWS = 256

type ColumnType = 'int' | 'uint' | 'biguint' | 'boolean'
interface Column {
  name: string
  type: ColumnType
}
export interface Index {
  name: string
  columns: string[]
}
export interface Table {
  name: string
  columns: Column[]
  primary: string[]
  indexes: Index[]
}
const columns = (names: string[], type: ColumnType): Column[] => names.map(name => ({ name, type }))
// Build descriptors when the migration runs, so construction failures belong to
// the awaited migration operation rather than module initialization.
export function tables(): Table[] {
  return [
    {
      name: GUARDS,
      columns: [...columns(['proofId'], 'uint'), ...columns(['present'], 'boolean')],
      primary: ['proofId'],
      indexes: []
    },
    {
      name: KEYS,
      columns: [
        ...columns(['tableId'], 'int'),
        ...columns(['userId', 'rowId'], 'uint'),
        ...columns(['refs'], 'biguint'),
        ...columns(['present'], 'boolean')
      ],
      primary: ['tableId', 'userId', 'rowId'],
      indexes: [
        {
          name: 'snapshot_global_page',
          columns: ['tableId', 'userId', 'present', 'rowId']
        },
        {
          name: 'snapshot_global_target',
          columns: ['tableId', 'rowId', 'userId']
        }
      ]
    },
    {
      name: EDGES,
      columns: [
        ...columns(['transactionId', 'requestId'], 'uint'),
        ...columns(['tableId'], 'int'),
        ...columns(['rowId', 'userId'], 'uint')
      ],
      primary: ['transactionId', 'requestId', 'tableId', 'rowId'],
      indexes: [
        {
          name: 'snapshot_global_request',
          columns: ['requestId', 'transactionId']
        }
      ]
    },
    {
      name: PROGRESS,
      columns: [...columns(['id'], 'int'), ...columns(['afterRowId'], 'uint'), ...columns(['complete'], 'boolean')],
      primary: ['id'],
      indexes: []
    }
  ]
}

export const mysql = (k: Knex): boolean => String(k.client.config.client).includes('mysql')
export const normalized = (sql: string): string => sql.replaceAll(/\s+/g, ' ').trim()
export function invalid(message: string): never {
  throw new WERR_INVALID_OPERATION(message)
}

export const sources = [
  {
    name: 'proven_txs',
    key: 'provenTxId',
    fields: [{ name: 'provenTxId', nullable: false, text: false }]
  },
  {
    name: 'proven_tx_reqs',
    key: 'provenTxReqId',
    fields: [
      { name: 'provenTxReqId', nullable: false, text: false },
      { name: 'provenTxId', nullable: true, text: false },
      { name: 'txid', nullable: false, text: true }
    ]
  },
  {
    name: 'transactions',
    key: 'transactionId',
    fields: [
      { name: 'transactionId', nullable: false, text: false },
      { name: 'userId', nullable: false, text: false },
      { name: 'provenTxId', nullable: true, text: false },
      { name: 'txid', nullable: true, text: true }
    ]
  }
]
export type SourceDefinition = (typeof sources)[number]
export type SourceField = SourceDefinition['fields'][number]
