import { toArray } from '@bsv/sdk/primitives/utils'
/** Internal field contract shared by legacy materialized and private staged imports.
 * Extraction preserves existing accepted values and error identities. */
export type JsonPrimitive = string | number | boolean
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type PortableRow = Record<string, JsonValue>

export const binaryFieldsByKind: Partial<Record<string, string[]>> = {
  commission: ['lockingScript'],
  output: ['lockingScript'],
  provenTx: ['merklePath', 'rawTx'],
  provenTxReq: ['rawTx', 'inputBEEF'],
  transaction: ['inputBEEF', 'rawTx']
}

export const jsonFieldsByKind: Partial<Record<string, string[]>> = {
  provenTxReq: ['history', 'notify'],
  syncState: ['syncMap', 'errorLocal', 'errorOther']
}

export const dateFieldsByKind: Partial<Record<string, string[]>> = {
  settings: ['created_at', 'updated_at'],
  user: ['created_at', 'updated_at'],
  provenTx: ['created_at', 'updated_at'],
  provenTxReq: ['created_at', 'updated_at'],
  outputBasket: ['created_at', 'updated_at'],
  transaction: ['created_at', 'updated_at'],
  commission: ['created_at', 'updated_at'],
  output: ['created_at', 'updated_at'],
  outputTag: ['created_at', 'updated_at'],
  outputTagMap: ['created_at', 'updated_at'],
  txLabel: ['created_at', 'updated_at'],
  txLabelMap: ['created_at', 'updated_at'],
  certificate: ['created_at', 'updated_at'],
  certificateField: ['created_at', 'updated_at'],
  syncState: ['created_at', 'updated_at', 'when']
}

export function validatePortableRows(kind: string, rows: PortableRow[], path: string): void {
  const dateFields = new Set(dateFieldsByKind[kind] ?? [])
  const binaryFields = new Set(binaryFieldsByKind[kind] ?? [])
  const jsonFields = new Set(jsonFieldsByKind[kind] ?? [])
  for (const [index, row] of rows.entries()) {
    validatePortableRow(row, `${path}[${index}]`, dateFields, binaryFields, jsonFields)
  }
}

function validatePortableRow(
  row: PortableRow,
  rowPath: string,
  dateFields: Set<string>,
  binaryFields: Set<string>,
  jsonFields: Set<string>
): void {
  if (!isObject(row)) throw new Error(`BRC-38 ${rowPath} must be an object`)
  for (const field of dateFields) {
    if (field in row) assertIsoDate(row[field], `${rowPath}.${field}`)
  }
  for (const field of binaryFields) {
    if (field in row) assertBase64(row[field], `${rowPath}.${field}`)
  }
  for (const field of jsonFields) {
    if (field in row && !isObject(row[field])) throw new Error(`BRC-38 ${rowPath}.${field} must be an object`)
  }
}

export function requireNumber(value: unknown, path: string): number {
  if (!Number.isInteger(value)) throw new Error(`BRC-38 ${path} must be an integer`)
  return value as number
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`BRC-38 ${path} must be a string`)
  return value
}

export function assertIsoDate(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`BRC-38 ${path} must be a UTC ISO timestamp`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new Error(`BRC-38 ${path} is invalid`)
}

export function assertBase64(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`BRC-38 ${path} must be padded base64`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function decodePortableRow<T>(kind: string, row: PortableRow): T {
  const out: Record<string, unknown> = {}
  const dateFields = new Set(dateFieldsByKind[kind] ?? [])
  const binaryFields = new Set(binaryFieldsByKind[kind] ?? [])
  const jsonFields = new Set(jsonFieldsByKind[kind] ?? [])
  for (const [key, value] of Object.entries(row)) {
    if (dateFields.has(key)) out[key] = new Date(value as string)
    else if (binaryFields.has(key)) out[key] = toArray(value, 'base64')
    else if (jsonFields.has(key)) out[key] = JSON.stringify(value)
    else out[key] = value
  }
  return out as T
}
