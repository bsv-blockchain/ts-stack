import {
  Base64String,
  BroadcastFailure,
  BroadcastResponse,
  ListOutputsResult,
  LookupAnswer,
  LookupResolver,
  PubKeyHex,
  PushDrop,
  Random,
  TopicBroadcaster,
  Transaction,
  Utils,
  WalletClient,
  WalletInterface,
  WalletOutput,
  WalletProtocol
} from '@bsv/sdk'
import { DIDRecord, DIDQuery } from './types/index.js'

/* ────────────────────────────────────────────────────────────
 * Constants
 * ────────────────────────────────────────────────────────── */
const PROTOCOL_ID: WalletProtocol = [2, 'did token'] // TODO: Change to: [1, 'metanet did']
const DEFAULT_KEY_ID = '1' // TODO: Update to take into account derivation prefix / suffix
const DEFAULT_OVERLAY_TOPIC = 'tm_did'
const DEFAULT_LOOKUP_SERVICE = 'ls_did'

export interface DIDClientOptions {
  overlayTopic?: string
  overlayService?: string
  wallet?: WalletInterface
  networkPreset?: 'mainnet' | 'testnet' | 'local'
  acceptDelayedBroadcast?: boolean
}

/* ────────────────────────────────────────────────────────────
 * DIDClient
 * ────────────────────────────────────────────────────────── */
export class DIDClient {
  private readonly overlayTopic: string
  private readonly overlayService: string
  private readonly wallet: WalletInterface
  private readonly networkPreset: 'mainnet' | 'testnet' | 'local' | undefined
  private readonly acceptDelayedBroadcast: boolean

  constructor(opts: DIDClientOptions = {}) {
    this.overlayTopic = opts.overlayTopic ?? DEFAULT_OVERLAY_TOPIC
    this.overlayService = opts.overlayService ?? DEFAULT_LOOKUP_SERVICE
    this.wallet = opts.wallet ?? new WalletClient()
    this.networkPreset = opts.networkPreset
    this.acceptDelayedBroadcast = opts.acceptDelayedBroadcast ?? false
  }

  /* ──────────────────────────────  Create  ───────────────────────────── */
  /**
   * Creates (mints) a new DID token that carries the provided `serialNumber`.
   * The token is formed as a PushDrop output and broadcast to the DID overlay.
   * @param serialNumber The serial number to be stored in the DID token.
   * @param subject The public key of the subject of the Identity Certificate.
   * @param opts Optional parameters.
   * @returns The overlay broadcast response or failure.
   */
  async createDID(
    serialNumber: string,
    subject: PubKeyHex,
    opts: { wallet?: WalletInterface, derivationPrefix?: Base64String, derivationSuffix?: Base64String } = {}
  ): Promise<BroadcastResponse | BroadcastFailure> {
    const wallet = opts.wallet ?? this.wallet

    let derivationPrefix: Base64String
    let derivationSuffix: Base64String
    if (!opts.derivationPrefix || !opts.derivationSuffix) {
      derivationPrefix = Utils.toBase64(Random(10))
      derivationSuffix = Utils.toBase64(Random(10))
    } else {
      derivationPrefix = opts.derivationPrefix
      derivationSuffix = opts.derivationSuffix
    }

    // 2. Build a PushDrop locking script
    const lockingScript = await new PushDrop(wallet).lock(
      [Utils.toArray(serialNumber, 'base64')],
      PROTOCOL_ID,
      `${derivationPrefix} ${derivationSuffix}`,
      subject
    )

    // 3. Craft the transaction
    const { tx } = await wallet.createAction({
      description: 'Create new DID token',
      outputs: [{
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: 'DID token',
        basket: 'did',
        tags: [
          `did-token-subject-${subject}`,
          `did-token-serialNumber-${serialNumber}`
        ],
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix
        })
      }],
      options: { acceptDelayedBroadcast: this.acceptDelayedBroadcast, randomizeOutputs: false }
    })
    if (!tx) throw new Error('Failed to create DID transaction')

    const transaction = Transaction.fromAtomicBEEF(tx)

    // 4. Broadcast via overlay
    const broadcaster = new TopicBroadcaster([this.overlayTopic], {
      networkPreset: this.networkPreset ?? (await wallet.getNetwork({})).network
    })
    return broadcaster.broadcast(transaction)
  }

  /* ──────────────────────────────  Update  ───────────────────────────── */
  /**
   * Updates an existing DID token with a new `serialNumber` by spending the old
   * output and creating a new one.
   * @param prev The previous DID record.
   * @param newSerialNumber The new serial number to be stored in the DID token.
   */
  // async updateDID(
  //   prev: DIDRecord & { beef: number[] },
  //   newSerialNumber: string
  // ): Promise<BroadcastResponse | BroadcastFailure> {
  //   const prevOutpoint = `${prev.txid}.${prev.outputIndex}` as const

  //   // 1. Encode the new serial
  //   const serialBytes = Utils.toArray(newSerialNumber, 'utf8')

  //   // 2. Build new PushDrop script
  //   // TODO: Update to use correct args
  //   const newLockingScript = await new PushDrop(this.wallet).lock(
  //     [serialBytes],
  //     PROTOCOL_ID,
  //     DEFAULT_KEY_ID,
  //     'anyone',
  //     true
  //   )

  //   // 3. Prepare a spending action
  //   const { signableTransaction } = await this.wallet.createAction({
  //     description: 'Update DID',
  //     inputBEEF: prev.beef,
  //     inputs: [{
  //       outpoint: prevOutpoint,
  //       unlockingScriptLength: 74,
  //       inputDescription: 'Spend previous DID token'
  //     }],
  //     outputs: [{
  //       satoshis: 1,
  //       lockingScript: newLockingScript.toHex(),
  //       outputDescription: 'Updated DID token'
  //     }],
  //     options: { acceptDelayedBroadcast: this.acceptDelayedBroadcast, randomizeOutputs: false }
  //   })
  //   if (!signableTransaction) throw new Error('Unable to create DID update transaction')

  //   // 4. Unlock previous output
  //   const unlocker = new PushDrop(this.wallet).unlock(PROTOCOL_ID, DEFAULT_KEY_ID, 'anyone')
  //   const unlockingScript = await unlocker.sign(Transaction.fromBEEF(signableTransaction.tx), 0)

  //   // 5. Finalize
  //   const { tx } = await this.wallet.signAction({
  //     reference: signableTransaction.reference,
  //     spends: { 0: { unlockingScript: unlockingScript.toHex() } }
  //   })
  //   if (!tx) throw new Error('Unable to finalize DID update')

  //   const transaction = Transaction.fromAtomicBEEF(tx)

  //   // 6. Broadcast
  //   const broadcaster = new TopicBroadcaster([this.overlayTopic], {
  //     networkPreset: this.networkPreset ?? (await this.wallet.getNetwork({})).network
  //   })
  //   return broadcaster.broadcast(transaction)
  // }

  /* ──────────────────────────────  Revoke  ───────────────────────────── */
  /**
   * Revokes a DID token by serial number or outpoint.
   * Handles all the complexity of finding the token, getting BEEF, and spending it.
   * 
   * @param opts Revocation options
   * @param opts.serialNumber The serial number of the DID token (preferred method)
   * @param opts.outpoint The outpoint of the DID token (fallback method)
   * @returns The overlay broadcast response or failure
   */
  async revokeDID(opts: {
    serialNumber?: string
    outpoint?: string
  }): Promise<BroadcastResponse | BroadcastFailure> {
    const { serialNumber, outpoint } = opts

    // 1. Find the DID token in wallet
    let walletOutputs: ListOutputsResult
    if (serialNumber) {
      // Use serial number tag for direct lookup
      walletOutputs = await this.wallet.listOutputs({
        basket: 'did',
        tags: [`did-token-serialNumber-${serialNumber}`],
        includeTags: true,
        includeCustomInstructions: true,
        include: 'entire transactions'
      })
    } else if (outpoint) {
      // If no serial number is provided, get all DID outputs and filter by outpoint
      walletOutputs = await this.wallet.listOutputs({
        basket: 'did',
        tags: [],
        includeTags: true,
        includeCustomInstructions: true,
        include: 'entire transactions'
      })

      // Filter to only the matching outpoint
      const matchingOutput: WalletOutput = walletOutputs.outputs.find((o: any) => o.outpoint === outpoint)
      if (matchingOutput) {
        walletOutputs.outputs = [matchingOutput]
      } else {
        walletOutputs.outputs = []
      }
    } else {
      return {
        status: 'error',
        code: 'ERR_MISSING_IDENTIFIER',
        description: 'Either serialNumber or outpoint must be provided'
      }
    }

    if (walletOutputs.outputs.length === 0) {
      return {
        status: 'error',
        code: 'ERR_DID_NOT_FOUND',
        description: 'DID token not found in wallet'
      }
    }

    const output = walletOutputs.outputs[0]
    if (!output.customInstructions) {
      return {
        status: 'error',
        code: 'ERR_MISSING_INSTRUCTIONS',
        description: 'DID token missing derivation parameters'
      }
    }

    if (!walletOutputs.BEEF) {
      return {
        status: 'error',
        code: 'ERR_NO_BEEF',
        description: 'DID token BEEF data not available from wallet'
      }
    }

    // 2. Extract derivation parameters
    let derivationPrefix: Base64String
    let derivationSuffix: Base64String
    try {
      const instructions = JSON.parse(output.customInstructions)
      derivationPrefix = instructions.derivationPrefix
      derivationSuffix = instructions.derivationSuffix
    } catch (e) {
      return {
        status: 'error',
        code: 'ERR_INVALID_INSTRUCTIONS',
        description: 'Unable to parse DID derivation parameters'
      }
    }

    const subjectTag = output.tags?.find((tag: string) =>
      tag.startsWith('did-token-subject-')
    )
    const subject = subjectTag?.substring('did-token-subject-'.length)

    if (!subject) {
      return {
        status: 'error',
        code: 'ERR_MISSING_SUBJECT',
        description: 'DID token missing subject public key'
      }
    }

    // 3. Spend the DID token to revoke it
    const { signableTransaction } = await this.wallet.createAction({
      description: 'Revoke DID',
      inputBEEF: walletOutputs.BEEF,
      inputs: [{
        outpoint: output.outpoint,
        unlockingScriptLength: 74,
        inputDescription: 'Redeem DID token'
      }],
      options: { acceptDelayedBroadcast: this.acceptDelayedBroadcast, randomizeOutputs: false }
    })
    if (!signableTransaction) throw new Error('Unable to build DID revoke transaction')

    const unlocker = new PushDrop(this.wallet).unlock(
      PROTOCOL_ID,
      `${derivationPrefix} ${derivationSuffix}`,
      subject
    )
    const unlockingScript = await unlocker.sign(Transaction.fromBEEF(signableTransaction.tx), 0)

    const { tx } = await this.wallet.signAction({
      reference: signableTransaction.reference,
      spends: { 0: { unlockingScript: unlockingScript.toHex() } }
    })
    if (!tx) throw new Error('Unable to finalize DID revoke')

    const transaction = Transaction.fromAtomicBEEF(tx)

    // Broadcast
    const broadcaster = new TopicBroadcaster([this.overlayTopic], {
      networkPreset: this.networkPreset ?? (await this.wallet.getNetwork({})).network
    })
    return broadcaster.broadcast(transaction)
  }

  /* ──────────────────────────────  Find  ───────────────────────────── */
  /**
   * Finds DID tokens published to the overlay. You can search by:
   *
   *  - `serialNumber`  (exact Base‑64 match)
   *  - `outpoint`      ("txid.vout")
   *
   * Supports pagination and sorting via `limit`, `skip`, `sortOrder`.
   */
  async findDID(
    query: DIDQuery & { limit?: number; skip?: number; sortOrder?: 'asc' | 'desc'; startDate?: string; endDate?: string } = {},
    opts: { resolver?: LookupResolver; wallet?: WalletInterface; includeBeef?: boolean } = { includeBeef: true }
  ): Promise<Array<DIDRecord & { beef?: number[] }>> {
    const wallet = opts.wallet ?? this.wallet

    // 1. Build the lookup query
    const lookupQuery: Record<string, unknown> = {}
    if (query.serialNumber) lookupQuery.serialNumber = query.serialNumber
    if (query.outpoint) lookupQuery.outpoint = query.outpoint
    if (query.limit !== undefined) lookupQuery.limit = query.limit
    if (query.skip !== undefined) lookupQuery.skip = query.skip
    if (query.sortOrder) lookupQuery.sortOrder = query.sortOrder
    if (query.startDate) lookupQuery.startDate = `${query.startDate}T00:00:00.000Z`
    if (query.endDate) lookupQuery.endDate = `${query.endDate}T23:59:59.999Z`

    // 2. Resolve via lookup service
    const resolver =
      opts.resolver ??
      new LookupResolver({ networkPreset: this.networkPreset ?? (await wallet.getNetwork({})).network })

    const answer = await resolver.query({ service: this.overlayService, query: lookupQuery })

    // 3. Parse the answer
    return this.parseLookupAnswer(answer, opts.includeBeef!)
  }

  /* ───────────────────── Helper: parse lookup answer ─────────────────── */
  private parseLookupAnswer(
    ans: LookupAnswer,
    includeBeef: boolean
  ): Array<DIDRecord & { beef?: number[] }> {
    if (ans.type !== 'output-list' || ans.outputs.length === 0) return []

    return ans.outputs.map(output => {
      const tx = Transaction.fromBEEF(output.beef)
      const out = tx.outputs[output.outputIndex]

      const decoded = PushDrop.decode(out.lockingScript)
      if (decoded.fields.length < 1) throw new Error('Invalid DID token: missing serial number')

      // Convert serial bytes → Base64 string
      const serialNumber = Utils.toBase64(decoded.fields[0] as number[])

      return {
        txid: tx.id('hex'),
        outputIndex: output.outputIndex,
        serialNumber,
        ...(includeBeef ? { beef: output.beef } : {})
      }
    })
  }
}
