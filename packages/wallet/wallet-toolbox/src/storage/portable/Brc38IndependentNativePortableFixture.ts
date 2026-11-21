import type { BRC38WalletData } from './index'
import type { JsonValue, PortableRow } from './Brc38PortableRows'
import type { IndependentLocalCandidateRow } from './Brc38PrivateLocalCandidateNode.case'
import type { IndependentNativeInventory } from './Brc38IndependentNativeInventoryFixture'

// Independent format vocabulary; no production exporter, field whitelist,
// row projection, source header or archive parser creates this oracle.
const forms = [
  ['provenTxs', 'proven_txs', []],
  // Independent physical SQL preimage preserves the historical export getter's
  // numeric optional flag, rather than the separate typed finder's boolean.
  ['provenTxReqs', 'proven_tx_reqs', ['notified']],
  ['outputBaskets', 'output_baskets', ['isDeleted']],
  ['transactions', 'transactions', ['isOutgoing']],
  ['commissions', 'commissions', ['isRedeemed']],
  ['outputs', 'outputs', ['spendable', 'change']],
  ['outputTags', 'output_tags', ['isDeleted']],
  ['outputTagMaps', 'output_tags_map', ['isDeleted']],
  ['txLabels', 'tx_labels', ['isDeleted']],
  ['txLabelMaps', 'tx_labels_map', ['isDeleted']],
  ['certificates', 'certificates', ['isDeleted']],
  ['certificateFields', 'certificate_fields', []],
  ['syncStates', 'sync_states', ['init']]
] as const
const binary: Readonly<Record<string, readonly string[]>> = {
  proven_txs: ['rawTx', 'merklePath'],
  proven_tx_reqs: ['rawTx', 'inputBEEF'],
  transactions: ['rawTx', 'inputBEEF'],
  outputs: ['lockingScript'],
  commissions: ['lockingScript']
}
const structured: Readonly<Record<string, readonly string[]>> = {
  proven_tx_reqs: ['history', 'notify'],
  sync_states: ['syncMap', 'errorLocal', 'errorOther']
}
function integer(value: bigint): number {
  if (value < -9007199254740991n || value > 9007199254740991n)
    throw new Error('Independent native portable fixture integer exceeds its admitted format')
  return Number(value)
}
function row(table: string, original: IndependentLocalCandidateRow, booleans: readonly string[]): PortableRow {
  const result: PortableRow = {}
  for (const [name, cell] of Object.entries(original.metadata)) {
    if (booleans.includes(name)) {
      result[name] = cell !== null && cell !== false && cell !== 0 && cell !== 0n
      continue
    }
    if (cell === null) continue
    if (name === 'created_at' || name === 'updated_at' || (table === 'sync_states' && name === 'when')) {
      const date = new Date(typeof cell === 'bigint' ? integer(cell) : (cell as number | string))
      if (!Number.isFinite(date.getTime())) throw new Error('Independent native portable fixture date differs')
      result[name] = date.toISOString()
    } else if (typeof cell === 'bigint') result[name] = integer(cell)
    else if (
      (typeof cell === 'number' && Number.isFinite(cell)) ||
      typeof cell === 'string' ||
      typeof cell === 'boolean'
    )
      result[name] = cell
    else throw new Error('Independent native portable fixture metadata is not an admitted scalar')
  }
  for (const [name, bytes] of Object.entries(original.fields)) {
    if (bytes === null) continue
    if (binary[table]?.includes(name)) result[name] = Buffer.from(bytes).toString('base64')
    else if (structured[table]?.includes(name))
      result[name] = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as JsonValue
    else if (table === 'transactions' && name === 'noSendExpiryReclaimRawTx') result[name] = [...bytes]
    else result[name] = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  return result
}

/** Complete typed source preimage captured through separate finite physical
 * SQL/packed-byte reads before the exporter opens any source. This small
 * synthetic oracle does not establish streaming memory or physical quota. */
export function independentNativePortableFixture(
  inventory: IndependentNativeInventory,
  exportedAt: string
): BRC38WalletData {
  if (
    inventory.settings.length !== 1 ||
    inventory.users.length !== 1 ||
    new Date(exportedAt).toISOString() !== exportedAt
  )
    throw new Error('Independent portable fixture requires its one original profile')
  const tables = {} as BRC38WalletData['tables']
  for (const [portable, physical, booleans] of forms) {
    if (inventory[physical].length < 1 || inventory[physical].length > 2)
      throw new Error('Independent complete portable fixture exceeded its original small table bound')
    tables[portable] = inventory[physical].map(original => row(physical, original, booleans))
  }
  return {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt,
    sourceStorage: row('settings', inventory.settings[0], []),
    user: row('users', inventory.users[0], []),
    tables
  }
}
