import { GetMerklePathResult, WalletServices } from '../../../sdk/WalletServices.interfaces'
import { TrxToken } from '../../../sdk/WalletStorage.interfaces'
import { arraysEqual, doubleSha256BE, verifyId, verifyOneOrNone } from '../../../utility/utilityHelpers'
import { asString } from '../../../utility/utilityHelpers.noBuffer'
import { TableProvenTx } from '../tables/TableProvenTx'
import { EntityBase, EntityStorage, SyncMap } from './EntityBase'
import { MerklePath, Transaction } from '@bsv/sdk'
import { EntityProvenTxReq } from './EntityProvenTxReq'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER, WERR_MISSING_PARAMETER } from '../../../sdk/WERR_errors'
import { WalletError } from '../../../sdk/WalletError'

export class EntityProvenTx extends EntityBase<TableProvenTx> {
  private static invalidSyncProof(message: string): never {
    throw new WERR_INVALID_PARAMETER('provenTx', `a server-verified proof. ${message}`)
  }

  /**
   * `proven_txs` is global and txid-unique, while sync callers are merely
   * authenticated tenants. Never let a tenant establish or replace shared
   * proof authority without validating the transaction, proof, and active
   * block header against this server's own services.
   */
  static async validateSyncProof(storage: EntityStorage, candidate: TableProvenTx): Promise<void> {
    if (!/^[0-9a-f]{64}$/i.test(candidate.txid)) {
      EntityProvenTx.invalidSyncProof('txid must be 32-byte hexadecimal')
    }
    if (!Number.isSafeInteger(candidate.height) || candidate.height < 0) {
      EntityProvenTx.invalidSyncProof('height must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(candidate.index) || candidate.index < 0) {
      EntityProvenTx.invalidSyncProof('index must be a non-negative safe integer')
    }
    if (!Array.isArray(candidate.rawTx) || candidate.rawTx.length === 0) {
      EntityProvenTx.invalidSyncProof('raw transaction is required')
    }
    if (!Array.isArray(candidate.merklePath) || candidate.merklePath.length === 0) {
      EntityProvenTx.invalidSyncProof('Merkle path is required')
    }

    try {
      const parsed = Transaction.fromBinary(candidate.rawTx)
      const rawTxid = asString(doubleSha256BE(candidate.rawTx))
      if (parsed.id('hex') !== rawTxid || rawTxid !== candidate.txid.toLowerCase()) {
        EntityProvenTx.invalidSyncProof('raw transaction hash does not match txid')
      }

      const proof = MerklePath.fromBinary(candidate.merklePath)
      if (proof.blockHeight !== candidate.height) {
        EntityProvenTx.invalidSyncProof('Merkle path height does not match the record')
      }
      const leaf = proof.path[0]?.find(item => item.txid === true && item.hash === candidate.txid.toLowerCase())
      if (leaf == null || leaf.offset !== candidate.index) {
        EntityProvenTx.invalidSyncProof('Merkle path does not contain the transaction at the recorded index')
      }
      const root = proof.computeRoot(candidate.txid.toLowerCase())
      if (root !== candidate.merkleRoot.toLowerCase()) {
        EntityProvenTx.invalidSyncProof('computed Merkle root does not match the record')
      }

      const services = storage.getServices()
      const chainTracker = await services.getChainTracker()
      if (!(await chainTracker.isValidRootForHeight(root, candidate.height))) {
        EntityProvenTx.invalidSyncProof('Merkle root is not active at the recorded height')
      }

      const header = await services.getHeaderForHeight(candidate.height)
      if (header.length !== 80) EntityProvenTx.invalidSyncProof('active block header must be 80 bytes')
      const activeHash = asString(doubleSha256BE(header))
      const activeMerkleRoot = asString(header.slice(36, 68).reverse())
      if (activeHash !== candidate.blockHash.toLowerCase() || activeMerkleRoot !== root) {
        EntityProvenTx.invalidSyncProof('block metadata does not match the active header')
      }
    } catch (error) {
      if (error instanceof WERR_INVALID_PARAMETER) throw error
      EntityProvenTx.invalidSyncProof('transaction, Merkle path, or active header could not be validated')
    }
  }

  private sameProof(candidate: TableProvenTx): boolean {
    return this.txid.toLowerCase() === candidate.txid.toLowerCase() &&
      this.height === candidate.height &&
      this.index === candidate.index &&
      arraysEqual(this.merklePath, candidate.merklePath) &&
      arraysEqual(this.rawTx, candidate.rawTx) &&
      this.blockHash.toLowerCase() === candidate.blockHash.toLowerCase() &&
      this.merkleRoot.toLowerCase() === candidate.merkleRoot.toLowerCase()
  }

  private static async invalidatePreparedProofs(
    storage: EntityStorage,
    trx?: TrxToken
  ): Promise<void> {
    const extension = storage as EntityStorage & {
      invalidatePreparedBeefs?: (trx?: TrxToken) => Promise<number>
    }
    if (typeof extension.invalidatePreparedBeefs === 'function') {
      await extension.invalidatePreparedBeefs(trx)
    }
  }

  /**
   * Given a txid and optionally its rawTx, create a new ProvenTx object.
   *
   * rawTx is fetched if not provided.
   *
   * Only succeeds (proven is not undefined) if a proof is confirmed for rawTx,
   * and hash of rawTx is confirmed to match txid
   *
   * The returned ProvenTx and ProvenTxReq objects have not been added to the storage database,
   * this is optional and can be done by the caller if appropriate.
   *
   * @param txid
   * @param services
   * @param rawTx
   * @returns
   */
  static async fromTxid(txid: string, services: WalletServices, rawTx?: number[]): Promise<ProvenTxFromTxidResult> {
    const r: ProvenTxFromTxidResult = { proven: undefined, rawTx }

    if (r.rawTx == null) {
      const gr = await services.getRawTx(txid)
      if (gr?.rawTx == null)
      // Failing to find anything...
      {
        return r
      }
      r.rawTx = gr.rawTx!
    }

    const gmpr = await services.getMerklePath(txid)

    if (gmpr.merklePath != null && gmpr.header != null) {
      const index = gmpr.merklePath.path[0].find(l => l.hash === txid)?.offset
      if (index !== undefined) {
        const api: TableProvenTx = {
          created_at: new Date(),
          updated_at: new Date(),
          provenTxId: 0,
          txid,
          height: gmpr.header.height,
          index,
          merklePath: gmpr.merklePath.toBinary(),
          rawTx: r.rawTx,
          blockHash: gmpr.header.hash,
          merkleRoot: gmpr.header.merkleRoot
        }
        r.proven = new EntityProvenTx(api)
      }
    }

    return r
  }

  constructor(api?: TableProvenTx) {
    const now = new Date()
    super(
      api || {
        provenTxId: 0,
        created_at: now,
        updated_at: now,
        txid: '',
        height: 0,
        index: 0,
        merklePath: [],
        rawTx: [],
        blockHash: '',
        merkleRoot: ''
      }
    )
  }

  override updateApi(): void {
    /* nothing needed yet... */
  }

  /**
   * @returns desirialized `MerklePath` object, value is cached.
   */
  getMerklePath(validateRoots: boolean = true): MerklePath {
    if (validateRoots) {
      this._mp ??= MerklePath.fromBinary(this.api.merklePath)
      return this._mp
    }
    this._mpUnchecked ??= MerklePath.fromBinary(this.api.merklePath, true, false)
    return this._mpUnchecked
  }

  _mp?: MerklePath
  _mpUnchecked?: MerklePath

  get provenTxId() {
    return this.api.provenTxId
  }

  set provenTxId(v: number) {
    this.api.provenTxId = v
  }

  get created_at() {
    return this.api.created_at
  }

  set created_at(v: Date) {
    this.api.created_at = v
  }

  get updated_at() {
    return this.api.updated_at
  }

  set updated_at(v: Date) {
    this.api.updated_at = v
  }

  get txid() {
    return this.api.txid
  }

  set txid(v: string) {
    this.api.txid = v
  }

  get height() {
    return this.api.height
  }

  set height(v: number) {
    this.api.height = v
  }

  get index() {
    return this.api.index
  }

  set index(v: number) {
    this.api.index = v
  }

  get merklePath() {
    return this.api.merklePath
  }

  set merklePath(v: number[]) {
    this.api.merklePath = v
  }

  get rawTx() {
    return this.api.rawTx
  }

  set rawTx(v: number[]) {
    this.api.rawTx = v
  }

  get blockHash() {
    return this.api.blockHash
  }

  set blockHash(v: string) {
    this.api.blockHash = v
  }

  get merkleRoot() {
    return this.api.merkleRoot
  }

  set merkleRoot(v: string) {
    this.api.merkleRoot = v
  }

  override get id() {
    return this.api.provenTxId
  }

  override set id(v: number) {
    this.api.provenTxId = v
  }

  override get entityName(): string {
    return 'provenTx'
  }

  override get entityTable(): string {
    return 'proven_txs'
  }

  override equals(ei: TableProvenTx, syncMap?: SyncMap | undefined): boolean {
    const eo = this.toApi()
    if (
      eo.txid != ei.txid ||
      eo.height != ei.height ||
      eo.index != ei.index ||
      !arraysEqual(eo.merklePath, ei.merklePath) ||
      !arraysEqual(eo.rawTx, ei.rawTx) ||
      eo.blockHash !== ei.blockHash ||
      eo.merkleRoot !== ei.merkleRoot
      // equality does not depend on timestamps.
      // || eo.created_at !== ei.created_at
      // || eo.updated_at !== ei.updated_at
    ) {
      return false
    }
    if (syncMap != null) {
      if (eo.provenTxId !== syncMap.provenTx.idMap[ei.provenTxId]) return false
    } else if (eo.provenTxId !== ei.provenTxId) {
      return false
    }
    return true
  }

  static async mergeFind(
    storage: EntityStorage,
    userId: number,
    ei: TableProvenTx,
    syncMap: SyncMap,
    trx?: TrxToken
  ): Promise<{ found: boolean; eo: EntityProvenTx; eiId: number }> {
    const ef = verifyOneOrNone(await storage.findProvenTxs({ partial: { txid: ei.txid }, trx }))
    return {
      found: ef != null,
      eo: new EntityProvenTx(ef || { ...ei }),
      eiId: verifyId(ei.provenTxId)
    }
  }

  override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void> {
    this.provenTxId = 0
    this.provenTxId = await storage.insertProvenTx(this.toApi(), trx)
    await EntityProvenTx.invalidatePreparedProofs(storage, trx)
  }

  override async mergeExisting(
    storage: EntityStorage,
    since: Date | undefined,
    ei: TableProvenTx,
    syncMap: SyncMap,
    trx?: TrxToken
  ): Promise<boolean> {
    if (this.sameProof(ei)) return false
    const update: Partial<TableProvenTx> = {
      updated_at: ei.updated_at,
      height: ei.height,
      index: ei.index,
      merklePath: ei.merklePath,
      rawTx: ei.rawTx,
      blockHash: ei.blockHash.toLowerCase(),
      merkleRoot: ei.merkleRoot.toLowerCase()
    }
    await storage.updateProvenTx(this.provenTxId, update, trx)
    this.api = { ...this.api, ...update }
    await EntityProvenTx.invalidatePreparedProofs(storage, trx)
    return true
  }

  /**
   * How high attempts can go before status is forced to invalid
   */
  static readonly getProofAttemptsLimit = 8

  /**
   * How many hours we have to try for a poof
   */
  static readonly getProofMinutes = 60

  private static applyProofTimeoutIfExpired(req: EntityProvenTxReq, maxRebroadcastAttempts: number): void {
    if (req.created_at == null) return
    const ageInMsecs = Date.now() - req.created_at.getTime()
    const ageInMinutes = Math.ceil(ageInMsecs < 1 ? 0 : ageInMsecs / (1000 * 60))
    if (req.attempts <= EntityProvenTx.getProofAttemptsLimit) return
    if (ageInMinutes <= EntityProvenTx.getProofMinutes) return

    const limit = EntityProvenTx.getProofAttemptsLimit
    const { attempts } = req
    req.addHistoryNote({ what: 'getMerklePathGiveUp', attempts, limit, ageInMinutes }, true)
    req.applyProofTimeout(maxRebroadcastAttempts)
  }

  private static createFromProof(
    req: EntityProvenTxReq,
    gmpResult: GetMerklePathResult,
    proof: MerklePath
  ): EntityProvenTx {
    const leaf = proof.path[0].find(candidate => candidate.txid === true && candidate.hash === req.txid)
    if (leaf == null) {
      req.addHistoryNote({ what: 'getMerklePathTxidNotFound' }, true)
      throw new WERR_INTERNAL('merkle path does not contain leaf for txid')
    }
    const now = new Date()
    return new EntityProvenTx({
      created_at: now,
      updated_at: now,
      provenTxId: 0,
      txid: req.txid!,
      height: proof.blockHeight,
      index: leaf.offset,
      merklePath: proof.toBinary(),
      rawTx: req.rawTx!,
      merkleRoot: gmpResult.header!.merkleRoot,
      blockHash: gmpResult.header!.hash
    })
  }

  private static recordProofError(req: EntityProvenTxReq, error: unknown): void {
    const { code, description } = WalletError.fromUnknown(error)
    const { attempts } = req
    req.addHistoryNote({ what: 'getMerklePathProvenError', attempts, code, description }, true)
  }

  /**
   * Try to create a new ProvenTx from a ProvenTxReq and GetMerkleProofResultApi
   *
   * Otherwise it returns undefined and updates req.status to either 'unknown', 'invalid', or 'unconfirmed'
   *
   * @param req
   * @param gmpResult
   * @returns
   */
  static async fromReq(
    req: EntityProvenTxReq,
    gmpResult: GetMerklePathResult,
    countsAsAttempt: boolean,
    maxRebroadcastAttempts = 0
  ): Promise<EntityProvenTx | undefined> {
    if (!req.txid) throw new WERR_MISSING_PARAMETER('req.txid')
    if (!req.rawTx) throw new WERR_MISSING_PARAMETER('req.rawTx')

    if (!req.rawTx) throw new WERR_INTERNAL('rawTx must be valid')

    for (const note of gmpResult.notes || []) {
      req.addHistoryNote(note, true)
    }

    if (!gmpResult.name && gmpResult.merklePath == null && gmpResult.error == null) {
      // Most likely offline or now services configured.
      // Does not count as a proof attempt.
      return undefined
    }

    if (gmpResult.merklePath == null) {
      EntityProvenTx.applyProofTimeoutIfExpired(req, maxRebroadcastAttempts)
      return undefined
    }

    if (countsAsAttempt) req.attempts++

    const merklePaths = Array.isArray(gmpResult.merklePath) ? gmpResult.merklePath : [gmpResult.merklePath]

    for (const proof of merklePaths) {
      try {
        return EntityProvenTx.createFromProof(req, gmpResult, proof)
      } catch (error: unknown) {
        EntityProvenTx.recordProofError(req, error)
      }
    }
  }
}

export interface ProvenTxFromTxidResult {
  proven?: EntityProvenTx
  rawTx?: number[]
}
