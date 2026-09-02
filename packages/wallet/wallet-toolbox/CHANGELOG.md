# wallet-toolbox Significant Changes History

This document captures the history of significant changes to the wallet-toolbox repository.
The git commit history contains the details but is unable to draw
attention to changes that materially alter behavior or extend functionality.

## wallet-toolbox (unreleased)

- Keep Argon2id-backed UMP v3 wallets available in React Native and other
  runtimes without WebAssembly by falling back to an asynchronously yielding,
  standards-compatible JavaScript implementation. The same KDF parameters and
  derived bytes are preserved, so existing tokens require no migration and
  WebAssembly-capable runtimes retain the faster path. The current-main macOS
  reference fixtures measure 1,690,925 raw / 398,461 gzip / 311,955 Brotli
  bytes with Vite, 1,319,059 raw / 362,220 gzip / 291,206 Brotli bytes with
  esbuild, 1,746,067 raw / 442,648 gzip / 343,342 Brotli bytes with Metro, and
  3,542,034 raw / 1,419,515 gzip / 1,117,531 Brotli bytes as optimized Hermes
  bytecode. The reviewed ceilings advance to 1,693,000 / 400,000 / 314,000
  Vite bytes, 1,321,000 / 364,000 / 293,000 esbuild bytes, 1,748,000 raw Metro
  bytes with the compressed ceilings unchanged, and 3,547,000 / 1,423,000 /
  1,123,000 Hermes bytes.

- Extend the BRC-98/99/111 permission-module interface with an optional semantic
  `handleRequest` hook. A module can now return a conforming BRC-100 result
  directly or invoke the underlying wallet operation at most once, while
  existing `onRequest`/`onResponse` transformation modules remain compatible.
  The companion `@bsv/ecpm-permission-module` uses this hook to implement
  `p ecpm` point multiplication without adding a BRC-100 method or wire call.

- Add opt-in prepared BEEF storage for Knex-backed normal `createAction`
  funding. COOK (Create Once, Output Kept) stores a user-scoped, exact,
  independently verified and checksummed proof closure, merges valid hits
  without invoking the canonical builder, and treats every miss or cache
  failure as the existing canonical path. Missing roots and newly finalized
  managed-change transactions are queued only after foreground action work is
  complete; bounded writes, reads, and gradual backfill are separately
  controlled and default off. Reorganizations stale derived artifacts, a
  database proof epoch fences in-flight cross-process writes, purge removes
  unused rows, and prepared data remains outside wallet sync. The
  Knex worker is excluded from portable bundles. Reviewed Vite ceilings advance
  to 1,610,250 raw / 379,750 gzip / 298,000 Brotli bytes and esbuild ceilings
  to 1,255,000 raw / 346,250 gzip / 278,000 Brotli, covering local measurements
  of 1,609,783 / 379,492 / 297,253 and 1,254,603 / 344,792 / 277,384 bytes;
  hosted Linux Vite Brotli and esbuild gzip measured 297,585 and 345,711 bytes.
  The Hermes raw / gzip ceilings advance to 3,374,500 / 1,369,000 bytes,
  covering local measurements of 3,372,554 / 1,348,354 and hosted Linux
  measurements of 3,373,560 / 1,368,128 bytes; Metro and Hermes Brotli
  ceilings remain unchanged.
- Add the built-in BRC-177 `p nosend expiry` module for seconds, Unix timestamp,
  and block-height deadlines. Protected actions are prefunded through an
  accepted transaction, contain no wallet change, and retain a pre-signed
  reclaim across restarts, synchronized storage, devices, and keyless remote
  monitors. Atomic lifecycle transitions, active-storage ownership,
  fail-closed status checks, backoff-controlled recovery of terminally rejected
  reclaims, quarantined race outputs, and locally validated proof finality
  prevent duplicate reclaim activation and unsafe state regression. Wallet
  Permissions Manager authorizes module use and spending
  before prefunding, attributes the funding fee to the requesting originator,
  and rechecks the current monthly ledger before releasing the protected
  action. Existing actions and ordinary `noSend` calls are unchanged. The
  current-main macOS reference fixtures measure 1,662,220 raw / 388,763 gzip /
  305,307 Brotli bytes with Vite, 1,297,621 raw / 355,579 gzip / 285,031 Brotli
  bytes with esbuild, 1,710,494 raw / 430,613 gzip / 334,490 Brotli bytes with
  Metro, and 3,474,604 raw / 1,406,878 gzip / 1,090,948 Brotli bytes as
  optimized Hermes bytecode. The reviewed ceilings advance to 1,665,000 /
  390,000 / 307,000 Vite bytes, 1,300,000 / 357,000 / 287,000 esbuild bytes,
  1,712,000 / 455,000 / 360,000 Metro bytes, and 3,480,000 / 1,410,000 /
  1,095,000 Hermes bytes.

- Report `listOutputs` `totalOutputs` as the size of the whole result set on
  every page, in both the IndexedDB and Knex storage providers. A short final
  page previously returned only that page's length, so a client paging a large
  basket saw the total collapse to the size of the last page; an offset at or
  past the end now counts instead of inferring, and the managed-change spec-op
  no longer discards the total it already computed. Full pages, first pages,
  and empty result sets are unchanged, so no consumer migration is required.
  `balanceAndUtxos` now terminates from page progress instead of relying on the
  former collapsing total, preventing a zero-progress loop after the final page.
  The reviewed Vite raw-size ceiling advances by 500 bytes to 1,607,500,
  covering the hosted Linux measurement of 1,607,015 bytes; the Vite compressed
  and esbuild ceilings remain unchanged.

- Serialize typed AtomicBEEF and competing BEEF in wallet review errors as
  portable JSON arrays, keeping HTTP and relay error recovery compatible with
  both historical array wallets and current binary Wallet Wire wallets.
- Serialize real typed arrays portably in outbound WAB requests while
  preserving arbitrary inbound WAB JSON objects exactly.

- Accept legacy BRC-95 payment envelopes that include unrelated BEEF branches
  by reducing them to the declared transaction and its dependency closure
  before strict proof and BRC-29 validation. Malformed transactions, invalid
  proofs, and incorrectly locked payment outputs remain rejected. The shared
  helper adds 137 bytes to the local optimized Hermes fixture. The reviewed
  ceilings advance by 1,000 bytes to 3,361,000 raw and 1,362,000 gzip, covering
  the measured macOS raw size of 3,360,137 bytes and hosted Linux gzip size of
  1,361,509 bytes; the Brotli ceiling remains unchanged.

- Commit each received wallet-storage sync page and its durable checkpoint in
  one provider transaction. Large IndexedDB replications avoid thousands of
  transaction startup/commit cycles, failed pages roll back without advancing
  the checkpoint, and abort cleanup preserves the original storage error.

- Make verified phone changes interruption-safe by staging the replacement key
  in WAB, publishing the UMP rotation, and then finalizing WAB. Authentication
  can recover an interrupted transition from the current or pending key and
  idempotently finish it without creating a second UMP update.

- Prune `inputBEEF` to the dependency closure of explicitly declared action
  inputs before remote request serialization and repeat the pruning on the
  server before verification and persistence. Unrelated proof branches no
  longer consume transfer or validation work or cause an otherwise valid
  action to fail; proof data required by a declared input is still fully
  validated.

- Add a local-first ChainTracks control plane for browser, mobile, and Node
  wallets, including explicit local-primary/remote-only mode, independently
  sourced consistency checks, quorum-backed exceptional fallback, local-clear
  hooks, and opt-in divergence recovery. Add a portable packaged-checkpoint
  cache contract and a Node filesystem implementation with validated reads and
  atomic writes. Coalesce concurrent immutable-file misses, centralize bounded
  fetch retries, enforce whole-response deadlines and byte ceilings, and expose
  cache/download counters and an optional upstream-byte budget. Bulk and live
  ingestion now enforce each header's declared proof-of-work target, and local
  consistency checks detect both quorum-confirmed divergence and a
  quorum-confirmed stuck height before optional recovery. The reviewed platform
  service seam also accepts a composed SDK `chainTracker` directly while
  retaining the existing client-wrapping default. The reviewed platform
  ceilings advance to 1,601,000 Vite bytes, 1,249,000 esbuild bytes, and
  3,358,000 Hermes bytes; their matching gzip/Brotli ceilings are
  377,000/296,000, 344,000/276,000, and 1,360,000/1,070,000 bytes.
- Keep ChainTracks availability independent of immutable-header verification:
  stale heights now return immediately behind a single refresh, complete
  digest/linkage/chain-work/proof-of-work validation can run in a bounded Node
  worker pool, and historical reads release the manager lock before disk,
  network, or worker waits. Filesystem caches use content-addressed objects,
  quarantine rejected entries, and promote validated legacy files without
  deleting the only retained copy. A crash-safe download ledger reserves every
  physical retry before network I/O and survives restarts; failed objects back
  off before another attempt. The reference server keeps probes local, applies
  separate historical concurrency admission, and publishes complete CDN
  generations behind an atomic pointer while retaining rollback generations.
- Age proactive pending-transaction review from immutable request creation
  time, so repeated proof polling cannot keep a rejected transaction below the
  reconciliation threshold forever. A descendant of a locally terminal parent
  now fails from that durable storage evidence; failed-parent outputs remain
  quarantined while unrelated inputs are released for reuse. The shared change
  adds about 1.1 kB to the Vite browser artifact and 3.8 kB to Hermes bytecode;
  the reviewed raw ceilings advance to 1,585,000 and 3,322,000 bytes while all
  compressed ceilings remain unchanged; the esbuild raw ceiling advances to
  1,238,000 bytes.
- Keep mainnet and testnet ChainTracks usable from browser and webview wallets:
  browser runtimes temporarily select the CORS-enabled legacy service while
  Node runtimes retain Arcade/go-chaintracks v2. `Services.getHeight` now falls
  back to WhatsOnChain if ChainTracks is unavailable and preserves the original
  ChainTracks error when both providers fail.
- Route `ttn` wallets through the isolated `teratestnet` overlay preset and
  enable the public TTN Arcade broadcaster/proof provider by default. TTN does
  not register the incompatible legacy ARC BEEF fallback. Other chain defaults
  are unchanged, and an empty Arcade URL explicitly disables Arcade.
- Reconcile Arcade broadcast outcomes as durable wallet state. Retryable
  locktime and parent conditions remain pending, while validator failures fail
  the request and explicit missing-input or conflict evidence atomically fails
  every local transaction copy and quarantines its wallet-owned inputs without
  depending on WhatsOnChain. Cached accepted/seen labels can no longer revive a
  terminal conflict; only a mined event whose Merkle proof validates through
  the configured chain tracker may repair it. Arcade also participates in the
  shared transaction-status service so double-spend review remains conservative
  on networks with no explorer. A scheduled paged pass also reconciles aged
  pending requests from durable Arcade lifecycle state, including orphan-mempool
  losers whose SSE event was missed; mined/known evidence wins over rejection.
  Inconclusive or absent UTXO providers no longer
  masquerade as a spent-output verdict in invalid-change release, stale-input
  reconciliation, proof recovery, or storage diagnostics. Invalid-change review
  returns conclusive read-only findings plus unknown diagnostics. Direct release
  blocks atomically with machine-readable `WERR_UTXO_REVIEW_INCONCLUSIVE` when
  any result is unknown. Monitor Admin uses bounded, five-second-deadline pages
  and can explicitly release the confirmed-spent subset while retaining unknowns;
  every mutation rechecks ownership/allocation under lock and records audit
  evidence. Monitor Admin scans by default and requires explicit confirmation.
  The
  Arcade SSE cursor advances only after both event storage work and cursor
  persistence succeed; either failure leaves the event queued for ordered retry.
- Replace 32-satoshi default-basket fragments with a progressive liquidity
  policy targeting 144 useful 5,000-satoshi outputs. New actions create at most
  eight outputs from real surplus and migrate at most four fee-positive legacy
  fragments, while a same-tier compatibility plan guarantees that optional
  shaping cannot refuse an action the former planner could fund. Explicitly
  funded actions materialize change from their existing surplus without
  gathering pool inputs, and SQLite policy migrations use sync-compatible UTC
  ISO timestamps.
- Prefer completed, then unproven, then sending parents. Plans above 16 inputs
  compare exact transaction-plus-BEEF bytes before accepting pending ancestry;
  pending change remains an unconditional last-resort funding source. Align
  action-batch reservation/planning and add a read-only Monitor liquidity
  report. All work limits are configurable and accept `-1` for explicit
  operator-selected unlimited behavior.
- Restore delayed broadcast for durable permission-token persistence. Permission
  grants no longer inherit network-broadcast latency; the managed-change policy
  handles queued ancestry without hiding it or preferring it over settled funds.
- Isolate each in-memory action batch by explicit staged-output or `sendWith`
  membership, so unrelated immediate actions and `noSend` roots cannot be
  captured by or commit a workspace. Add an exact-input resume protocol for
  expired leases, structured lifecycle errors, and a provider-enforced
  cumulative reservation limit that defaults to 256 outputs and can be
  configured, including `-1` for operator-selected unlimited operation.
- Keep the combined action-batch, managed-liquidity, browser-fallback, and
  fail-safe reconciliation browser/mobile cost bounded by exact packed-artifact
  contracts. Local verification measures 1,557,683 raw / 366,927 gzip / 287,337
  Brotli bytes with Vite, 1,215,983 raw / 333,466 gzip / 268,497 Brotli bytes
  with esbuild, 1,617,544 raw Metro bytes, and 3,271,146 raw / 1,302,110 gzip /
  1,025,812 Brotli Hermes bytes. Reviewed raw ceilings are 1,561,000 Vite bytes,
  1,220,000 esbuild bytes, 1,710,000 Metro bytes, and 3,275,000 Hermes bytes;
  compressed ceilings remain independently governed.
- Fix `WalletStorageManager.getStoreEndpointURL` / `getStores().endpointURL` to
  duck-type provider `endpointUrl` instead of matching
  `constructor.name === 'StorageClient'`. Production minifiers rename classes,
  so the name check left remote stores with `endpointURL: undefined` while
  sync still worked; clients that select a backup by URL (make primary) failed.
- Let Storage Server operators select an explicit listener host while retaining
  the historical omitted-host behavior for existing callers. The official
  Wallet Infrastructure image uses this to bind direct-mode traffic on IPv4
  and to keep the application listener on loopback behind nginx.
- Preserve forward-compatible Storage Server browser preflights by accepting
  additive well-formed request headers when operators have not configured a
  strict `WALLET_STORAGE_CORS_ALLOWED_HEADERS` list.
- Restore completed `createAction` and `signAction` Atomic BEEF results to
  numeric arrays at the public wallet boundary so legacy BRC-100 JSON bridges
  preserve their historical wire shape. Typed byte arrays remain supported by
  `AtomicBEEF` and binary Wallet Wire transports.
- Fix credential-free Arcade/go-chaintracks bootstrap when ChainTracks bulk
  storage is empty. A first batch is now accepted only from height zero and is
  still checked for continuity, proof of work, file integrity, and the exact
  configured network genesis before it becomes available.
- Make ChainTracks credential-free by default on mainnet, testnet, and
  TerraTestNet through the public Arcade/go-chaintracks v2 HTTP and SSE APIs.
  Add explicit STN and Terra Scaling TestNet support, exact per-network genesis
  headers, isolated in-memory storage, and remove silent testnet aliases.
- Add prioritized bulk/live source failover, locally validated last-good height
  operation, source health reporting, bounded request timeouts, browser-safe SSE
  reconnection, network checks, and a globally rate-limited anonymous
  WhatsOnChain fallback for mainnet/testnet. WhatsOnChain keys remain optional
  and rejected configured keys retry header/info requests anonymously.
- Preserve the default automatically negotiated in-memory `noSend` batching and
  `sendWith` lifecycle introduced in #289. Expand inherited txid-only proof
  ancestors for cold clients, preserve caller-declared known txids, report the
  actual viable-change funding shortfall, and document aborting listed staged
  actions by transaction ID.
- Collapse fragmented `createAction` storage work into one atomic write
  transaction, batch proof retrieval and compound-proof validation, overlap
  independent proof reads with persistence, bulk-insert untagged outputs, and
  batch canonical P2PKH verification. The retained 153-input authenticated
  remote PXC workload is below 500 ms at p95.
- Reuse parsed root and counterparty keys and one BRC-42 shared secret per
  counterparty while signing managed BRC-29 inputs, keep funding selection and
  transaction-size accounting linear, and avoid redundant BEEF validation,
  unused process reads, and unconditional commission reads on the successful
  path. Generated scripts, signatures, fees, input ordering, BEEF bytes, and
  error diagnostics remain equivalence-tested.
- Add bounded-cardinality spans for proof decode/merge, persistence, signing,
  verification, result assembly, serialization, and server-side processing.
  No telemetry header or protocol field is added; BRC-103/104, AuthFetch, Auth
  Express Middleware, AuthSocket, JSON-RPC, and wallet wire behavior are unchanged.
- Coalesce only recent timestamp-only touches for already-authenticated shared
  Knex sessions, while immediately persisting every authentication and
  certificate transition. This removes a synchronous replicated PXC write from
  the normal RPC path; exact per-request persistence remains available with
  `touchIntervalMs: 0`.
- Make expired action-batch reservations non-blocking in indexed queries and
  repair MySQL rollback support indexes. Existing databases migrate through the
  normal Knex path, and full PXC down-to-empty/re-upgrade is regression-tested.
- Make UMP account lookup resilient to stale SLAP advertisements and partial
  overlay failure. One verified matching token establishes an existing account;
  otherwise one clean empty response establishes a new account. Malformed,
  rejected, empty, and unavailable peers cannot veto a verified token, and
  malformed or unavailable peers cannot veto a clean empty response. Lookups
  with no usable response remain errors; WAB existing-account continuity still
  prevents replacement-wallet onboarding.
- Resolve competing verified UMP tokens on on-chain proof. A candidate spent
  anywhere in another candidate's BEEF ancestry is superseded (evidence merged
  across hosts serving different depths; ancestry walked iteratively so deep
  update chains cannot exhaust the stack). Forked candidates resolve only when
  exactly one provably consumed a same-identity predecessor token, which
  requires the account's keys; anything less decisive stays an error so a
  wrong token can never be chosen silently. Resolved conflicts report a
  `supersededTokens` count in lookup telemetry.
- Plan legacy `createAction` funding against the exact unreserved managed-change
  set before persistence, claim the selected inputs atomically in one storage
  transaction, and fail economically impossible fragmented wallets before
  inserting a transaction row. Add targeted Knex and IndexedDB indexes and
  remove IndexedDB's per-output transaction-status lookup.
- Avoid building full known-txid indexes on the common single-proof path and
  report privacy-safe createAction candidate, funding, proof-fetch, BEEF merge,
  trim, serialization, and known-history timings. BRC-103/104, AuthFetch, Auth
  Express Middleware, AuthSocket, JSON-RPC, and wallet wire behavior are unchanged.
- Keep remote-storage trace correlation inside the telemetry sink instead of
  adding unsupported headers to AuthFetch requests. BRC-103/104, AuthFetch,
  Auth Express Middleware, AuthSocket, JSON-RPC, and storage wire behavior are
  unchanged.
- Point Wallet Toolbox contributors and AI agents to the canonical stack-level
  contribution and quality policy; keep client and mobile candidate versions
  in release lockstep without changing runtime behavior.
- Harden storage, action-batch, remoting, WAB, authentication, chaintracker,
  and monitor implementation paths while preserving persisted schemas,
  positional call compatibility, and public wallet/storage contracts.
- Refresh compatible rate-limit, MySQL, and React Native build dependencies;
  consolidate entropy, Merkle-path, and action-batch iteration without
  changing persisted data, generated paths, or public wallet contracts.
- Remove generated SQLite test databases before and after every Jest run so
  repeated local validation cannot silently consume unbounded disk space.
- Ship the Express declaration dependency required by the public storage
  server, edge-policy, and rate-limit declarations. Validate authenticated
  storage identities explicitly and normalize multi-value Express 5 headers
  instead of relying on implicit request augmentation or scalar headers.
- Add capability-negotiated action-batch manifest format 2 without changing
  BRC-100. It derives source/output scripts from the authenticated transaction
  graph, retains only the external proof frontier, bulk-loads shared storage
  rows, and commits an already prepared manifest by semantic digest. Version-1
  providers and clients retain their existing behavior.
- Add authenticated `ABP1` multi-blob uploads with bounded gzip/Brotli/identity
  negotiation, decompression limits, prepared-manifest authorization, per-item
  content verification, bounded concurrency, and one-transaction bulk storage.
  The physical request limit chunks unbounded logical transactions; it is not
  a script or consensus limit.
- Add optional script-verifier injection to Wallet, setup helpers, and local
  storage providers. Internal checks use explicit consensus context, distinguish
  resource exhaustion from invalid scripts, and continue verifying resolvable
  inputs when another source transaction is intentionally omitted.
- Retain typed bytes through action-batch planning, hashing, validation, and
  chunk assembly; preload external inputs and shared metadata once per atomic
  manifest; and convert Atomic BEEF only at the historical public `number[]`
  boundary without changing BRC-100 or storage protocol contracts.
- Make StorageServer, AdminServer, and the reusable ChaintracksService
  credential-free public-CORS compatible by default, with opt-in exact origin
  lists and configurable CSP/browser response headers. Add bounded parsers,
  in-flight work and Node connection limits, stable non-sensitive errors, and
  metadata-only request logging. Storage RPC work remains protected by
  BRC-103 identity, per-IP/per-identity limits, method allowlisting, and
  optional payment policy.
- Bound StorageServer work per source IP before BRC-103 authentication and per
  identity before payment/RPC handling. Both stages support shared stores, and
  proxy trust now requires an explicit hop/subnet/predicate configuration.
- Harden CWI/WAB account continuity so overlay failures, malformed or ambiguous
  UMP results, and snapshot-load failures cannot silently enter new-user
  onboarding. Add an expiring WAB auth session, legacy-compatible WAB account
  status inference, canonical E.164 phone identity, bounded KDF/snapshot
  parsing, and fail-closed UMP renewal/broadcast behavior.
- Replace WAB's endpoint-by-endpoint raw `fetch` calls with one typed transport
  enforcing HTTPS (localhost excepted), timeouts, request/response limits,
  redirect and ambient-credential protection, correlation IDs, and privacy-safe errors.
  Wallet authentication, UMP, WAB, and snapshot events now support the SDK's
  opt-in generic telemetry sink without reporting keys, snapshots, payloads,
  OTPs, or Shamir shares.
- Add automatically negotiated, in-memory planning for dependent `noSend` workloads. Capable
  storage providers reserve funding once, perform middle action planning and signing without
  persistence round trips, and atomically commit the complete workspace on `sendWith`. Existing
  BRC-100 arguments and results are unchanged, and providers without `actionBatch: 1` retain the
  legacy path. SQLite, MySQL/Knex, IndexedDB, authenticated remote clients, browser, and mobile
  builds share the same capability contract.
- Add leased per-output batch reservations, expiry cleanup, adaptive pool extension, idempotent
  manifest commits, inline content-addressed blobs up to 4 MiB, and authenticated binary uploads
  in provider-sized chunks with four-way bounded concurrency for larger batches. Broadcast remains
  outside the atomic persistence transaction.
- Make batch funding converge on fragmented wallets at production fee rates. Reservation targets
  include the fee and viable-change overhead of an added input, reactive extensions request only
  the remaining shortfall, and EWMA runway extensions subtract unconsumed reserved funding without
  compounding after empty or partial responses. The regression runs 16 independent actions through
  both the in-process and authenticated remote-storage paths and commits the complete batch.
- Bind remote batch authorization exclusively to the BRC-103 authenticated identity and its active
  storage provider, ignoring caller-supplied user IDs and active-state claims. Restrict JSON-RPC
  dispatch to the public remote-storage protocol so authenticated callers cannot invoke low-level
  provider methods, and rate-limit authenticated RPCs per identity key without limiting workspace
  length. Unauthenticated and cross-user batch-management regressions cover the boundary.
- Replace the cumulative 64-output reservation ceiling with repeatable extensions bounded to 64
  outputs per storage call. Workspaces and spend chains no longer have an action-count or confirmed
  funding-input ceiling; an 80-action independent batch crosses the old boundary and commits.
- Add a retained workload benchmark covering 1, 10, 50, and 250 actions across dependent,
  independent, mixed-input, and two-step signing models, four script sizes, and 25/100/250 ms
  storage latency. Run it with `pnpm --filter @bsv/wallet-toolbox bench:action-batch`.
- Release prep for `2.4.2`: transaction-pipeline, BEEF fetching, and binary transport
  performance improvements described below, published in lockstep for Node, browser, and mobile.
- Transaction pipeline performance: reuse parsed BEEF through `createAction`/`signAction`, retain
  typed bytes internally until persistence compatibility boundaries, and avoid reparsing Atomic
  BEEF during internalization and broadcast preparation.
- Fetch independent BEEF ancestor frontiers and allocated-change proofs with bounded concurrency,
  deterministic merge order, Set-based deduplication, and configurable `maxConcurrency`.
- Negotiate compact base64 JSON-RPC binary values across Node, browser, and mobile clients while
  preserving numeric-array requests and responses for old servers and clients. A 1 MiB payload is
  62.7% smaller on the wire than legacy byte-array JSON.
- Treat non-finite ancestor-fetch concurrency values as the safe default instead of silently
  returning incomplete BEEF, reject malformed binary JSON base64, and decode deeply nested JSON
  iteratively so hostile input cannot overflow the JavaScript call stack.
- Keep binary JSON-RPC requests in the legacy numeric-array format by default so rolling deployments
  cannot route a negotiated request to an older server instance. Homogeneous endpoints can opt in to
  compact requests with `StorageClientOptions.binaryRequests`; compact responses remain negotiated.

- Release prep for `2.4.2`: add a Knex-backed async BRC-103 session manager,
  the shared-session schema migration, and `StorageServer.sessionManager`
  injection so authenticated requests can move safely between replicas without
  sticky routing. Session writes reject stale cross-replica state, expire after
  a configurable TTL, and support explicit pruning. Also add an opt-out that
  skips both per-RPC logging and request-parameter serialization, and add a
  `monitor_events.created_at` index for production proof-latency correlation.
  Declare the runtime `body-parser` and `dotenv` imports explicitly;
  `auth-express-middleware@2.1.1` likewise declares its `mime-types` runtime
  import so strict package managers do not fail when loading the built packages.

- Release prep for `2.4.2`: proof completion now discovers every local
  transaction row sharing the proven txid, repairs notification-set drift from
  concurrent multi-user `internalizeAction` calls, and idempotently completes
  any local copy omitted by a last-writer-wins notification update.

- Release prep for `2.4.1`: define one managed-change policy across Knex and IndexedDB allocation,
  counting, default balance reporting, `balanceAndUtxos`, and `noSendChange`.
  Only complete BRC-29 signer metadata is eligible; custom rows remain visible
  through raw default-basket listing for recovery. `internalizeAction` now
  rejects basket insertion into `default`, prevents managed change from being
  reclassified, promotes verified legacy BRC-29 rows through `wallet payment`,
  and permits incompatible custom rows to be swept to non-default baskets
  without changing wallet balance.

- Release prep for `2.4.0`: security fix for `GHSA-36f9-7rg5-cpf8`. `buildSignableTransaction` now verifies that storage-returned outputs match the caller's requested `args.outputs` before signing (rejects substituted/altered/reclassified/missing outputs), and rejects any unrequested output that isn't client-derived change or a single commission output bounded by `MAX_STORAGE_COMMISSION_SATOSHIS`. `WalletPermissionsManager.createAction` independently verifies requested outputs are present in the signable transaction before authorizing, as defense-in-depth. Protects against a malicious or compromised `StorageClient` operator substituting or injecting outputs that would be signed and broadcast without the caller's knowledge.

- Release prep for `2.3.3`: add Arcade-first wallet service wiring, go-chaintracks
  live client/SSE support, resilient ARC/Arcade status handling, monitor
  rebroadcast safeguards, and callback-token redaction for Arcade SSE logs.

- **Public API change**: `AbortActionResult.aborted` is now typed `boolean` (was the literal `true`). The wallet returns `aborted: false` when it positively confirms the underlying transaction is already on chain (mined or known to mempool) and the abort therefore should not proceed. Callers branching on `result.aborted` should treat `false` as "refused due to on-chain confirmation" and typically follow up with `internalizeAction`. Service-unreachable conditions return `aborted: true` (with an `abortAction-offline-fallback` history note) — refusal is reserved for positive on-chain confirmation, per BRC-100.

- Fix: close the nosend orphan-output failure mode. A `nosend` transaction (created via `createAction({noSend:true})`) could be externally broadcast and confirmed on chain before any `internalizeAction` or `Monitor.TaskCheckNoSends` cycle retired its `nosend` status. Before this change, two paths could then destroy the wallet's bookkeeping for the chain-confirmed tx: `StorageProvider.abortAction` unconditionally promoted `transactions.status` to `'failed'` and `proven_tx_reqs.status` to terminal `'invalid'`, hiding every output the tx produced (including the wallet's own auto-fund change) from the `listOutputsKnex` `txStatusAllowed` filter; and `specOpNoSendActions.postProcess` (bulk-abort path) blanket-set `tx.status = 'failed'` regardless of per-row outcome. Additionally `mergedInternalize` never advanced `transactions.status` or `proven_tx_reqs.status` out of `nosend`, so even a correctly-issued post-broadcast `internalizeAction` silently no-op'd on the lifecycle. Four fixes in defense-in-depth: (1) `mergedInternalize` retires the nosend lifecycle (transition to `unproven` + req `unmined`, or all the way to `completed` if the BEEF carries a BUMP); (2) `Monitor.processNewBlockHeader` now nudges `TaskCheckNoSends.checkNow` alongside the existing `TaskCheckForProofs.checkNow` nudge, wiring up the documented-but-orphaned per-block trigger; (3) `StorageProvider.abortAction` chain-checks signed `nosend` txs via `services.getStatusForTxids` and returns `aborted: false` for `mined` or `known` (mempool-aware) txs without throwing; (4) `specOpNoSendActions.postProcess` pre-filters chain-known rows before bulk-abort and honors per-row `aborted: false` returns so race-window rows that became chain-known mid-page leave their status as `nosend` rather than being blanket-set to `failed`. Service-unreachable handling proceeds with the abort and writes an `abortAction-offline-fallback` history note for forensic audit — abort must remain possible when network confirmation is impossible. One residual edge case (backend returns success+`unknown` for a tx that is actually on chain) is documented in the PR; mitigations include the per-block `TaskCheckNoSends` nudge eventually self-healing and caller-side multi-source chain verification.

- Optimization: `TaskCheckNoSends` aging schedule on the block-triggered `checkNow` path. The unfiltered per-block scan would do an unbounded number of external `getMerklePath` lookups per block as a wallet's `nosend` set grows (escrow, un-aborted tests, abandoned batches). The new schedule keys on row age: rows fresher than 5 min are skipped entirely (protecting in-flight batched-tx workflows that chain `createAction({noSend:true, sendWith:[...]})` builds); 5 min – 1 hr rows check on every trigger; older rows progress to `~hourly` (block-height % 6), `~daily` (% 144), and `~weekly` (% 1008) cadences. Each row's modulo offset is keyed by its `provenTxReqId` so same-tier rows are staggered across the cycle (`(blockHeight + provenTxReqId) % tierInterval === 0`) rather than all firing on the same block. The scheduled daily (no-`checkNow`) cadence is unchanged and still scans every row, providing a safety net for externally-broadcast unmined `nosend` txs regardless of age.

## wallet-toolbox 2.1.27

- Add optional `contactSource` (and exported `ContactSource` / `ContactRecord` interfaces) on `WalletArgs` and the `Wallet` class. When provided, `Wallet.discoverByIdentityKey` consults the local contacts source **before** the in-process `_overlayCache` and before any network call; on a hit, the overlay is not queried at all. `Wallet.discoverByAttributes` consults the contact source's optional `findByAttributes` when present. Contact-source failures are swallowed and fall through to the existing network path so the network is never gated on a flaky contact store.
- `Wallet.discoverByIdentityKey` and `Wallet.discoverByAttributes` accept `forceRefresh?: boolean`. When `true`, both the contacts short-circuit and the 2-minute `_overlayCache` are bypassed so the network is consulted fresh — useful for a manual refresh action.
- `identityUtils.parseResults` now yields to the host runtime between certificates on UI runtimes (browser / React Native, detected at call time). On Node the yield is skipped to avoid timer overhead. Same total work; the JS thread no longer owns the frame for the duration of the loop, so menu taps and scroll keep working while a large identity result is parsed.
- `identityUtils.parseResults$` — new async-iterable form that emits each successfully parsed `VerifiableCertificate` as soon as it's ready, for callers that want progressive rendering.
- `queryOverlay` widens the per-call grace window for `ls_identity` queries to 300 ms via the new `LookupQueryOptions.graceMs`, so more in-sync identity hosts contribute outputs before the query resolves.
- `@bsv/sdk` dependency switched to the local workspace via `workspace:^2.1.1` so SDK changes flow through without an intermediate publish. Publish-time tooling rewrites `workspace:` ranges to concrete versions.

## wallet-toolbox 2.1.26

- Fix: auto-evict confirmed-stale inputs after any failed broadcast, regardless of how the broadcaster classifies the failure. When a tx is marked failed, `updateTransactionStatus(failed)` previously restored ALL consumed inputs to `spendable: true` to support transient retry. That's correct for fee/script/malformed failures where inputs are still UTXOs, but wrong for cases where the input has been spent on chain by a different tx — the wallet then picks the same already-spent UTXO on the next createAction → infinite missing-inputs broadcast loop. The new `markStaleInputsAsSpent` helper runs after `updateTransactionsStatus(failed)` and queries `services.isUtxo` per consumed input (concurrently across inputs via `Promise.all`), overriding `spendable: false` only for inputs the chain authoritatively confirms are spent. Inputs still on chain (transient/false-positive failures) keep the existing retry semantics. Service errors leave inputs untouched (eviction is opt-in based on positive evidence). Helper is broadcaster-agnostic — applies to ARC's `doubleSpend` (`SEEN_IN_ORPHAN_MEMPOOL`) and to WhatsOnChain/Bitails `invalidTx` (`missing-inputs`) classifications alike. Pre-broadcast races where concurrent createActions reach the same UTXO across separate app processes remain out of scope; that's a separate class of double-spend with its own design space (TaskReviewUtxos enqueue, locked-input semantics).

## wallet-toolbox 2.1.21

- Fix spending authorization bypass in querySpentSince, PR#150

## wallet-toolbox 2.1.20

- Update cdn.projectbabbage.com valid blockheaders file hash.
-

## wallet-toolbox 2.1.19

- Merge PR#146. GenerateChange change to better handle dust situations. Redundant trimInputBeef knownTxids safety check.
- recovery-key-and-password fix

## wallet-toolbox 2.1.18

- fix provideRecoveryKey guard blocking recovery-key-and-password mode
- set authenticationFlow to existing-user after recovery key token lookup

## wallet-toolbox 2.1.17

- add admin web server for visibility into storage and monitor by operations admin
- add recentlyActiveUsers to StorageProvider with optimized override in StorageKnex

## wallet-toolbox 2.1.16

- update Services getStatusForTxids to internally handle provider batch limit

## wallet-toolbox 2.1.15

- audit fix

## wallet-toolbox 2.1.14

- fix update timestamp on all updated currencies

## wallet-toolbox 2.1.13

- update all supported currencies in single exchangeratesapi.io request.

## wallet-toolbox 2.1.12

- Add fundWalletFromP2PKHOutpoints

## wallet-toolbox 2.1.11

- Add UMP v3 token support with Argon2id password key derivation.
- Introduce `derivePasswordKey()` abstraction that dispatches to Argon2id for v3 tokens and PBKDF2-SHA512 (7777 rounds) for legacy tokens.
- Use `hash-wasm` for password-key derivation support in browser/webview-compatible contexts.
- Extend `UMPToken` with optional `umpVersion` and `passwordKdf` metadata fields.
- Update `buildAndSend` to write v3 KDF metadata fields (`umpVersion`, `kdfAlgorithm`, `kdfParams`) to on-chain tokens.
- Update `parseLookupAnswer`, `serializeUMPToken`, and `deserializeUMPToken` to parse and round-trip v3 KDF metadata.
- Export `ARGON2ID_DEFAULT_*` constants (`iterations`, `memoryKiB`, `parallelism`, `hashLength`).
- Keep legacy token behavior unchanged.

## wallet-toolbox 2.1.10

- TaskReviewUtxos added
- TaskReviewProvenTxs added
- TaskReviewDoubleSpends added
- exchangeratesapi.io api key removed from Services. Defaults changed to rely on public chaintracks service which has private api key.
- Fix bugs in TaskSendWaiting
- Add Task namespace with all monitor tasks exports.
- adminStats now splits out abandoned transactions from failed.
- admin site support changes.

## wallet-toolbox 2.1.9

- Fix batch sending bug in TaskSendWaiting

## wallet-toolbox 2.1.8

- Drop no longer required verifyAndRepairBeef method
- Simplify collectCommission tests in offsetKey.test.ts
- Remove duplicate BulkFileDataReader class.
- Reorg createDefault*ChaintracksOptions to reduce duplicated code.
- Reorg auth-method-interactors
- Flip waitForAuthentication grouped permission request event (now first) and activation (now second)

## wallet-toolbox 2.1.7

- Sonarqube recommended changes...

## wallet-toolbox 2.1.6

- Improve change-making algorithm: cap change outputs per transaction to 8 (gradual UTXO pool build-up, smaller BEEFs). Enforce dynamic dust floor so no change output is worth less than 2× the fee to spend it.

## wallet-toolbox 2.1.5

- Update deps, docs, lint

## wallet-toolbox 2.1.4

- Change `Monitor`: Add SSE event hooks.
- Add `ArcSSEClient` to drive SSE event hooks on mobile

## wallet-toolbox 2.1.3

- Change `Monitor`: no retry for invalid beefs in TaskSendWaiting. Cleanup logging.

## wallet-toolbox 2.1.2

- Fix Chaintracks no longer hangs if bulk ingestor fails to reach chain tip.

## wallet-toolbox 2.1.1

### Add `teratest` and `mock` chain types

- Change `Chain` type from `'main' | 'test'` to `'main' | 'test' | 'teratest' | 'mock'`.

**`teratest` chain:**

- Add ARC URL `https://arc-teratest.taal.com` for the teratest network.
- Chaintracks URL follows existing `${chain}net-chaintracks.babbage.systems` pattern.
- WhatsOnChain URL follows existing `https://api.whatsonchain.com/v1/bsv/${network}` pattern.
- Bitails is not available on teratest (only `main` and `test`).

**`mock` chain — full self-contained mock blockchain:**

- Add new `src/mockchain/` module with `MockServices`, `MockChainTracker`, `MockMiner`, `MockChainStorage`, and merkle tree utilities.
- `MockServices` implements the `WalletServices` interface against a local SQLite database (3 tables: `mockchain_block_headers`, `mockchain_transactions`, `mockchain_utxos`).
- Transactions are validated with full script execution via `@bsv/sdk` `Transaction.verify()`.
- Coinbase maturity rule enforced (100 block confirmations required before spending).
- On-demand block mining via `MockServices.mineBlock()`.
- Chain reorganization simulation via `MockServices.reorg()` with `txidMap` for controlling which transactions land in which new blocks.
- Add `TaskMineBlock` monitor task for periodic mining (10 minutes) with `mineNow` static flag for on-demand triggering.
- `Monitor.services` type widened from `Services` to `Services | WalletServices` to support mock chain.
- `Services` class, `createDefaultWalletServicesOptions`, and external service providers (`WhatsOnChain`, `Bitails`) throw explicit errors if instantiated with `'mock'` chain.

**Explicit chain handling across codebase:**

- Convert chain-dependent ternaries to explicit switch statements in `toWalletNetwork`, `genesisHeader`, `Bitails` constructor, WoC WebSocket ingestors, and `ChaintracksStorageNoDb`.
- Each chain value (`main`, `test`, `teratest`, `mock`) is handled explicitly rather than falling through a catch-all else branch.

## wallet-toolbox 2.0.24

Optimize createAction (fewer db transactions)
Add postBeef services soft timeout failover
PR 130 randomBytesHex in Setup

## wallet-toolbox 2.0.23

Add output table indices to speed up listOutputs and createAction

## wallet-toolbox 2.0.20

Add BRC-115 new manifest specs to support group and counterparty permissions.

## wallet-toolbox 2.0.19

Add BRC-114 action time labels for filtering actions by creation time.

## wallet-toolbox 2.0.18

Update bsv/auth-express-middleware 2.0.4

## wallet-toolbox 2.0.17

Update @bsv/sdk to 2.0.4 to fix StorageServer failing from stale AuthFetch sessions.

## wallet-toolbox 2.0.9

Added support for more currency types.

## wallet-toolbox 2.0.8

Add check for cross session signAction errors.

## wallet-toolbox 2.0.7

Add StorageClient.man.test.ts to stress test storage.babbage.systems

## wallet-toolbox 2.0.5

Change sqlite support to better-sqlite3, all tests resolved. Support for existing databases confirmed.

## wallet-toolbox 2.0.4

- Added better group permissions and PACT protocol support
- Added new function for mass revokation of permissions and optimized permission granting flow
- Promise.all!!!

## wallet-toolbox 2.0.3

Hide customInstructions from listActions results.

## wallet-toolbox 2.0.2

Restore upgrade to better-sqlite3

## wallet-toolbox 2.0.0

Update to bsv/sdk 2.0.0

Change sqlite support to better-sqlite3

Changes to improve computing balances (sum of satoshis) over various sets of wallet spendable outputs:

- Added optional ListOutputsArgs argument to Wallet balance method. This enables using the same arguments in a call to listOutputs and balance. This method injects the specOpWalletBalance string constant into the appropriate basket or tag property and returns totalOutputs as its result.
- Fully optimized specOpWalletBalance processing within listOutputsKnex to use SQL sum(satoshis). Much faster than returning arrays of outputs and summing WalletOutput results.
- specOpWalletBalance can now be specified as a ListOutputsArgs tag value. This enables computing sum of satoshis on any basket and with optional tag filtering.
- Implement BRC-112

## wallet-toolbox 1.7.24

- Add full P-label (permissioned label) support per BRC-111 specification.
- Implement P-label format validation: p <moduleId> <payload> with strict parsing rules.
- Updated createAction, internalizeAction, and listActions to handle P-labels with permission module delegation.
- Add comprehensive test coverage for P-label delegation, multi-module chaining, and format validation.
- Added small fix to reject pending promises on grantGroupedPermission error.

## wallet-toolbox 1.7.17

- Fix push.yaml to sync versions, correct root package contents (no mobile), and publish client and mobile

## wallet-toolbox 1.7.15

- Fix specOpInvalidChange to always ignore unbasketted outputs.
- Update dependency to bsv/sdk 1.9.24

## wallet-toolbox 1.7.13

- Fix moreSatoshisNeeded amount in WERR_INSUFFICIENT_FUNDS (was releasing allocated change before saving value).

## wallet-toolbox 1.7.12

- Add pluggable permissions module system (`PermissionsModule` interface) for custom P-basket and P-protocol handlers
- Add `permissionModules` config option to `WalletPermissionsManager` for registering scheme-specific modules
- Support request/response transformation chaining across multiple modules
- Add comprehensive test suite covering P-module delegation, chaining, and error handling

## wallet-toolbox 1.7.11

- Change logging tweaks.

## wallet-toolbox 1.7.6

- Change `WalletLogger` json name from logs[0]

## wallet-toolbox 1.7.5

- Add `WalletLogger` flushFormat property.

## wallet-toolbox 1.7.4

- Really Add `WalletLogger` to package exports (client, and complete).

(Still have to update top level index.all importing index.client importing index.mobile).

## wallet-toolbox 1.7.3

- Add `WalletLogger` to package exports (mobile, client, and complete).

## wallet-toolbox 1.7.2

- Add `WalletLogger` aggregate logger class for use by `Wallet`, `StorageClient` and `StorageServer`,
  implementing the `WalletLoggerInterface` released in latest `@bsv/sdk`.
- Delete `validationHelpers.ts` from `sdk` folder and update code to reference functions and types moved to
  `Validation` namespace exported from `@bsv/sdk`.

## wallet-toolbox 1.7.1

- Add optional skipInvalidProofs to StorageGetBeefOptions

## wallet-toolbox 1.7.0

- Update dependency to @bsv/sdk 1.9.3, makinig this new version a minor bump as well
- Add optional chaintracker to StorageGetBeefOptions
- Add WERR_INVALID_MERKLE_ROOT exception (code 8).
- Change add spendable value to WERR_INVALID_PARAMETER message thrown by createAction

## wallet-toolbox 1.6.43

- Change WERR toJson methods to add code property for HTTPWalletJSON rethrow support.

## wallet-toolbox 1.6.42

- Change WalletPermissionsManager changes

## wallet-toolbox 1.6.41

- Change WalletPermissionsManager changes

## wallet-toolbox 1.6.40

- Change correct import of WERR_REVIEW_ACTIONS in createActions.ts to wallet-toolbox package.

## wallet-toolbox 1.6.39

- Change WalletError unknownToJson error to resolve unknown toJson error.

## wallet-toolbox 1.6.38

- Update to @bsv/sdk 1.8.10

## wallet-toolbox 1.6.37

- Change validationHelpers validateBase64String now polynomial time, sync changes on bsv/sdk
- Change log throw of dummy WERR_REVIEW_ACTIONS.

## wallet-toolbox 1.6.35

- Change specOp WERR_REVIEW_ACTIONS throw to storage layer.

## wallet-toolbox 1.6.34

- Change StorageServer / StorageClient to rethrow WERR errors including WERR_REVIEW_ACTIONS
- Change ChaintracksChainTracker to default to new public services.
- Add WalletError.test.ts and resolve issues related to WERR_errors
- Add retry support to ChaintracksFetch download method to handle WoC rate limits.

## wallet-toolbox 1.6.33

- Add schema migration: outputs spendable index.

## wallet-toolbox 1.6.31

- Change throw WERR_REVIEW_ACTIONS if an input's spentBy is valid

## wallet-toolbox 1.6.30

- Add txid index to proven_tx_reqs table in storage knex schema

## wallet-toolbox 1.6.29

- Add txid index to transactions table in storage knex schema

## wallet-toolbox 1.6.28

- Fix The method `Services`.`getHeaderForHeight` must serialize four byte values LE

## wallet-toolbox 1.6.27

- Change internalizeAction Improve handling of atomic beefs containing transactions unknown to storage.

## wallet-toolbox 1.6.26

- Update to @bsv/sdk 1.8.2

## wallet-toolbox 1.6.25

- Change `WalletPermissionsManager` coalescePermissionTokens logic

## wallet-toolbox 1.6.24

- Add Monitor TaskReorg to handle Chaintracks reorg events, updating ProvenTxs with new merkle proofs.
- Add deactivatedHeaders as optional 4th param to `ReorgListener` in `ChaintracksClientApi`
- Add `ChaintracksStorageApi` `InsertHeaderResult` now includes deactivatedHeaders
- Add `createKnexChaintracks` exported function.
- Add `createNoDbChaintracks` exported function.
- Add `index.mobile.ts` to Chaintracks

- Change `validBulkHeaderFilesByFileHash` updated for 2025-10-06 Babbage CDN update.

## wallet-toolbox 1.6.22

- Change verifyTruthy => validateSatoshis during input validation for createAction.

## wallet-toolbox 1.6.20

- Add DevConsoleInteractor

## wallet-toolbox 1.6.6

- Add robots.txt to StorageServer

## wallet-toolbox 1.6.5

- Add ChaintracksStorageIdb to support in browser header storage.
- Cleanup createDefaultWalletServicesOptions, add comments.
- Some breaking API changes to Chaintracks storage and ingestors.

## wallet-toolbox 1.6.4

- Resolve client dependencies for metanet-desktop, exclude ChaintracksService and Ws ingestors.

## wallet-toolbox 1.6.3

- Resolve client dependencies for metanet-desktop

## wallet-toolbox 1.6.2

- Change defaul chaintracksUrl from npm-registry.babbage.systems to ${chain}net-chaintracks.babbage.systems

## wallet-toolbox 1.6.1

- Add initial port/re-implementation of Chaintracks

## wallet-toolbox 1.5.21

- Add support for listOutputs with negative offsets. (Sorts newest first, offset -1 is newest output).

## wallet-toolbox 1.5.10

- Add automatic request timeouts and deprioritization of postBeef services.

## wallet-toolbox 1.5.7

- One-off authorizations are no longer cached, ensuring they can only be used once.

## wallet-toolbox 1.5.0

- update to @bsv/sdk 1.6.8 and @bsv/auth-express-middleware 1.2.0 (Which include VarInt support for negative numbers, making it a breaking change)

## wallet-toolbox 1.4.10

- when spending non-change outputs, atomically tests spendable before setting to spent.
- change unbasketted new outputs to spendable
- updated WalletStorageManager to use lockQueues for read/write/sync/sp scheduling

## wallet-toolbox 1.4.7

- update to bsv/sdk 1.6.5
- add BHSServiceClient which allows for leaning on BlockHeadersService for chain tracking.
- add ARC callbackURL and callbackToken to createDefaultWalletServiceOptions

## wallet-toolbox 1.4.?

- Only check for proofs when TaskNewHeader sets checkNow, tightens up control of required delay.

## wallet-toolbox 1.4.3

- update monitor logging

## wallet-toolbox 1.4.2

- update monitor TaskNewHeader, TaskCheckForProofs to ignore bleeding edge new blocks and proofs.

## wallet-toolbox 1.4.1

- update to bsv/sdk 1.6.0 with reworked bignum and memory / performance improvements.

## wallet-toolbox 1.3.32

- add permissions caching (5 minutes)

## wallet-toolbox 1.3.30

- Enable gorillaPoolArc for postBeef Services
- Switch Services postBeef multi-service mode from 'PromiseAll' to 'UntilSuccess'

## wallet-toolbox 1.3.29

- add verifyUnlockScripts to both createAction and signAction flows

## wallet-toolbox 1.3.28

- adminStats now includes monitorStats and servicesStats of type ServicesCallHistory (wallet-toolbox/src/sdk/WalletServices.interfaces.ts)
- both sets of stats break down service calls by providers including both recent calls and interval based statistics.
- monitorStats correspond to service requests made by the active Monitor daemon. This includes “delayed” createActions. Intervals are currently 12 minutes.
- servicesStats corresponds to the service requests made by the StorageProvider service. This includes “non-delayed” createActions. Intervals are determined by rate of calls to adminStats, each call starts a new interval.

## wallet-toolbox 1.3.25

- throws INVALID_PARAMETER if a createAction input is a change output.
- logging and potential fix for internalizeAction bug.
- adds gorillaPool to Services but leaves it disabled for now.
- adds service call history logging to Monitor Events table, but not yet tied in to adminStats return value.
- StorageProvider level “find” entity methods now support additional optional orderDescending boolean.

## wallet-toolbox v1.3.4, 2025-04-24

### Add StorageIdb

Adds support for `indexedDB` based wallet storage via the new `StorageIdb` `StorageProvider` class and a new `SetupClient` class.

## wallet-toolbox v1.3.0, 2025-04-23

### Change in Handling of New Outputs NOT Assigned to a Basket

New outputs created by `createAction` / `signAction` that are NOT assigned to a basket are considered immediately SPENT.

Implications:

- Outputs transferred to a second party, either through internalizeAction or custom means, MUST NOT be assigned to a basket
  as this allows them to be spent without your wallet being notified that they are no longer spendable. This is a usage guideline, it is not enforced.
- These outputs will NOT be returned by `listOutputs`, as it only returns spendable outputs.
- These outputs WILL be returned by `listActions` with the includeOutputs option set to true.
- Your wallet will mark any output you include as inputs in your own transactions as spent at the time of transaction creation.
- If a created transaction subsequently fails to be broadcast (abandoned or invalid), the outputs are reset to spendable. This may not happen immediately.
