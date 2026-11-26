import {
  BroadcastFailure,
  BroadcastResponse,
  HTTPSOverlayLookupFacilitator,
  LookupAnswer,
  LookupResolver,
  OverlayLookupFacilitator,
  PushDrop,
  TopicBroadcaster,
  Transaction,
  Utils,
  WalletClient,
  WalletInterface
} from '@bsv/sdk'
import {
  METANET_APPS_KEY_ID,
  METANET_APPS_LOOKUP_SERVICE,
  METANET_APPS_PROTOCOL,
  METANET_APPS_TOPIC
} from './constants.js'
import { validateAppMetadata } from './metadata.js'
import {
  AppCatalogFindAcrossHostsResult,
  AppCatalogFindOptions,
  AppCatalogOptions,
  AppCatalogQuery,
  AppCatalogLookupDiagnostics,
  PublishedApp,
  PublishedAppMetadata
} from './types/index.js'

/* ────────────────────────────────────────────────────────────
 * Constants
 * ────────────────────────────────────────────────────────── */
export const DEFAULT_APP_LOOKUP_HOSTS = [
  'https://overlay-ap-1.bsvb.tech',
  'https://overlay-eu-1.bsvb.tech',
  'https://overlay-us-1.bsvb.tech',
  'https://users.bapp.dev'
]
const DEFAULT_FIND_OPTIONS: AppCatalogFindOptions = {}

interface ParsedLookupAnswer {
  apps: PublishedApp[]
  outputCount: number
  parseFailureCount: number
}

/* ────────────────────────────────────────────────────────────
 * AppCatalog
 * ────────────────────────────────────────────────────────── */
export class AppCatalog {
  private readonly keyID: string
  private readonly overlayTopic: string
  private readonly overlayService: string
  private readonly wallet: WalletInterface
  private readonly networkPreset: AppCatalogOptions['networkPreset']
  private readonly acceptDelayedBroadcast: boolean
  private cachedNetworkPromise: Promise<'mainnet' | 'testnet' | 'local'> | undefined
  private cachedIdentityKeyPromise: Promise<string> | undefined
  private resolver: LookupResolver | undefined
  private broadcaster: TopicBroadcaster | undefined

  constructor(opts: AppCatalogOptions) {
    this.keyID = opts.keyID ?? METANET_APPS_KEY_ID
    this.overlayTopic = opts.overlayTopic ?? METANET_APPS_TOPIC
    this.overlayService = opts.overlayService ?? METANET_APPS_LOOKUP_SERVICE
    this.wallet = opts.wallet ?? new WalletClient()
    this.networkPreset = opts.networkPreset
    this.acceptDelayedBroadcast = opts.acceptDelayedBroadcast ?? false
  }

  private async getNetwork(
    wallet: WalletInterface = this.wallet
  ): Promise<NonNullable<AppCatalogOptions['networkPreset']>> {
    if (this.networkPreset) return this.networkPreset

    if (wallet !== this.wallet) {
      return (await wallet.getNetwork({})).network
    }

    this.cachedNetworkPromise ??= this.wallet.getNetwork({}).then(({ network }) => network)
    return this.cachedNetworkPromise
  }

  private async getIdentityKey(wallet: WalletInterface = this.wallet): Promise<string> {
    if (wallet !== this.wallet) {
      return (await wallet.getPublicKey({ identityKey: true })).publicKey
    }

    this.cachedIdentityKeyPromise ??= this.wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => publicKey)
    return this.cachedIdentityKeyPromise
  }

  private async getBroadcaster(): Promise<TopicBroadcaster> {
    if (!this.broadcaster) {
      this.broadcaster = new TopicBroadcaster([this.overlayTopic], {
        networkPreset: await this.getNetwork()
      })
    }
    return this.broadcaster
  }

  private async getResolver(wallet: WalletInterface): Promise<LookupResolver> {
    if (wallet !== this.wallet) {
      return new LookupResolver({ networkPreset: await this.getNetwork(wallet) })
    }

    if (!this.resolver) {
      this.resolver = new LookupResolver({ networkPreset: await this.getNetwork() })
    }
    return this.resolver
  }

  /* ──────────────────────────────  Publish  ───────────────────────────── */
  /**
   * Publishes an app by embedding its metadata JSON into a PushDrop token
   * and broadcasting that token to the overlay network.
   */
  async publishApp(
    metadata: PublishedAppMetadata,
    opts: { wallet?: WalletInterface } = {}
  ): Promise<BroadcastResponse | BroadcastFailure> {
    const wallet = opts.wallet ?? this.wallet
    metadata.publisher = await this.getIdentityKey(wallet)
    validateAppMetadata(metadata)

    // --- 1. Encode metadata as UTF‑8 bytes --------------------------------
    const jsonPayload = JSON.stringify(metadata)
    const payloadBytes = Utils.toArray(jsonPayload, 'utf8')

    // --- 2. Build PushDrop locking script --------------------------------
    const lockingScript = await new PushDrop(wallet).lock(
      [payloadBytes],
      METANET_APPS_PROTOCOL,
      this.keyID,
      'anyone',
      true
    )

    // --- 3. Create the transaction --------------------------------------
    const { tx } = await wallet.createAction({
      description: 'AppCatalog - publish app',
      outputs: [
        {
          satoshis: 1,
          lockingScript: lockingScript.toHex(),
          outputDescription: 'Metanet App token'
        }
      ],
      options: { acceptDelayedBroadcast: this.acceptDelayedBroadcast, randomizeOutputs: false }
    })

    if (!tx) throw new Error('Failed to create transaction')

    const transaction = Transaction.fromAtomicBEEF(tx)

    // --- 4. Broadcast through overlay -----------------------------------
    const broadcaster = await this.getBroadcaster()
    return broadcaster.broadcast(transaction)
  }

  /* ──────────────────────────────  Update  ────────────────────────────── */
  /**
   * Updates an existing app listing by spending its previous PushDrop output
   * and creating a new one with the updated metadata. The new output is then
   * broadcast to the overlay.
   */
  async updateApp(
    prev: PublishedApp,
    newMetadata: PublishedAppMetadata
  ): Promise<BroadcastResponse | BroadcastFailure> {
    if (!prev.token.beef) throw new Error('App token must contain BEEF to update')
    newMetadata.publisher = await this.getIdentityKey()
    validateAppMetadata(newMetadata)

    // --- 1. Serialize new metadata --------------------------------------
    const jsonPayload = JSON.stringify(newMetadata)
    const payloadBytes = Utils.toArray(jsonPayload, 'utf8')

    // --- 2. Build new PushDrop locking script ---------------------------
    const newLockingScript = await new PushDrop(this.wallet).lock(
      [payloadBytes],
      METANET_APPS_PROTOCOL,
      this.keyID,
      'anyone',
      true
    )

    // --- 3. Prepare spending of previous output -------------------------
    const pushdrop = new PushDrop(this.wallet)
    const prevOutpoint = `${prev.token.txid}.${prev.token.outputIndex}` as const

    const { signableTransaction } = await this.wallet.createAction({
      description: 'AppCatalog - update app',
      inputBEEF: prev.token.beef,
      inputs: [
        {
          outpoint: prevOutpoint,
          unlockingScriptLength: 74,
          inputDescription: 'Spend previous app token'
        }
      ],
      outputs: [
        {
          satoshis: 1,
          lockingScript: newLockingScript.toHex(),
          outputDescription: 'Updated Metanet App token'
        }
      ],
      options: { acceptDelayedBroadcast: this.acceptDelayedBroadcast, randomizeOutputs: false }
    })

    if (!signableTransaction) throw new Error('Unable to create update transaction')

    // --- 4. Produce unlocking script ------------------------------------
    const unlocker = pushdrop.unlock(METANET_APPS_PROTOCOL, this.keyID, 'anyone')
    const unlockingScript = await unlocker.sign(Transaction.fromBEEF(signableTransaction.tx), 0)

    // --- 5. Sign and finalize -------------------------------------------
    const { tx } = await this.wallet.signAction({
      reference: signableTransaction.reference,
      spends: { 0: { unlockingScript: unlockingScript.toHex() } }
    })

    if (!tx) throw new Error('Unable to finalize update transaction')

    const transaction = Transaction.fromAtomicBEEF(tx)

    // --- 6. Broadcast through overlay -----------------------------------
    const broadcaster = await this.getBroadcaster()
    return await broadcaster.broadcast(transaction)
  }

  /* ──────────────────────────────  Remove  ───────────────────────────── */
  /**
   * Removes an app listing from the overlay by spending its previous PushDrop output.
   *
   * @param prev The previous app listing to remove.
   * @returns The BroadcastResponse or BroadcastFailure from the overlay.
   */
  async removeApp(prev: PublishedApp): Promise<BroadcastResponse | BroadcastFailure> {
    if (!prev.token.beef) throw new Error('App token must contain BEEF to remove')

    const prevOutpoint = `${prev.token.txid}.${prev.token.outputIndex}` as const
    const { signableTransaction } = await this.wallet.createAction({
      description: 'AppCatalog - remove app',
      inputBEEF: prev.token.beef,
      inputs: [
        {
          outpoint: prevOutpoint,
          unlockingScriptLength: 74,
          inputDescription: 'Redeem app token'
        }
      ],
      options: { acceptDelayedBroadcast: this.acceptDelayedBroadcast, randomizeOutputs: false }
    })
    if (!signableTransaction) throw new Error('Unable to redeem app token')

    const unlocker = new PushDrop(this.wallet).unlock(METANET_APPS_PROTOCOL, this.keyID, 'anyone')
    const unlockingScript = await unlocker.sign(Transaction.fromBEEF(signableTransaction.tx), 0)

    const { tx } = await this.wallet.signAction({
      reference: signableTransaction.reference,
      spends: { 0: { unlockingScript: unlockingScript.toHex() } }
    })
    if (!tx) throw new Error('Unable to redeem app token')

    const transaction = Transaction.fromAtomicBEEF(tx)

    // Broadcast to overlay
    const broadcaster = await this.getBroadcaster()
    return await broadcaster.broadcast(transaction)
  }

  /* ──────────────────────────────  Find  ─────────────────────────────── */
  /**
   * Finds apps published to the overlay by querying the lookup service.
   *
   * Supports pagination and sorting through the following parameters:
   * - `limit`: Maximum number of results to return (default: 50)
   * - `skip`: Number of results to skip for pagination (default: 0)
   * - `sortOrder`: Sort direction - 'asc' (oldest first) or 'desc' (newest first, default)
   *
   * @example
   * // Get the first page of 20 results
   * const page1 = await appCatalog.findApps({ limit: 20, skip: 0 });
   *
   * // Get the second page
   * const page2 = await appCatalog.findApps({ limit: 20, skip: 20 });
   *
   * // Sort by oldest first
   * const oldestFirst = await appCatalog.findApps({ sortOrder: 'asc' });
   */
  async findApps(
    query: AppCatalogQuery = {},
    opts: AppCatalogFindOptions = DEFAULT_FIND_OPTIONS
  ): Promise<PublishedApp[]> {
    if (opts.hosts?.length) {
      return (await this.findAppsAcrossHosts(query, opts)).apps
    }

    const wallet = opts.wallet ?? this.wallet
    const includeBeef = opts.includeBeef ?? true

    // --- 1. Build lookup query -----------------------------------------
    const lookupQuery = this.buildLookupQuery(query, includeBeef)

    // --- 2. Resolve -----------------------------------------------------
    const resolver = opts.resolver ?? (await this.getResolver(wallet))

    const answer = await resolver.query({ service: this.overlayService, query: lookupQuery })

    // --- 3. Parse answer ------------------------------------------------
    return this.parseLookupAnswer(answer, includeBeef)
  }

  /**
   * Finds apps by querying explicit overlay hosts directly, merging all valid
   * results, and returning per-host diagnostics. This is useful for frontends
   * that need stable results across regions when SLAP discovery or one overlay
   * cluster returns a sparse catalog.
   */
  async findAppsAcrossHosts(
    query: AppCatalogQuery = {},
    opts: AppCatalogFindOptions = {}
  ): Promise<AppCatalogFindAcrossHostsResult> {
    const includeBeef = opts.includeBeef ?? true
    const lookupQuery = this.buildLookupQuery(query, includeBeef)
    const hosts = this.normalizeHosts(opts.hosts ?? DEFAULT_APP_LOOKUP_HOSTS)
    const facilitator = opts.facilitator ?? new HTTPSOverlayLookupFacilitator()
    const allApps: PublishedApp[] = []
    const diagnostics: AppCatalogLookupDiagnostics = {
      service: this.overlayService,
      rawOutputCount: 0,
      parsedAppCount: 0,
      duplicateCount: 0,
      returnedAppCount: 0,
      hosts: []
    }

    await Promise.all(
      hosts.map(async host => {
        const startedAt = Date.now()
        try {
          const answer = await facilitator.lookup(
            host,
            { service: this.overlayService, query: lookupQuery },
            opts.timeout
          )
          const parsed = this.parseLookupAnswerWithStats(answer, includeBeef)
          allApps.push(...parsed.apps)
          diagnostics.rawOutputCount += parsed.outputCount
          diagnostics.parsedAppCount += parsed.apps.length
          diagnostics.hosts.push({
            host,
            ok: true,
            durationMs: Date.now() - startedAt,
            rawOutputCount: parsed.outputCount,
            parsedAppCount: parsed.apps.length,
            parseFailureCount: parsed.parseFailureCount
          })
        } catch (err) {
          diagnostics.hosts.push({
            host,
            ok: false,
            durationMs: Date.now() - startedAt,
            rawOutputCount: 0,
            parsedAppCount: 0,
            parseFailureCount: 0,
            error: this.errorMessage(err)
          })
        }
      })
    )

    const merged = this.dedupeApps(allApps)
    diagnostics.duplicateCount = merged.duplicateCount
    diagnostics.returnedAppCount = merged.apps.length

    return {
      apps: merged.apps,
      diagnostics
    }
  }

  /* ───────────────────────── Helper: parse lookup ─────────────────────── */
  private parseLookupAnswer(ans: LookupAnswer, includeBeef: boolean): PublishedApp[] {
    return this.parseLookupAnswerWithStats(ans, includeBeef).apps
  }

  private parseLookupAnswerWithStats(
    ans: Awaited<ReturnType<OverlayLookupFacilitator['lookup']>>,
    includeBeef: boolean
  ): ParsedLookupAnswer {
    if (ans.type !== 'output-list' || !ans.outputs.length) {
      return { apps: [], outputCount: 0, parseFailureCount: 0 }
    }
    const apps: PublishedApp[] = []
    let parseFailureCount = 0

    for (const o of ans.outputs) {
      try {
        const tx = Transaction.fromBEEF(o.beef)
        const out = tx.outputs[o.outputIndex]
        if (!out) continue

        const decoded = PushDrop.decode(out.lockingScript)
        if (!decoded.fields.length) continue

        const jsonString = Utils.toUTF8(decoded.fields[0] as number[])
        const metadata: PublishedAppMetadata = JSON.parse(jsonString)

        apps.push({
          metadata,
          token: {
            txid: tx.id('hex'),
            outputIndex: o.outputIndex,
            lockingScript: out.lockingScript.toHex(),
            satoshis: out.satoshis ?? 0,
            ...(includeBeef ? { beef: o.beef } : {})
          }
        })
      } catch {
        // Skip malformed records instead of failing the whole lookup.
        parseFailureCount++
      }
    }

    return {
      apps,
      outputCount: ans.outputs.length,
      parseFailureCount
    }
  }

  private buildLookupQuery(query: AppCatalogQuery, includeBeef: boolean): Record<string, unknown> {
    const lookupQuery: Record<string, unknown> = {}
    if (query.domain) lookupQuery.domain = query.domain
    if (query.outpoint) lookupQuery.outpoint = query.outpoint
    if (query.publisher) lookupQuery.publisher = query.publisher
    if (query.name) lookupQuery.name = query.name
    if (query.category) lookupQuery.category = query.category
    if (query.tags?.length) lookupQuery.tags = query.tags
    if (query.limit !== undefined) lookupQuery.limit = query.limit
    if (query.skip !== undefined) lookupQuery.skip = query.skip
    if (query.sortOrder) lookupQuery.sortOrder = query.sortOrder
    if (query.startDate) lookupQuery.startDate = `${query.startDate}T00:00:00.000Z`
    if (query.endDate) lookupQuery.endDate = `${query.endDate}T23:59:59.999Z`
    if (!includeBeef) lookupQuery.includeBeef = false
    return lookupQuery
  }

  private normalizeHosts(hosts: string[]): string[] {
    const seen = new Set<string>()
    const normalized: string[] = []
    for (const host of hosts) {
      const address = host.trim()
      let end = address.length
      while (end > 0 && address.charAt(end - 1) === '/') end--
      const trimmed = address.slice(0, end)
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      normalized.push(trimmed)
    }
    return normalized
  }

  private dedupeApps(apps: PublishedApp[]): { apps: PublishedApp[]; duplicateCount: number } {
    const unique = new Map<string, PublishedApp>()
    let duplicateCount = 0

    for (const app of apps) {
      const key = app.token.txid
        ? `${app.token.txid}.${app.token.outputIndex}`
        : `domain:${app.metadata.domain.toLowerCase()}`

      if (unique.has(key)) {
        duplicateCount++
        continue
      }
      unique.set(key, app)
    }

    return {
      apps: Array.from(unique.values()),
      duplicateCount
    }
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
  }
}

export * from './constants.js'
export * from './broadcast.js'
export * from './metadata.js'
export * from './types/index.js'
