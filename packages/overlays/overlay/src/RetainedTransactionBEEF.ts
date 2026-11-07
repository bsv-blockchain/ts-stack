import { Beef, Transaction, Utils } from '@bsv/sdk'

export interface RetainedBEEFConfiguration {
  maximumBytes: number
}
/** An explicit, owned public-evidence byte budget; absent means ordinary behavior. */
export function retainedBEEFConfiguration(
  input: RetainedBEEFConfiguration | undefined
): Readonly<RetainedBEEFConfiguration> | undefined {
  if (input === undefined) return undefined
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    input.maximumBytes > 4194304
  )
    throw new TypeError('Invalid retained BEEF byte limit')
  return Object.freeze({ maximumBytes: input.maximumBytes })
}
function read(input: number[] | Uint8Array, txid: string, limit: number): Beef {
  if (input.length > limit) throw new Error('Retained BEEF byte limit')
  const beef = Beef.fromBinary(Array.from(input))
  if ((beef.atomicTxid !== undefined && beef.atomicTxid !== txid) || !beef.findTxid(txid)?.tx)
    throw new Error('Retained BEEF subject differs from original raw transaction')
  return beef
}
function retainedHistory(beef: Beef, txid: string): Beef {
  const selected = new Beef(beef.version),
    pending = [txid],
    visited = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    const entry = beef.findTxid(id)
    if (entry === undefined) continue
    mergeHistoryEntry(beef, selected, entry, pending)
  }
  return selected
}
function mergeHistoryEntry(
  beef: Beef,
  selected: Beef,
  entry: NonNullable<ReturnType<Beef['findTxid']>>,
  pending: string[]
): void {
  const raw = entry.rawTx,
    bump = entry.bumpIndex === undefined ? undefined : beef.bumps[entry.bumpIndex]
  if (raw === undefined) {
    selected.mergeTxidOnly(entry.txid)
    return
  }
  selected.mergeRawTx(raw, bump === undefined ? undefined : selected.mergeBump(bump))
  // A current leaf proof does not erase older raw ancestry needed by topic
  // validation or GASP. Walk raw inputs even when the leaf has a BUMP.
  // Entries originate in the byte parser, whose raw inputs always have TXIDs.
  for (const input of entry.tx!.inputs) pending.push(input.sourceTXID!)
}
function serialize(beef: Beef, txid: string, limit: number): number[] {
  const selected = retainedHistory(beef, txid),
    writer = new Utils.Writer()
  // Ordinary SDK Atomic serialization intentionally stops at proven leaves.
  // This explicit history profile encodes the same BRC-95 header while retaining
  // available raw ancestors; unrelated transactions are excluded above.
  writer.writeUInt32LE(0x01010101)
  writer.write(Utils.toArray(txid, 'hex').reverse())
  writer.write(selected.toBinary())
  const result = writer.toArray()
  if (result.length > limit) throw new Error('Retained BEEF output byte limit')
  return result
}
/** Retain public input history with an explicit raw subject before publishing/admitting it. */
export function retainTransactionBEEF(
  input: number[] | Uint8Array,
  txid: string,
  configuration: RetainedBEEFConfiguration
): number[] {
  const limit = retainedBEEFConfiguration(configuration)!.maximumBytes
  return serialize(read(input, txid, limit), txid, limit)
}
/**
 * Rehydrate the same raw subject and retain its complete original public ancestry.
 * Attach a separately stored current leaf proof without substituting raw bytes.
 * This is serialization/binding only; the receiver still verifies Script, SPV,
 * selected chain/currentness and root policy through its installed evidence layer.
 */
export function hydrateRetainedTransactionBEEF(
  input: number[] | Uint8Array,
  txid: string,
  current: Transaction,
  configuration: RetainedBEEFConfiguration
): number[] {
  const limit = retainedBEEFConfiguration(configuration)!.maximumBytes,
    beef = read(input, txid, limit),
    subject = beef.findTxid(txid)!.tx!
  if (!Buffer.from(subject.toBinary()).equals(Buffer.from(current.toBinary())))
    throw new Error('Retained BEEF subject differs from original raw transaction')
  const bump = current.merklePath === undefined ? undefined : beef.mergeBump(current.merklePath)
  beef.mergeRawTx(current.toBinary(), bump)
  return serialize(beef, txid, limit)
}
