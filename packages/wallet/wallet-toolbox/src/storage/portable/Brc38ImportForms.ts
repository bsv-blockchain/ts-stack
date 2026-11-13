import type { Brc38StageTable } from './Brc38SemanticStage'
import type { SyncMap } from '../schema/entities/EntityBase'

/** Fixed portable dependency/identity definitions. These immutable source
 * constants grant no backend, source, schema, semantic or activation admission. */
export interface Brc38ImportParent {
  readonly entity: keyof SyncMap
  readonly field: string
  readonly optional?: boolean
}
export interface Brc38ImportRowForm {
  readonly kind: string
  readonly id?: string
  readonly entity?: keyof SyncMap
  readonly parents: readonly Brc38ImportParent[]
}
const forms: Readonly<Record<Brc38StageTable, Brc38ImportRowForm>> = {
  provenTxs: { kind: 'provenTx', id: 'provenTxId', entity: 'provenTx', parents: [] },
  outputBaskets: { kind: 'outputBasket', id: 'basketId', entity: 'outputBasket', parents: [] },
  outputTags: { kind: 'outputTag', id: 'outputTagId', entity: 'outputTag', parents: [] },
  txLabels: { kind: 'txLabel', id: 'txLabelId', entity: 'txLabel', parents: [] },
  transactions: {
    kind: 'transaction',
    id: 'transactionId',
    entity: 'transaction',
    parents: [{ entity: 'provenTx', field: 'provenTxId', optional: true }]
  },
  outputs: {
    kind: 'output',
    id: 'outputId',
    entity: 'output',
    parents: [
      { entity: 'transaction', field: 'transactionId' },
      { entity: 'transaction', field: 'spentBy', optional: true },
      { entity: 'outputBasket', field: 'basketId', optional: true }
    ]
  },
  txLabelMaps: {
    kind: 'txLabelMap',
    parents: [
      { entity: 'txLabel', field: 'txLabelId' },
      { entity: 'transaction', field: 'transactionId' }
    ]
  },
  outputTagMaps: {
    kind: 'outputTagMap',
    parents: [
      { entity: 'outputTag', field: 'outputTagId' },
      { entity: 'output', field: 'outputId' }
    ]
  },
  certificates: { kind: 'certificate', id: 'certificateId', entity: 'certificate', parents: [] },
  certificateFields: {
    kind: 'certificateField',
    parents: [{ entity: 'certificate', field: 'certificateId' }]
  },
  commissions: {
    kind: 'commission',
    id: 'commissionId',
    entity: 'commission',
    parents: [{ entity: 'transaction', field: 'transactionId' }]
  },
  provenTxReqs: {
    kind: 'provenTxReq',
    id: 'provenTxReqId',
    entity: 'provenTxReq',
    parents: [{ entity: 'provenTx', field: 'provenTxId', optional: true }]
  },
  syncStates: { kind: 'syncState', parents: [] }
}
/** Dependency order is the existing thirteen-table restore insert order, not
 * the input JSON property order or the semantic validation enumeration. */
export const brc38ImportTableOrder: readonly Brc38StageTable[] = Object.freeze(Object.keys(forms) as Brc38StageTable[])
for (const form of Object.values(forms)) {
  for (const parent of form.parents) Object.freeze(parent)
  Object.freeze(form.parents)
  Object.freeze(form)
}
Object.freeze(forms)
export function brc38ImportRowForm(table: Brc38StageTable): Readonly<Brc38ImportRowForm> {
  if (!Object.hasOwn(forms, table)) throw new Error('Bounded private import page is inconsistent or stale')
  return forms[table]
}
