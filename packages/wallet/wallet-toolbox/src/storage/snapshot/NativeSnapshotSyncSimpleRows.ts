import type { CertificateMergeRow } from '../schema/entities/EntityCertificate'
import { planCertificateMerge } from '../schema/entities/EntityCertificate'
import type { CertificateFieldMergeRow } from '../schema/entities/EntityCertificateField'
import { planCertificateFieldMerge } from '../schema/entities/EntityCertificateField'
import type { CommissionMergeRow } from '../schema/entities/EntityCommission'
import { planCommissionMerge } from '../schema/entities/EntityCommission'
import type { WalletSnapshotFieldDescriptor } from './WalletReadSnapshot'
import type { NativeSimplePayloadTable } from './writeNativeSnapshotSyncRowNode'

type Cell = string | Readonly<WalletSnapshotFieldDescriptor>
export type NativeSimplePayloadRow =
  | { readonly table: 'certificates'; readonly value: CertificateMergeRow<Cell> }
  | { readonly table: 'certificateFields'; readonly value: CertificateFieldMergeRow<Cell> }
  | { readonly table: 'commissions'; readonly value: CommissionMergeRow<Readonly<WalletSnapshotFieldDescriptor>, Cell> }
const metadataColumns = {
  certificates: [
    'created_at',
    'updated_at',
    'userId',
    'certificateId',
    'type',
    'certifier',
    'serialNumber',
    'isDeleted',
    'subject',
    'revocationOutpoint',
    'signature',
    'verifier'
  ],
  certificateFields: ['created_at', 'updated_at', 'userId', 'certificateId', 'fieldName', 'fieldValue', 'masterKey'],
  commissions: [
    'created_at',
    'updated_at',
    'userId',
    'commissionId',
    'transactionId',
    'isRedeemed',
    'satoshis',
    'keyOffset'
  ]
} as const
export const nativeSimplePayloadFields = {
  certificates: ['subject', 'revocationOutpoint', 'signature', 'verifier'],
  certificateFields: ['fieldValue', 'masterKey'],
  commissions: ['lockingScript', 'keyOffset']
} as const
function invalid(): never {
  throw new Error('Native simple payload row differs from its complete scalar/field form')
}
export function nativeSimplePositive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}
function archiveId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid()
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) invalid()
  return value
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(value))) invalid()
  return new Date(Date.prototype.getTime.call(value))
}
/** Complete policy forms use field DATA; they are never cast to complete Table
 * DTOs or passed to ordinary entity hooks with absent payloads. */
export function nativeSimplePayloadRow(
  table: NativeSimplePayloadTable,
  fields: Readonly<Record<string, unknown>>,
  extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>
): NativeSimplePayloadRow {
  return simplePayloadRow(table, fields, extents, nativeSimplePositive)
}
/** Separate archive DATA parser preserves signed/zero incoming identities. It
 * does not relax native source IDs or supply a complete wallet DTO surrogate. */
export function brc38ImportSimplePayloadRow(
  table: NativeSimplePayloadTable,
  fields: Readonly<Record<string, unknown>>,
  extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>
): NativeSimplePayloadRow {
  return simplePayloadRow(table, fields, extents, archiveId)
}
function simplePayloadRow(
  table: NativeSimplePayloadTable,
  fields: Readonly<Record<string, unknown>>,
  extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>,
  selectedId: (value: unknown) => number
): NativeSimplePayloadRow {
  if (
    Object.keys(fields).some(name => !metadataColumns[table].some(column => column === name)) ||
    Object.keys(extents).some(name => !nativeSimplePayloadFields[table].some(column => column === name))
  )
    invalid()
  const cell = (name: string): Cell => {
      const descriptor = extents[name]
      if (descriptor !== undefined) {
        if (descriptor.kind === 'binary' || Object.hasOwn(fields, name)) invalid()
        return descriptor
      }
      if (typeof fields[name] !== 'string') invalid()
      return fields[name]
    },
    common = {
      created_at: date(fields.created_at),
      updated_at: date(fields.updated_at),
      userId: selectedId(fields.userId)
    }
  switch (table) {
    case 'certificates':
      if (typeof fields.isDeleted !== 'boolean') invalid()
      return {
        table,
        value: {
          ...common,
          certificateId: selectedId(fields.certificateId),
          type: text(fields.type),
          certifier: text(fields.certifier),
          serialNumber: text(fields.serialNumber),
          isDeleted: fields.isDeleted,
          subject: cell('subject'),
          revocationOutpoint: cell('revocationOutpoint'),
          signature: cell('signature'),
          verifier: fields.verifier == null && extents.verifier === undefined ? undefined : cell('verifier')
        }
      }
    case 'certificateFields':
      return {
        table,
        value: {
          ...common,
          certificateId: selectedId(fields.certificateId),
          fieldName: text(fields.fieldName),
          fieldValue: cell('fieldValue'),
          masterKey: cell('masterKey')
        }
      }
    case 'commissions': {
      const script = extents.lockingScript
      if (
        script?.kind !== 'binary' ||
        typeof fields.isRedeemed !== 'boolean' ||
        typeof fields.satoshis !== 'number' ||
        !Number.isFinite(fields.satoshis)
      )
        invalid()
      return {
        table,
        value: {
          ...common,
          commissionId: selectedId(fields.commissionId),
          transactionId: selectedId(fields.transactionId),
          isRedeemed: fields.isRedeemed,
          satoshis: fields.satoshis,
          lockingScript: script,
          keyOffset: cell('keyOffset')
        }
      }
    }
  }
}
export function nativeSimplePayloadMerge(
  current: NativeSimplePayloadRow | undefined,
  incoming: NativeSimplePayloadRow,
  userId: number,
  parent?: number
): NativeSimplePayloadRow | undefined {
  if (current !== undefined && current.table !== incoming.table) invalid()
  switch (incoming.table) {
    case 'certificates': {
      const value =
        current === undefined
          ? { ...incoming.value, userId }
          : current.table === 'certificates'
            ? planCertificateMerge(current.value, incoming.value)
            : invalid()
      return value === undefined ? undefined : { table: incoming.table, value }
    }
    case 'certificateFields': {
      const value =
        current === undefined
          ? { ...incoming.value, userId, certificateId: nativeSimplePositive(parent) }
          : current.table === 'certificateFields'
            ? planCertificateFieldMerge(current.value, incoming.value)
            : invalid()
      return value === undefined ? undefined : { table: incoming.table, value }
    }
    case 'commissions': {
      const value =
        current === undefined
          ? { ...incoming.value, userId, transactionId: nativeSimplePositive(parent) }
          : current.table === 'commissions'
            ? planCommissionMerge(current.value, incoming.value)
            : invalid()
      return value === undefined ? undefined : { table: incoming.table, value }
    }
  }
}
/** Only logical scalar DATA is copied here. A descriptor stays separate from
 * the marker/pointer writer. Existing commission payloads remain unchanged. */
export function nativeSimplePayloadMetadata(
  selected: NativeSimplePayloadRow,
  existing: boolean
): Record<string, unknown> {
  const value = selected.value,
    common = { created_at: value.created_at, updated_at: value.updated_at, userId: value.userId }
  let fields: Record<string, unknown>
  switch (selected.table) {
    case 'certificates':
      fields = {
        ...common,
        certificateId: selected.value.certificateId,
        type: selected.value.type,
        certifier: selected.value.certifier,
        serialNumber: selected.value.serialNumber,
        isDeleted: selected.value.isDeleted
      }
      break
    case 'certificateFields':
      fields = { ...common, certificateId: selected.value.certificateId, fieldName: selected.value.fieldName }
      break
    case 'commissions':
      fields = {
        ...common,
        commissionId: selected.value.commissionId,
        transactionId: selected.value.transactionId,
        isRedeemed: selected.value.isRedeemed,
        satoshis: selected.value.satoshis
      }
      break
  }
  if (selected.table === 'commissions' && existing) return fields
  for (const [name, cell] of Object.entries(value))
    if (nativeSimplePayloadFields[selected.table].some(field => field === name)) {
      if (typeof cell === 'string' || cell === undefined) fields[name] = cell
    }
  return fields
}
