import { findProofRecords, mapProofWork } from './proofWork'
import { Beef, MerklePath } from '@bsv/sdk'
import { WERR_INVALID_MERKLE_ROOT } from '../../sdk/WERR_errors'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import type { StorageProvider } from '../StorageProvider'
import type { TableProvenTx } from '../schema/tables'
import { refreshSyncProof } from './refreshSyncProof'
import { validateSyncProof } from './validateSyncProof'

/**
 * Validate the assembled graph, including cached and embedded ancestry. Only a
 * stale root triggers canonical recovery. Never change transaction bytes or
 * treat provider absence as a successful proof. The common valid path neither
 * copies the graph nor reads proof records from storage.
 */
export async function repairBeefProofs(storage: StorageProvider, beef: Beef, trx?: TrxToken): Promise<Beef> {
  if (beef.bumps.length === 0) return beef
  const services = storage.getServices()
  const tracker = await services.getChainTracker()
  const roots = new Map<string, { root: string; height: number }>()
  for (const bump of beef.bumps) {
    const root = bump.computeRoot()
    roots.set(`${bump.blockHeight}:${root}`, { root, height: bump.blockHeight })
  }
  const checks = await mapProofWork(
    [...roots.entries()],
    async ([key, { root, height }]) => [key, (await tracker.isValidRootForHeight(root, height)) === true] as const
  )
  const valid = new Map(checks)
  const stale = new Set(beef.bumps.filter(bump => !valid.get(`${bump.blockHeight}:${bump.computeRoot()}`)))
  if (stale.size === 0) return beef

  const affected = beef.txs.filter(tx => tx.bumpIndex != null && stale.has(beef.bumps[tx.bumpIndex]))
  const records = await findProofRecords(
    storage,
    affected.map(tx => tx.txid),
    trx
  )
  const existing = new Map(records.map(record => [record.txid, record]))
  const replacements = await mapProofWork(affected, async tx => {
    const oldPath = beef.bumps[tx.bumpIndex!]
    const record = existing.get(tx.txid)
    if (record != null) {
      try {
        // Another request may already have repaired the shared proof row.
        await validateSyncProof(storage, record)
        return { proof: record }
      } catch {
        // Recovery still requires full validation of fresh canonical evidence.
      }
    }
    const candidate: TableProvenTx = {
      provenTxId: record?.provenTxId ?? 0,
      created_at: record?.created_at ?? new Date(0),
      updated_at: record?.updated_at ?? new Date(0),
      txid: tx.txid,
      rawTx: tx.rawTx ?? [],
      height: oldPath.blockHeight,
      merklePath: oldPath.toBinary(),
      merkleRoot: oldPath.computeRoot(tx.txid),
      blockHash: record?.blockHash ?? '00'.repeat(32),
      index: oldPath.path[0].find(leaf => leaf.hash === tx.txid)?.offset ?? -1
    }
    try {
      return { proof: await refreshSyncProof(storage, candidate), expected: record }
    } catch {
      const error = new WERR_INVALID_MERKLE_ROOT(candidate.blockHash, candidate.height, candidate.merkleRoot, tx.txid)
      error.message +=
        ' A current canonical proof could not be verified. Retry after the proof provider recovers; no transaction was broadcast by proof recovery.'
      throw error
    }
  })

  // Construct independently: failed recovery must not leave a half-edited BEEF.
  const repaired = new Beef(beef.version)
  for (const tx of beef.txs) {
    const bytes = tx.rawTxUint8Array
    if (bytes == null) repaired.mergeTxidOnly(tx.txid)
    else repaired.mergeRawTx(bytes)
  }
  for (const bump of beef.bumps) if (!stale.has(bump)) repaired.mergeBump(bump)
  for (const { proof } of replacements) repaired.mergeBump(MerklePath.fromBinary(proof.merklePath))

  // Persistence is optional for custom providers. Built-ins compare all proof
  // authority fields atomically, so delayed I/O cannot overwrite a newer proof.
  if (replacements.some(result => result.expected != null)) {
    await storage.transaction(async trx => {
      let changed = false
      for (const { proof, expected } of replacements) {
        if (expected != null) changed = (await storage.compareAndSetProvenTxProof(expected, proof, trx)) || changed
      }
      const extension = storage as StorageProvider & { invalidatePreparedBeefs?: (trx?: TrxToken) => Promise<number> }
      if (changed) await extension.invalidatePreparedBeefs?.(trx)
    }, trx)
  }
  return repaired
}
