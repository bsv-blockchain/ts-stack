import { Beef } from '@bsv/sdk'
import { StorageProvider } from '../StorageProvider'
import { ProvenOrRawTx, StorageGetBeefOptions } from '../../sdk/WalletStorage.interfaces'
import { EntityProvenTx } from '../schema/entities/EntityProvenTx'
import { WERR_INVALID_MERKLE_ROOT, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

/**
 * Creates a `Beef` to support the validity of a transaction identified by its `txid`.
 *
 * `storage` is used to retrieve proven transactions and their merkle paths,
 * or proven_tx_req record with beef of external inputs (internal inputs meged by recursion).
 * Otherwise external services are used.
 *
 * `options.maxRecursionDepth` can be set to prevent overly deep chained dependencies. Will throw ERR_EXTSVS_ENVELOPE_DEPTH if exceeded.
 *
 * If `trustSelf` is true, a partial `Beef` will be returned where transactions known by `storage` to
 * be valid by verified proof are represented solely by 'txid'.
 *
 * If `knownTxids` is defined, any 'txid' required by the `Beef` that appears in the array is represented solely as a 'known' txid.
 *
 * @param storage the chain on which txid exists.
 * @param txid the transaction hash for which an envelope is requested.
 * @param options
 */
export async function getBeefForTransaction (
  storage: StorageProvider,
  txid: string,
  options: StorageGetBeefOptions
): Promise<Beef> {
  const beef = options.mergeToBeef instanceof Beef
    ? options.mergeToBeef
    : options.mergeToBeef != null
      ? Beef.fromBinary(options.mergeToBeef)
      : new Beef()

  const knownTxids = new Set(options.knownTxids ?? [])
  const scheduled = new Set<string>([txid])
  let frontier: Array<{ txid: string, depth: number }> = [{ txid, depth: 0 }]
  const requestedConcurrency = options.maxConcurrency ?? 8
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(32, Math.floor(requestedConcurrency)))
    : 8

  while (frontier.length > 0) {
    const current = frontier.filter(item => beef.findTxid(item.txid) == null)
    const resolved = await mapWithConcurrency(current, concurrency, async item =>
      await resolveBeefForTransaction(storage, item.txid, options, knownTxids, item.depth)
    )

    const next: Array<{ txid: string, depth: number }> = []
    for (let i = 0; i < resolved.length; i++) {
      const result = resolved[i]
      beef.mergeBeef(result.beef)
      for (const dependency of result.dependencies) {
        if (!scheduled.has(dependency) && beef.findTxid(dependency) == null) {
          scheduled.add(dependency)
          next.push({ txid: dependency, depth: current[i].depth + 1 })
        }
      }
    }
    frontier = next
  }

  return beef
}

async function mapWithConcurrency<T, R> (
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await mapper(values[index])
    }
  }))
  return results
}

/**
 * @returns rawTx if txid known to network, if merkle proof available then also proven result is valid.
 */
async function getProvenOrRawTxFromServices (
  storage: StorageProvider,
  txid: string,
  options: StorageGetBeefOptions
): Promise<ProvenOrRawTx> {
  const por = await EntityProvenTx.fromTxid(txid, storage.getServices())
  if ((por.proven != null) && !options.ignoreStorage && !options.ignoreNewProven) {
    por.proven.provenTxId = await storage.insertProvenTx(por.proven.toApi())
  }
  return { proven: por.proven?.toApi(), rawTx: por.rawTx }
}

async function resolveBeefForTransaction (
  storage: StorageProvider,
  txid: string,
  options: StorageGetBeefOptions,
  knownTxids: Set<string>,
  recursionDepth: number
): Promise<{ beef: Beef, dependencies: string[] }> {
  const maxDepth = storage.maxRecursionDepth
  if (maxDepth && maxDepth <= recursionDepth) { throw new WERR_INVALID_OPERATION(`Maximum BEEF depth exceeded. Limit is ${storage.maxRecursionDepth}`) }

  const beef = new Beef()

  if (knownTxids.has(txid)) {
    // This txid is one of the txids the caller claims to already know are valid...
    beef.mergeTxidOnly(txid)
    return { beef, dependencies: [] }
  }

  if (!options.ignoreStorage) {
    // if we can use storage, ask storage if it has the txid
    const requiredLevels = options.minProofLevel === undefined ? undefined : options.minProofLevel + recursionDepth
    const knownBeef = await storage.getValidBeefForTxid(
      txid,
      beef,
      options.trustSelf,
      options.knownTxids,
      undefined,
      requiredLevels,
      options.chainTracker,
      options.skipInvalidProofs
    )
    if (knownBeef != null) return { beef: knownBeef, dependencies: [] }
  }

  if (options.ignoreServices) { throw new WERR_INVALID_PARAMETER(`txid ${txid}`, `valid transaction on chain ${storage.chain}`) }

  // if storage doesn't know about txid, use services
  // to find it and if it has a proof, remember it.
  const r = await getProvenOrRawTxFromServices(storage, txid, options)

  if ((r.proven != null) && options.minProofLevel !== undefined && options.minProofLevel > recursionDepth) {
    // ignore proof at this recursion depth
    r.proven = undefined
  }

  if (r.proven != null) {
    // storage has proven this txid,
    // merge both the raw transaction and its merkle path
    const mp = new EntityProvenTx(r.proven).getMerklePath()
    if (options.chainTracker != null) {
      const root = mp.computeRoot()
      const isValid = await options.chainTracker.isValidRootForHeight(root, r.proven.height)
      if (!isValid) {
        if (!options.skipInvalidProofs) {
          throw new WERR_INVALID_MERKLE_ROOT(r.proven.blockHash, r.proven.height, root, txid)
        }
        // ignore this currently invalid proof and try to recurse deeper
        r.proven = undefined
      }
    }
    if (r.proven != null) {
      beef.mergeRawTx(r.proven.rawTx)
      beef.mergeBump(mp)
      return { beef, dependencies: [] }
    }
  }

  if (r.rawTx == null) throw new WERR_INVALID_PARAMETER(`txid ${txid}`, `valid transaction on chain ${storage.chain}`)

  // merge the raw transaction and recurse over its inputs.
  const beefTx = beef.mergeRawTx(r.rawTx)
  return { beef, dependencies: beefTx.inputTxids }
}
