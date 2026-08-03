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
export async function getBeefForTransaction(
  storage: StorageProvider,
  txid: string,
  options: StorageGetBeefOptions
): Promise<Beef> {
  let beef: Beef
  if (options.mergeToBeef instanceof Beef) {
    beef = options.mergeToBeef
  } else if (options.mergeToBeef != null) {
    beef = Beef.fromBinary(options.mergeToBeef)
  } else {
    beef = new Beef()
  }

  // Most createAction proof requests resolve a single, already-proven root.
  // Building a Set for a wallet's entire known-txid history made that common
  // path O(history) before storage did any useful work. Use array membership
  // for the first few lookups and promote to a Set only for a broad ancestor
  // traversal where the construction cost is recovered.
  const hasKnownTxid = makeKnownTxidLookup(options.knownTxids ?? [])
  const scheduled = new Set<string>([txid])
  let frontier: Array<{ txid: string; depth: number }> = [{ txid, depth: 0 }]
  const requestedConcurrency = options.maxConcurrency ?? 8
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(32, Math.floor(requestedConcurrency)))
    : 8

  while (frontier.length > 0) {
    const current = frontier.filter(item => beef.findTxid(item.txid) == null)
    const resolved = await mapWithConcurrency(
      current,
      concurrency,
      async item => await resolveBeefForTransaction(storage, item.txid, options, hasKnownTxid, item.depth)
    )

    const next: Array<{ txid: string; depth: number }> = []
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

function makeKnownTxidLookup (knownTxids: string[]): (txid: string) => boolean {
  let lookups = 0
  let indexed: Set<string> | undefined
  return txid => {
    lookups++
    if (indexed != null) return indexed.has(txid)
    if (knownTxids.length > 64 && lookups > 4) {
      indexed = new Set(knownTxids)
      return indexed.has(txid)
    }
    return knownTxids.includes(txid)
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = Array.from({ length: values.length }, () => undefined as R)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++
        results[index] = await mapper(values[index])
      }
    })
  )
  return results
}

/**
 * @returns rawTx if txid known to network, if merkle proof available then also proven result is valid.
 */
async function getProvenOrRawTxFromServices(
  storage: StorageProvider,
  txid: string,
  options: StorageGetBeefOptions
): Promise<ProvenOrRawTx> {
  const por = await EntityProvenTx.fromTxid(txid, storage.getServices())
  if (por.proven != null && !options.ignoreStorage && !options.ignoreNewProven) {
    por.proven.provenTxId = await storage.insertProvenTx(por.proven.toApi())
  }
  return { proven: por.proven?.toApi(), rawTx: por.rawTx }
}

async function getStoredBeef(
  storage: StorageProvider,
  txid: string,
  options: StorageGetBeefOptions,
  recursionDepth: number
): Promise<Beef | undefined> {
  if (options.ignoreStorage) return undefined

  const requiredLevels = options.minProofLevel === undefined ? undefined : options.minProofLevel + recursionDepth
  return await storage.getValidBeefForTxid(
    txid,
    new Beef(),
    options.trustSelf,
    options.knownTxids,
    undefined,
    requiredLevels,
    options.chainTracker,
    options.skipInvalidProofs
  )
}

async function mergeUsableProvenTransaction(
  beef: Beef,
  txid: string,
  result: ProvenOrRawTx,
  options: StorageGetBeefOptions,
  recursionDepth: number
): Promise<Beef | undefined> {
  const proven = result.proven
  if (proven == null) return undefined
  if (options.minProofLevel !== undefined && options.minProofLevel > recursionDepth) return undefined

  const merklePath = new EntityProvenTx(proven).getMerklePath()
  if (options.chainTracker != null) {
    const root = merklePath.computeRoot()
    const isValid = await options.chainTracker.isValidRootForHeight(root, proven.height)
    if (!isValid) {
      if (!options.skipInvalidProofs) {
        throw new WERR_INVALID_MERKLE_ROOT(proven.blockHash, proven.height, root, txid)
      }
      return undefined
    }
  }

  beef.mergeRawTx(proven.rawTx)
  beef.mergeBump(merklePath)
  return beef
}

async function resolveBeefForTransaction(
  storage: StorageProvider,
  txid: string,
  options: StorageGetBeefOptions,
  hasKnownTxid: (txid: string) => boolean,
  recursionDepth: number
): Promise<{ beef: Beef; dependencies: string[] }> {
  const maxDepth = storage.maxRecursionDepth
  if (maxDepth && maxDepth <= recursionDepth) {
    throw new WERR_INVALID_OPERATION(`Maximum BEEF depth exceeded. Limit is ${storage.maxRecursionDepth}`)
  }

  const beef = new Beef()

  if (hasKnownTxid(txid)) {
    // This txid is one of the txids the caller claims to already know are valid...
    beef.mergeTxidOnly(txid)
    return { beef, dependencies: [] }
  }

  const storedBeef = await getStoredBeef(storage, txid, options, recursionDepth)
  if (storedBeef != null) return { beef: storedBeef, dependencies: [] }

  if (options.ignoreServices) {
    throw new WERR_INVALID_PARAMETER(`txid ${txid}`, `valid transaction on chain ${storage.chain}`)
  }

  // if storage doesn't know about txid, use services
  // to find it and if it has a proof, remember it.
  const result = await getProvenOrRawTxFromServices(storage, txid, options)
  const provenBeef = await mergeUsableProvenTransaction(beef, txid, result, options, recursionDepth)
  if (provenBeef != null) return { beef: provenBeef, dependencies: [] }

  if (result.rawTx == null)
    throw new WERR_INVALID_PARAMETER(`txid ${txid}`, `valid transaction on chain ${storage.chain}`)

  // merge the raw transaction and recurse over its inputs.
  const beefTx = beef.mergeRawTx(result.rawTx)
  return { beef, dependencies: beefTx.inputTxids }
}
