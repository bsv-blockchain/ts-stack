/** Fixed local prior-import DATA families. They are not archive table IDs and
 * their old receipts never admit a new import, profile, writer or activation. */
export const brc38NativePriorImportTables = Object.freeze([
  'brc38_import_journal',
  'brc38_import_ids',
  'brc38_import_original_budget',
  'brc38_import_original',
  'brc38_import_streamed_original_budget',
  'brc38_import_streamed_original',
  'brc38_import_structured_original_budget',
  'brc38_import_structured_original',
  'private_binary_fields',
  'private_binary_chunks',
  'private_text_fields',
  'private_text_chunks',
  'private_structured_fields',
  'private_structured_chunks',
  'private_canonical_structured_fields',
  'private_canonical_structured_chunks',
  'private_projected_structured_fields',
  'private_projected_structured_chunks'
] as const)
export type Brc38NativePriorImportTable = (typeof brc38NativePriorImportTables)[number]
export function brc38NativePriorImportPayload(
  table: Brc38NativePriorImportTable
): Readonly<{ field: 'originalJson' | 'payload'; kind: 'text' | 'blob'; maximumBytes: number }> | undefined {
  if (!brc38NativePriorImportTables.includes(table)) throw new TypeError('Invalid fixed prior-import table')
  if (
    table === 'brc38_import_original' ||
    table === 'brc38_import_streamed_original' ||
    table === 'brc38_import_structured_original'
  )
    return Object.freeze({ field: 'originalJson', kind: 'text', maximumBytes: 16777216 })
  if (
    table === 'private_binary_chunks' ||
    table === 'private_text_chunks' ||
    table === 'private_structured_chunks' ||
    table === 'private_canonical_structured_chunks' ||
    table === 'private_projected_structured_chunks'
  )
    return Object.freeze({ field: 'payload', kind: 'blob', maximumBytes: 65536 })
  return undefined
}
