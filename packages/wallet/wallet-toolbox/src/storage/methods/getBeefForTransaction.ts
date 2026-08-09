import { Beef } from '@bsv/sdk'
import { StorageProvider } from '../StorageProvider'
import { ProvenOrRawTx, StorageGetBeefOptions } from '../../sdk/WalletStorage.interfaces'
import { EntityProvenTx } from '../schema/entities/EntityProvenTx'
import { WERR_INVALID_MERKLE_ROOT, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

interface BeefFrontierItem {
  txid: string
  depth: number
}

interface ProvenBeefEntry {
  rawTx: number[]
  merklePath: ReturnType<EntityProvenTx['getMerklePath']>
  merkleRoot: string
}

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
  const beef = mergeTarget(options)

  // Most createAction proof requests resolve a single, already-proven root.
  // Building a Set for a wallet's entire known-txid history made that common
  // path O(history) before storage did any useful work. Use array membership
  // for the first few lookups and promote to a Set only for a broad ancestor
  // traversal where the construction cost is recovered.
  const hasKnownTxid = makeKnownTxidLookup(options.knownTxids ?? [])
  const scheduled = new Set<string>([txid])
  let frontier: Array<{ txid: string; depth: number }> = [{ txid, depth: 0 }]
  const concurrency = normalizeConcurrency(options.maxConcurrency)

  while (frontier.length > 0) {
    const current = frontier.filter(item => needsResolution(beef, item.txid, hasKnownTxid))
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
        if (!scheduled.has(dependency) && needsResolution(beef, dependency, hasKnownTxid)) {
          scheduled.add(dependency)
          next.push({ txid: dependency, depth: current[i].depth + 1 })
        }
      }
    }
    frontier = next
  }

  return beef
}

/**
 * Build one aggregate BEEF for several roots while resolving each storage
 * frontier as a set. This avoids one proof query per funding input on the
 * createAction success path. Complex proof-level and chain-tracker policies
 * retain the established single-root implementation.
 */
export async function getBeefForTransactions(
  storage: StorageProvider,
  txids: string[],
  options: StorageGetBeefOptions
): Promise<Beef> {
  const beef = mergeTarget(options)
  const roots = [...new Set(txids)]
  if (roots.length === 0) return beef
  if (requiresSingleRootPolicy(options)) return await mergeSingleRootFragments(storage, roots, options, beef)

  const hasKnownTxid = makeKnownTxidLookup(options.knownTxids ?? [])
  const scheduled = new Set<string>(roots)
  let frontier: BeefFrontierItem[] = roots.map(txid => ({ txid, depth: 0 }))

  while (frontier.length > 0) {
    const unresolved = collectUnresolvedFrontier(storage, frontier, beef, hasKnownTxid)
    if (unresolved.length === 0) break

    const stored = await storage.getProvenOrRawTxs(unresolved.map(item => item.txid))
    const allProven = options.trustSelf !== 'known' && unresolved.every(item => stored.get(item.txid)?.proven != null)
    if (allProven) {
      mergeAllProven(storage, beef, unresolved, stored)
      break
    }

    const [next, missing] = mergeStoredFrontier(beef, unresolved, stored, options, scheduled, hasKnownTxid)
    await mergeMissingFragments(storage, beef, missing, options)
    frontier = next
  }

  return beef
}

function mergeTarget(options: StorageGetBeefOptions): Beef {
  if (options.mergeToBeef instanceof Beef) return options.mergeToBeef
  if (options.mergeToBeef != null) return Beef.fromBinary(options.mergeToBeef)
  return new Beef()
}

function requiresSingleRootPolicy(options: StorageGetBeefOptions): boolean {
  return options.ignoreStorage === true ||
    options.minProofLevel !== undefined ||
    options.chainTracker != null ||
    options.skipInvalidProofs === true
}

async function mergeSingleRootFragments(
  storage: StorageProvider,
  roots: string[],
  options: StorageGetBeefOptions,
  beef: Beef
): Promise<Beef> {
  const fragments = await mapWithConcurrency(
    roots.filter(txid => beef.findTxid(txid) == null),
    normalizeConcurrency(options.maxConcurrency),
    async txid => await getBeefForTransaction(storage, txid, { ...options, mergeToBeef: undefined })
  )
  for (const fragment of fragments) beef.mergeBeef(fragment)
  return beef
}

function collectUnresolvedFrontier(
  storage: StorageProvider,
  frontier: BeefFrontierItem[],
  beef: Beef,
  hasKnownTxid: (txid: string) => boolean
): BeefFrontierItem[] {
  const unresolved: BeefFrontierItem[] = []
  for (const item of frontier) {
    if (!needsResolution(beef, item.txid, hasKnownTxid)) continue
    if (storage.maxRecursionDepth && storage.maxRecursionDepth <= item.depth) {
      throw new WERR_INVALID_OPERATION(`Maximum BEEF depth exceeded. Limit is ${storage.maxRecursionDepth}`)
    }
    if (hasKnownTxid(item.txid)) beef.mergeTxidOnly(item.txid)
    else unresolved.push(item)
  }
  return unresolved
}

function decodeProvenEntries(
  storage: StorageProvider,
  unresolved: BeefFrontierItem[],
  stored: Map<string, ProvenOrRawTx>
): ProvenBeefEntry[] {
  const span = storage.telemetry.enabled
    ? storage.telemetry.startSpan('wallet.storage.beef.decode_proven_batch', {
      component: 'wallet-storage',
      attributes: { 'beef.proven_tx_count': unresolved.length }
    })
    : undefined
  try {
    const entries = unresolved.map(item => {
      const proven = stored.get(item.txid)!.proven!
      return {
        rawTx: proven.rawTx,
        merklePath: new EntityProvenTx(proven).getMerklePath(false),
        merkleRoot: proven.merkleRoot
      }
    })
    span?.end({ attributes: { 'beef.decoded_proof_count': entries.length } })
    return entries
  } catch (error) {
    span?.end({ status: 'error', error })
    throw error
  }
}

function mergeAllProven(
  storage: StorageProvider,
  beef: Beef,
  unresolved: BeefFrontierItem[],
  stored: Map<string, ProvenOrRawTx>
): void {
  const entries = decodeProvenEntries(storage, unresolved, stored)
  const span = storage.telemetry.enabled
    ? storage.telemetry.startSpan('wallet.storage.beef.merge_proven_batch', {
      component: 'wallet-storage',
      attributes: { 'beef.proven_tx_count': entries.length }
    })
    : undefined
  try {
    mergeProvenEntries(beef, entries, unresolved, stored)
    span?.end({
      attributes: {
        'beef.merged_tx_count': entries.length,
        'beef.result_tx_count': beef.txs.length,
        'beef.result_bump_count': beef.bumps.length
      }
    })
  } catch (error) {
    span?.end({ status: 'error', error })
    throw error
  }
}

function mergeProvenEntries(
  beef: Beef,
  entries: ProvenBeefEntry[],
  unresolved: BeefFrontierItem[],
  stored: Map<string, ProvenOrRawTx>
): void {
  if (typeof beef.mergeProvenTxs === 'function') {
    beef.mergeProvenTxs(entries)
    return
  }
  // Runtime compatibility for applications that intentionally retain an older
  // compatible SDK peer. Current peers use the bulk lane; older peers retain
  // the established validated sequential behavior.
  for (const item of unresolved) {
    const proven = stored.get(item.txid)!.proven!
    beef.mergeRawTx(proven.rawTx)
    beef.mergeBump(new EntityProvenTx(proven).getMerklePath())
  }
}

function mergeStoredFrontier(
  beef: Beef,
  unresolved: BeefFrontierItem[],
  stored: Map<string, ProvenOrRawTx>,
  options: StorageGetBeefOptions,
  scheduled: Set<string>,
  hasKnownTxid: (txid: string) => boolean
): [next: BeefFrontierItem[], missing: BeefFrontierItem[]] {
  const next: BeefFrontierItem[] = []
  const missing: BeefFrontierItem[] = []
  for (const item of unresolved) {
    const result = stored.get(item.txid)
    if (result?.proven != null) mergeStoredProven(beef, item, result, options)
    else if (result?.rawTx != null) mergeStoredRaw(beef, item, result, options, scheduled, next, hasKnownTxid)
    else missing.push(item)
  }
  return [next, missing]
}

function mergeStoredProven(
  beef: Beef,
  item: BeefFrontierItem,
  result: ProvenOrRawTx,
  options: StorageGetBeefOptions
): void {
  if (options.trustSelf === 'known') {
    beef.mergeTxidOnly(item.txid)
    return
  }
  const proven = result.proven!
  beef.mergeRawTx(proven.rawTx)
  beef.mergeBump(new EntityProvenTx(proven).getMerklePath())
}

function mergeStoredRaw(
  beef: Beef,
  item: BeefFrontierItem,
  result: ProvenOrRawTx,
  options: StorageGetBeefOptions,
  scheduled: Set<string>,
  next: BeefFrontierItem[],
  hasKnownTxid: (txid: string) => boolean
): void {
  if (options.trustSelf === 'known') {
    beef.mergeTxidOnly(item.txid)
    return
  }
  const transaction = beef.mergeRawTx(result.rawTx!)
  if (result.inputBEEF != null) beef.mergeBeef(result.inputBEEF)
  appendNewDependencies(transaction.inputTxids, item.depth + 1, beef, scheduled, next, hasKnownTxid)
}

function appendNewDependencies(
  dependencies: string[],
  depth: number,
  beef: Beef,
  scheduled: Set<string>,
  next: BeefFrontierItem[],
  hasKnownTxid: (txid: string) => boolean
): void {
  for (const txid of dependencies) {
    if (scheduled.has(txid) || !needsResolution(beef, txid, hasKnownTxid)) continue
    scheduled.add(txid)
    next.push({ txid, depth })
  }
}

function needsResolution(
  beef: Beef,
  txid: string,
  hasKnownTxid: (txid: string) => boolean
): boolean {
  const entry = beef.findTxid(txid)
  return entry == null || (entry.isTxidOnly && !hasKnownTxid(txid))
}

async function mergeMissingFragments(
  storage: StorageProvider,
  beef: Beef,
  missing: BeefFrontierItem[],
  options: StorageGetBeefOptions
): Promise<void> {
  if (missing.length === 0) return
  if (options.ignoreServices === true) {
    throw new WERR_INVALID_PARAMETER(`txid ${missing[0].txid}`, `valid transaction on chain ${storage.chain}`)
  }
  const fragments = await mapWithConcurrency(
    missing,
    normalizeConcurrency(options.maxConcurrency),
    async item => await getBeefForTransaction(storage, item.txid, {
      ...options,
      ignoreStorage: true,
      mergeToBeef: undefined
    })
  )
  for (const fragment of fragments) beef.mergeBeef(fragment)
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

function normalizeConcurrency(value: number | undefined = 8): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(32, Math.floor(value)))
    : 8
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
