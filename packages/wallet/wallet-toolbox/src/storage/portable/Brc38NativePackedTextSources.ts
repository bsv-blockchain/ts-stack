/** Immutable unpublished private-layout coordinates only. Each operation still
 * inspects its actual original native producer, complete schema and current
 * profile/row. C raw-cell coordinates and independent fixtures remain separate.
 * Certificate fields use their actual SQLite rowid, not a fabricated entity ID. */
export const nativePackedTextSources = [
  {
    id: 0,
    table: 'transactions',
    sql: 'transactions',
    key: 'transactionId',
    first: 3,
    fields: ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix']
  },
  {
    id: 2,
    table: 'provenTxReqs',
    sql: 'proven_tx_reqs',
    key: 'provenTxReqId',
    first: 2,
    fields: ['history', 'notify']
  },
  {
    id: 3,
    table: 'outputs',
    sql: 'outputs',
    key: 'outputId',
    first: 1,
    fields: [
      'outputDescription',
      'spendingDescription',
      'customInstructions',
      'derivationPrefix',
      'derivationSuffix',
      'type',
      'purpose'
    ]
  },
  { id: 4, table: 'commissions', sql: 'commissions', key: 'commissionId', first: 1, fields: ['keyOffset'] },
  {
    id: 5,
    table: 'syncStates',
    sql: 'sync_states',
    key: 'syncStateId',
    first: 0,
    fields: ['syncMap', 'errorLocal', 'errorOther']
  },
  {
    id: 6,
    table: 'certificates',
    sql: 'certificates',
    key: 'certificateId',
    first: 0,
    fields: ['subject', 'revocationOutpoint', 'signature', 'verifier']
  },
  {
    id: 7,
    table: 'certificateFields',
    sql: 'certificate_fields',
    key: 'rowid',
    first: 0,
    fields: ['fieldValue', 'masterKey']
  }
] as const
for (const source of nativePackedTextSources) {
  Object.freeze(source.fields)
  Object.freeze(source)
}
Object.freeze(nativePackedTextSources)
export function nativePackedTextSource(table: string) {
  const source = nativePackedTextSources.find(value => value.table === table || value.sql === table)
  if (source === undefined) throw new TypeError('Unknown native packed TEXT table')
  return source
}
