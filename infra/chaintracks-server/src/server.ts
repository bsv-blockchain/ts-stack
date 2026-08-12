/**
 * ChaintracksService with Custom Configuration
 *
 * This example demonstrates advanced configuration including:
 * - Custom Chaintracks instance with specific options
 * - Custom Services configuration
 * - WhatsOnChain API key configuration
 * - Custom bulk/live ingestor settings
 * - Event subscriptions (header and reorg listeners)
 * - V1 and V2 API routes
 */

import {
  BlockHeader,
  Chaintracks,
  createDefaultNoDbChaintracksOptions,
  Services,
  Chain,
  ChaintracksFs,
  GoChaintracksServiceClient
} from '@bsv/wallet-toolbox'
import * as WalletToolbox from '@bsv/wallet-toolbox'
import * as path from 'node:path'
import * as express from 'express'
import * as bodyParser from 'body-parser'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { rateLimit } from 'express-rate-limit'
import { createV1Routes } from './v1-routes'
import { createV2Routes } from './v2-routes'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { log } from './logger'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  configureHttpServer,
  corsPolicy,
  initialDoubleSlashCompatibility,
  profileValue,
  readBodyLimitBytes,
  readResourceLimit,
  readResourceProfile,
  responseSizeLimit,
  securityHeaders
} from './security/edgePolicy'
import { configureTrustProxy, rateLimitOptions } from './security/rateLimitPolicy'
import { BulkHeaderSnapshotPublisher } from './BulkHeaderSnapshotPublisher'

const tracer = trace.getTracer('chaintracks-server')

type ConfiguredChain = 'main' | 'test' | 'stn' | 'ttn' | 'tstn'

const supportedChains = new Set<ConfiguredChain>(['main', 'test', 'stn', 'ttn', 'tstn'])

function resolveChain(): ConfiguredChain {
  const configured = (process.env.CHAIN || 'main').trim() as ConfiguredChain
  if (!supportedChains.has(configured)) {
    throw new Error('CHAIN must be "main", "test", "stn", "ttn", or "tstn"')
  }
  return configured
}

function stripTrailingSlash(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end--
  return value.slice(0, end)
}

function defaultArcadeUrl(chain: ConfiguredChain): string | undefined {
  switch (chain) {
    case 'main':
      return 'https://arcade-v2-us-1.bsvblockchain.tech'
    case 'test':
      return 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'
    case 'ttn':
      return 'https://arcade-v2-ttn-us-1.bsvblockchain.tech'
    case 'stn':
      return process.env.STN_ARCADE_URL?.trim() || process.env.STN_CHAINTRACKS_URL?.trim()
    case 'tstn':
      return process.env.TSTN_ARCADE_URL?.trim() || process.env.TSTN_CHAINTRACKS_URL?.trim()
  }
}

function resolveUpstreamChaintracks(
  chain: ConfiguredChain
): GoChaintracksServiceClient | undefined {
  const configured = process.env.CHAINTRACKS_UPSTREAM_URL?.trim()
  if (configured === 'disabled' || configured === 'none') return undefined
  const serviceUrl = stripTrailingSlash(configured || defaultArcadeUrl(chain) || '')
  if (serviceUrl === '') return undefined
  if (/\/v1$/i.test(new URL(serviceUrl).pathname)) {
    throw new Error(
      'CHAINTRACKS_UPSTREAM_URL must expose go-chaintracks v2; legacy v1 has no SSE stream.'
    )
  }

  let apiPrefix = process.env.CHAINTRACKS_UPSTREAM_API_PREFIX?.trim()
  if (apiPrefix == null || apiPrefix === '') {
    apiPrefix = /\/v2$/i.test(new URL(serviceUrl).pathname) ? '' : '/chaintracks/v2'
  }
  return new GoChaintracksServiceClient(chain as Chain, serviceUrl, {
    apiPrefix
  })
}

function resolveRoutingPrefix(): string {
  const value = (process.env.ROUTING_PREFIX || '').trim()
  if (value === '' || value === '/') return ''
  if (
    !value.startsWith('/') ||
    value.includes('..') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw new Error(
      'ROUTING_PREFIX must be an absolute URL path without query, fragment, or parent traversal.'
    )
  }
  return stripTrailingSlash(value)
}

function resolveBulkHeadersPath(): string {
  const raw = process.env.BULK_HEADERS_PATH || path.join(process.cwd(), 'public', 'headers')
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw)
}

function createServices(chain: ConfiguredChain, chaintracks: Chaintracks): Services | undefined {
  // Keep the standalone source buildable against the currently published
  // toolbox while adopting the additive 2.8 factory immediately after the
  // protected dependency-lock reconciliation.
  const factory = (
    WalletToolbox as unknown as {
      createDefaultWalletServicesOptions?: (
        chain: Chain,
        ...options: unknown[]
      ) => ConstructorParameters<typeof Services>[0]
    }
  ).createDefaultWalletServicesOptions
  if (factory != null) {
    return new Services(
      factory(
        chain as Chain,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        chaintracks
      )
    )
  }
  // Older releases predate STN in the public Chain union. Those deployments
  // retain their exact Services construction until the lock is reconciled.
  return chain === 'stn' ? undefined : new Services(chain as Chain)
}

async function ensureBulkHeadersDir(bulkHeadersPath: string): Promise<void> {
  try {
    const fs = await import('node:fs/promises')
    await fs.mkdir(bulkHeadersPath, { recursive: true })
    log.info(
      { operation: 'bulk_headers.dir_ensure', outcome: 'ok', bulk_headers_path: bulkHeadersPath },
      'Bulk headers directory ready'
    )
  } catch (error) {
    log.error(
      {
        operation: 'bulk_headers.dir_ensure',
        outcome: 'error',
        bulk_headers_path: bulkHeadersPath,
        err: error
      },
      'Failed to create bulk headers directory'
    )
    throw error
  }
}

function resilientBulkRuntimeAvailable(): boolean {
  const runtime = WalletToolbox as unknown as {
    DurableFileBulkFileDownloadBudget?: unknown
    NodeBulkFileDataValidator?: unknown
  }
  return (
    runtime.DurableFileBulkFileDownloadBudget != null && runtime.NodeBulkFileDataValidator != null
  )
}

function createBulkFileCache(rootFolder: string, resilientRuntime: boolean): unknown {
  const Cache = (
    WalletToolbox as unknown as {
      BulkFileDataCacheFs?: new (
        options: string | { rootFolder: string; legacyRoots: string[] }
      ) => unknown
    }
  ).BulkFileDataCacheFs
  if (Cache == null) return undefined
  return resilientRuntime
    ? new Cache({ rootFolder: path.join(rootFolder, 'cache'), legacyRoots: [rootFolder] })
    : new Cache(rootFolder)
}

function createBulkFileDownloadBudget(
  maxBytes: number,
  rootFolder: string,
  resilientRuntime: boolean
): unknown {
  if (!resilientRuntime) {
    const Budget = (
      WalletToolbox as unknown as {
        FixedWindowBulkFileDownloadBudget?: new (options: { maxBytes: number }) => unknown
      }
    ).FixedWindowBulkFileDownloadBudget
    return Budget == null ? undefined : new Budget({ maxBytes })
  }
  const Budget = (
    WalletToolbox as unknown as {
      DurableFileBulkFileDownloadBudget?: new (options: {
        maxBytes: number
        stateFile: string
      }) => unknown
    }
  ).DurableFileBulkFileDownloadBudget
  if (Budget == null) throw new Error('The resilient bulk runtime is incomplete.')
  return new Budget({
    maxBytes,
    stateFile: path.join(rootFolder, 'state', 'download-budget.json')
  })
}

function createBulkFileDataValidator(resilientRuntime: boolean): unknown {
  if (!resilientRuntime) return undefined
  const Validator = (
    WalletToolbox as unknown as {
      NodeBulkFileDataValidator?: new (options: { maxWorkers: number; maxQueue: number }) => unknown
    }
  ).NodeBulkFileDataValidator
  if (Validator == null) throw new Error('The resilient bulk runtime is incomplete.')
  return new Validator({
    maxWorkers: Number.parseInt(process.env.CHAINTRACKS_VALIDATION_WORKERS || '1', 10),
    maxQueue: Number.parseInt(process.env.CHAINTRACKS_VALIDATION_QUEUE_MAX || '8', 10)
  })
}

async function main() {
  const chain = resolveChain()
  const resourceProfile = readResourceProfile('CHAINTRACKS')
  const port = Number.parseInt(process.env.PORT || '3011', 10)
  const cdnPort = port + 1 // CDN runs on next port
  const whatsonchainApiKey = process.env.WHATSONCHAIN_API_KEY || ''

  // SOURCE_CDN_URL: Remote CDN to download headers FROM (if local files don't exist)
  const defaultSourceCdnUrl =
    chain === 'main' || chain === 'test' ? 'https://cdn.projectbabbage.com/blockheaders/' : ''
  const sourceCdnUrl = process.env.SOURCE_CDN_URL ?? defaultSourceCdnUrl
  const upstreamChaintracks = resolveUpstreamChaintracks(chain)
  const routingPrefix = resolveRoutingPrefix()

  const enableBulkHeadersCDN = process.env.ENABLE_BULK_HEADERS_CDN === 'true'

  // CDN_HOST_URL: Public URL where THIS server's CDN is accessible (written to JSON rootFolder)
  const cdnHostUrl = process.env.CDN_HOST_URL || `http://localhost:${cdnPort}`

  const bulkHeadersPath = resolveBulkHeadersPath()
  const bulkHeaderSnapshotPublisher = new BulkHeaderSnapshotPublisher({
    rootFolder: bulkHeadersPath,
    chain,
    maxGenerations: 3
  })
  const bulkFileCacheEnabled = process.env.CHAINTRACKS_BULK_FILE_CACHE !== 'false'
  const resilientBulkRuntime = resilientBulkRuntimeAvailable()
  const upstreamDownloadMaxBytesPerHour = readResourceLimit(
    'CHAINTRACKS',
    'UPSTREAM_DOWNLOAD_MAX_BYTES_PER_HOUR',
    profileValue(resourceProfile, {
      small: 128 * 1024 * 1024,
      standard: 512 * 1024 * 1024,
      highThroughput: 2 * 1024 * 1024 * 1024
    })
  )
  const bulkFileDownloadBudget =
    upstreamDownloadMaxBytesPerHour === -1
      ? undefined
      : createBulkFileDownloadBudget(
          upstreamDownloadMaxBytesPerHour,
          bulkHeadersPath,
          resilientBulkRuntime
        )
  await (bulkFileDownloadBudget as { initialize?: () => Promise<void> } | undefined)?.initialize?.()
  const bulkFileCache = bulkFileCacheEnabled
    ? createBulkFileCache(bulkHeadersPath, resilientBulkRuntime)
    : undefined
  const bulkFileDataValidator = createBulkFileDataValidator(resilientBulkRuntime)

  // The source URL is where clients can download headers from (the CDN HTTP endpoint)
  const bulkHeadersSourceUrl = enableBulkHeadersCDN ? cdnHostUrl : undefined

  const bulkHeadersAutoExportInterval = Number.parseInt(
    process.env.BULK_HEADERS_AUTO_EXPORT_INTERVAL || '240000000',
    10
  ) // Default: 400 blocks around 67 hours

  log.info(
    {
      operation: 'config.summary',
      chain: `${chain}Net`,
      port,
      whatsonchain_api_key_configured: Boolean(whatsonchainApiKey),
      whatsonchain_fallback_enabled: chain === 'main' || chain === 'test',
      upstream_chaintracks_configured: upstreamChaintracks != null,
      routing_prefix: routingPrefix || '/',
      bulk_headers_cdn_enabled: enableBulkHeadersCDN,
      bulk_file_cache_enabled: bulkFileCacheEnabled,
      bulk_file_cache_active: bulkFileCache != null,
      resilient_bulk_runtime_active: resilientBulkRuntime,
      bulk_file_validation_workers: process.env.CHAINTRACKS_VALIDATION_WORKERS || '1',
      bulk_file_validation_queue_max: process.env.CHAINTRACKS_VALIDATION_QUEUE_MAX || '8',
      upstream_download_max_bytes_per_hour: upstreamDownloadMaxBytesPerHour
    },
    'Starting ChaintracksService with custom configuration'
  )
  if (enableBulkHeadersCDN || bulkFileCacheEnabled) {
    await ensureBulkHeadersDir(bulkHeadersPath)
  }
  if (enableBulkHeadersCDN) {
    log.info(
      {
        operation: 'config.cdn',
        cdn_port: cdnPort,
        cdn_host_url: cdnHostUrl,
        bulk_headers_path: bulkHeadersPath
      },
      'Bulk headers CDN configuration'
    )
  }

  // Create custom Chaintracks options
  // This allows fine-tuning of storage, ingestors, and sync behavior
  // The standalone image intentionally compiles against the currently
  // published toolbox. Additive source options become active after the
  // protected package release and dependency-lock reconciliation.
  const createOptions = createDefaultNoDbChaintracksOptions as unknown as (
    ...args: unknown[]
  ) => ReturnType<typeof createDefaultNoDbChaintracksOptions>
  const chaintracksOptions = createOptions(
    chain as Chain,
    whatsonchainApiKey, // WhatsOnChain API key for better rate limits
    100000, // maxPerFile: Headers per bulk file (100k)
    2, // maxRetained: Number of bulk files to retain in memory
    undefined, // fetch: Use default ChaintracksFetch
    sourceCdnUrl, // SOURCE_CDN_URL: Remote CDN to download headers FROM (fallback if local files don't exist)
    2000, // liveHeightThreshold: Headers within this distance are "live"
    400, // reorgHeightThreshold: Max reorg depth to handle
    500, // bulkMigrationChunkSize: Batch size for migrations
    400, // batchInsertLimit: Max headers to insert in one batch
    36, // addLiveRecursionLimit: Max depth to recursively fetch missing headers
    {
      chaintracks: upstreamChaintracks,
      disableChaintracks: upstreamChaintracks == null,
      remoteMaxHeadersPerRequest: Number.parseInt(
        process.env.CHAINTRACKS_UPSTREAM_MAX_HEADERS || '1000',
        10
      ),
      disableCdn: sourceCdnUrl === '',
      disableWhatsOnChain: process.env.CHAINTRACKS_DISABLE_WHATSONCHAIN === 'true',
      bulkFileCache,
      bulkFileDownloadBudget,
      bulkFileDataValidator
    }
  )

  // Create Chaintracks instance with custom options
  const chaintracks = new Chaintracks(chaintracksOptions)

  // Track last exported height to trigger exports at 100k marks
  let lastExportedHeight = await bulkHeaderSnapshotPublisher.currentMaxHeight()
  let isExporting = false

  // Function to export bulk headers
  const exportBulkHeaders = async () => {
    if (!enableBulkHeadersCDN) {
      log.info(
        { operation: 'headers.export', outcome: 'skipped', reason: 'cdn_disabled' },
        'Bulk headers CDN is disabled, skipping export'
      )
      return
    }

    if (isExporting) {
      log.info(
        { operation: 'headers.export', outcome: 'skipped', reason: 'in_progress' },
        'Export already in progress, skipping'
      )
      return
    }

    try {
      isExporting = true
      log.info({ operation: 'headers.export' }, 'Checking if export is needed')

      const currentHeight = await chaintracks.currentHeight()

      // Check if we've crossed a 100k boundary
      const currentMilestone = Math.floor(currentHeight / 100000)
      const lastMilestone =
        lastExportedHeight == null ? -1 : Math.floor(lastExportedHeight / 100000)

      const shouldExport = lastExportedHeight == null || currentMilestone > lastMilestone
      log.info(
        {
          operation: 'headers.export',
          current_height: currentHeight,
          last_exported_height: lastExportedHeight,
          current_milestone: currentMilestone,
          last_milestone: lastMilestone,
          should_export: shouldExport
        },
        'Evaluated export need'
      )

      if (shouldExport) {
        log.info(
          {
            operation: 'headers.export',
            bulk_headers_path: bulkHeadersPath,
            source_url: bulkHeadersSourceUrl
          },
          'Exporting bulk headers'
        )

        const snapshot = await bulkHeaderSnapshotPublisher.publish(async folder => {
          await chaintracks.exportBulkHeaders(
            folder,
            ChaintracksFs,
            bulkHeadersSourceUrl, // sourceUrl - sets rootFolder in the JSON metadata file
            100000, // headersPerFile
            undefined // maxHeight (export all available)
          )
        })

        lastExportedHeight = snapshot.maxHeight
        log.info(
          {
            operation: 'headers.export',
            outcome: 'ok',
            bulk_headers_path: snapshot.folder,
            generation: snapshot.generation,
            file_count: snapshot.fileCount,
            download_url: `${bulkHeadersSourceUrl}/${chain}NetBlockHeaders.json`
          },
          'Bulk headers exported successfully'
        )
      } else {
        log.info(
          { operation: 'headers.export', outcome: 'skipped', reason: 'no_boundary_crossed' },
          'No export needed'
        )
      }
    } catch (error) {
      log.error(
        { operation: 'headers.export', outcome: 'error', err: error },
        'Error exporting bulk headers'
      )
    } finally {
      isExporting = false
    }
  }

  // Subscribe to new block header events
  // This allows you to react to new blocks in real-time
  const headerSubscriptionId = await chaintracks.subscribeHeaders(async (header: BlockHeader) => {
    log.info(
      {
        operation: 'header.received',
        height: header.height,
        hash: header.hash,
        timestamp: new Date(header.time * 1000).toISOString()
      },
      'New block header received'
    )

    // Check if we should export headers (non-blocking)
    if (enableBulkHeadersCDN) {
      exportBulkHeaders().catch(err =>
        log.error(
          { operation: 'headers.export', outcome: 'error', context: 'background', err },
          'Background export error'
        )
      )
    }
  })

  // Subscribe to blockchain reorganization events
  // Important for handling chain reorgs properly
  const reorgSubscriptionId = await chaintracks.subscribeReorgs(
    async (
      depth: number,
      oldTip: BlockHeader,
      newTip: BlockHeader,
      deactivated?: BlockHeader[]
    ) => {
      log.info(
        {
          operation: 'reorg.detected',
          reorg_depth: depth,
          old_tip_hash: oldTip.hash,
          old_tip_height: oldTip.height,
          new_tip_hash: newTip.hash,
          new_tip_height: newTip.height,
          deactivated_hashes:
            deactivated && deactivated.length > 0 ? deactivated.map(h => h.hash) : []
        },
        'Blockchain reorganization detected'
      )
    }
  )

  log.info(
    { operation: 'subscribe.headers', outcome: 'ok', subscription_id: headerSubscriptionId },
    'Subscribed to header events'
  )
  log.info(
    { operation: 'subscribe.reorgs', outcome: 'ok', subscription_id: reorgSubscriptionId },
    'Subscribed to reorg events'
  )

  // Create custom Services instance
  // This allows configuring which BSV network services to use
  // Note: Services uses the chain parameter to configure network services
  const services = createServices(chain, chaintracks)

  // Create Express app with both v1 and v2 routes
  const app = express.default()
  configureTrustProxy(app)
  app.disable('x-powered-by')
  app.use(initialDoubleSlashCompatibility)
  app.use(securityHeaders({ environmentPrefix: 'CHAINTRACKS' }))
  app.use(
    corsPolicy({
      environmentPrefix: 'CHAINTRACKS',
      methods: ['GET', 'POST', 'OPTIONS']
    })
  )

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  eventLoopDelay.enable()
  let eventLoopDelayMaxMsecs = 0
  const eventLoopSampleInterval = setInterval(() => {
    eventLoopDelayMaxMsecs = eventLoopDelay.max / 1_000_000
    eventLoopDelay.reset()
  }, 1000)
  eventLoopSampleInterval.unref()

  const healthHandler = (_req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ status: 'ok', profile: resourceProfile, eventLoopDelayMaxMsecs })
  }
  const readinessHandler = async (_req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store')
    const snapshotProvider = (
      chaintracks as unknown as {
        getAvailabilitySnapshot?: () => {
          available: boolean
          startupError?: string
          presentHeight?: number
          [key: string]: unknown
        }
      }
    ).getAvailabilitySnapshot
    const snapshot =
      snapshotProvider == null
        ? {
            available: await chaintracks.isListening(),
            compatibilityMode: true,
            resilientBulkRuntimeActive: false
          }
        : snapshotProvider.call(chaintracks)
    const ready = snapshot.available && snapshot.startupError == null
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'starting',
      height: snapshot.presentHeight,
      eventLoopDelayMaxMsecs,
      snapshot
    })
  }

  // Probes are local and constant-time, and intentionally bypass public
  // admission middleware. The optional routed aliases preserve deployments
  // that mount the API under a prefix.
  app.get('/healthz', healthHandler)
  app.get('/readyz', readinessHandler)
  if (routingPrefix !== '') {
    app.get(`${routingPrefix}/healthz`, healthHandler)
    app.get(`${routingPrefix}/readyz`, readinessHandler)
  }
  app.use(
    concurrencyLimit(
      'CHAINTRACKS',
      profileValue(resourceProfile, {
        small: 32,
        standard: 64,
        highThroughput: 256
      })
    )
  )

  // Body parser for POST requests
  app.use(
    bodyParser.json({
      limit: readBodyLimitBytes('CHAINTRACKS', 256 * 1024)
    })
  )
  app.use(bodyParserErrorHandler)
  app.use(
    responseSizeLimit(
      'CHAINTRACKS',
      profileValue(resourceProfile, {
        small: 1024 * 1024,
        standard: 4 * 1024 * 1024,
        highThroughput: 32 * 1024 * 1024
      })
    )
  )

  const apiRouter = express.Router()
  const historicalQueryLimit = rateLimit(
    rateLimitOptions('CHAINTRACKS_HISTORICAL_RATE_LIMIT', {
      windowMs: 60_000,
      limit: profileValue(resourceProfile, {
        small: 120,
        standard: 600,
        highThroughput: 3_000
      })
    })
  )
  const historicalConcurrencyLimit = concurrencyLimit(
    'CHAINTRACKS_HISTORICAL',
    profileValue(resourceProfile, { small: 2, standard: 8, highThroughput: 32 })
  )
  apiRouter.use(
    ['/findHeaderHexForHeight', '/getHeaders'],
    historicalConcurrencyLimit,
    historicalQueryLimit
  )
  apiRouter.use(
    ['/v2/header/height', '/v2/headers'],
    historicalConcurrencyLimit,
    historicalQueryLimit
  )

  // Root endpoint
  apiRouter.get('/', (_req: express.Request, res: express.Response) => {
    res.json({ status: 'success', value: 'chaintracks-server' })
  })

  // Robots.txt
  app.get('/robots.txt', (_req: express.Request, res: express.Response) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n')
  })

  // Mount v1 routes (RPC-style, original API)
  const v1Routes = createV1Routes({ chaintracks, services, chain })
  apiRouter.use('/', v1Routes)

  // Mount v2 routes (RESTful, go-chaintracks compatible)
  const v2Routes = createV2Routes(chaintracks)
  apiRouter.use('/v2', v2Routes)
  app.use(routingPrefix || '/', apiRouter)

  // Start the API server
  const apiServer = app.listen(port, () => {
    log.info(
      { operation: 'listen', outcome: 'ok', port, chain: `${chain}Net` },
      'API server running'
    )
  })
  configureHttpServer(apiServer, 'CHAINTRACKS', {
    requestTimeoutMs: 30_000,
    headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 5_000,
    socketTimeoutMs: 30_000,
    maxRequestsPerSocket: 1_000
  })

  // Start a separate CDN server for bulk headers if enabled
  let cdnServer: any
  if (enableBulkHeadersCDN) {
    const cdnPort = port + 1 // Use next port for CDN
    const cdnApp = express.default()
    cdnApp.disable('x-powered-by')
    cdnApp.use(securityHeaders({ environmentPrefix: 'CHAINTRACKS_CDN' }))
    cdnApp.use(
      corsPolicy({
        environmentPrefix: 'CHAINTRACKS_CDN',
        methods: ['GET', 'HEAD', 'OPTIONS']
      })
    )
    cdnApp.use(concurrencyLimit('CHAINTRACKS_CDN', 100))

    // Serve static files from the bulk headers directory
    cdnApp.use(
      '/',
      express.static(bulkHeaderSnapshotPublisher.activeFolder, {
        setHeaders: (res: any, filePath: string) => {
          // Set appropriate headers for bulk header files
          if (filePath.endsWith('.headers')) {
            res.setHeader('Content-Type', 'application/octet-stream')
          } else if (filePath.endsWith('.json')) {
            res.setHeader('Content-Type', 'application/json')
          }
          res.setHeader('Cache-Control', 'public, max-age=3600')
        }
      })
    )
    // During the first migration boot, serve only the last legacy snapshot's
    // flat public files. New cache, quarantine, generation, and state folders
    // are never reachable through the CDN listener.
    cdnApp.get(
      '/:fileName',
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const fileName = req.params.fileName
        if (typeof fileName !== 'string') {
          next()
          return
        }
        if (
          fileName !== `${chain}NetBlockHeaders.json` &&
          !new RegExp(String.raw`^${chain}Net_[0-9]+\.headers$`).test(fileName)
        ) {
          next()
          return
        }
        res.setHeader(
          'Content-Type',
          fileName.endsWith('.headers') ? 'application/octet-stream' : 'application/json'
        )
        res.setHeader('Cache-Control', 'public, max-age=3600')
        res.sendFile(path.join(bulkHeadersPath, fileName), error => {
          if (error != null) next(error)
        })
      }
    )

    cdnServer = cdnApp.listen(cdnPort, () => {
      log.info(
        {
          operation: 'cdn.listen',
          outcome: 'ok',
          cdn_port: cdnPort,
          access_url: `http://localhost:${cdnPort}/mainNetBlockHeaders.json`
        },
        'Bulk Headers CDN server running'
      )
    })
    configureHttpServer(cdnServer, 'CHAINTRACKS_CDN', {
      requestTimeoutMs: 5 * 60 * 1000,
      headersTimeoutMs: 10_000,
      keepAliveTimeoutMs: 5_000,
      socketTimeoutMs: 5 * 60 * 1000,
      maxRequestsPerSocket: 1_000
    })
  }

  // Perform initial export if CDN is enabled
  if (enableBulkHeadersCDN) {
    log.info(
      { operation: 'headers.export', context: 'initial' },
      'Performing initial bulk headers export'
    )
    await exportBulkHeaders()
  }

  // Set up periodic export check (every 10 minutes by default)
  let exportInterval: NodeJS.Timeout | undefined
  if (enableBulkHeadersCDN) {
    exportInterval = setInterval(() => {
      exportBulkHeaders().catch(err =>
        log.error(
          { operation: 'headers.export', outcome: 'error', context: 'periodic', err },
          'Periodic export error'
        )
      )
    }, bulkHeadersAutoExportInterval)
  }

  log.info(
    {
      operation: 'server.ready',
      outcome: 'ok',
      port,
      cdn_enabled: enableBulkHeadersCDN,
      cdn_port: enableBulkHeadersCDN ? cdnPort : undefined,
      routing_prefix: routingPrefix || '/',
      v1_endpoints: [
        'GET /getChain',
        'GET /getInfo',
        'GET /getPresentHeight',
        'GET /findChainTipHashHex',
        'GET /findChainTipHeaderHex',
        'GET /findHeaderHexForHeight?height=N',
        'GET /findHeaderHexForBlockHash?hash=X',
        'GET /getHeaders?height=N&count=M',
        'POST /addHeaderHex'
      ],
      v2_endpoints: [
        'GET /v2/network',
        'GET /v2/tip',
        'GET /v2/header/height/:height',
        'GET /v2/header/hash/:hash',
        'GET /v2/headers?height=N&count=M'
      ],
      cdn_endpoints: enableBulkHeadersCDN
        ? [`GET /${chain}NetBlockHeaders.json`, 'GET /*.headers']
        : undefined
    },
    'Chaintracks API server is running'
  )

  // Enhanced shutdown with cleanup
  const shutdown = async (signal: string) => {
    log.info({ operation: 'shutdown', signal }, 'Signal received, shutting down gracefully')
    try {
      // Stop periodic export if running
      if (exportInterval) {
        clearInterval(exportInterval)
        log.info(
          { operation: 'shutdown.export_timer', outcome: 'ok' },
          'Stopped periodic export timer'
        )
      }
      clearInterval(eventLoopSampleInterval)
      eventLoopDelay.disable()

      // Stop CDN server if running
      if (cdnServer) {
        log.info({ operation: 'shutdown.cdn_server' }, 'Stopping CDN server')
        await new Promise<void>(resolve => {
          cdnServer.close(() => {
            log.info({ operation: 'shutdown.cdn_server', outcome: 'ok' }, 'CDN server stopped')
            resolve()
          })
        })
      }

      // Unsubscribe from events
      log.info({ operation: 'shutdown.unsubscribe' }, 'Unsubscribing from events')
      await chaintracks.unsubscribe(headerSubscriptionId)
      await chaintracks.unsubscribe(reorgSubscriptionId)

      // Stop the API server
      log.info({ operation: 'shutdown.api_server' }, 'Stopping API server')
      await new Promise<void>(resolve => {
        apiServer.close(() => {
          log.info({ operation: 'shutdown.api_server', outcome: 'ok' }, 'API server stopped')
          resolve()
        })
      })

      // Stop chaintracks
      log.info({ operation: 'shutdown.chaintracks' }, 'Stopping chaintracks')
      await chaintracks.destroy()
      await (bulkFileDataValidator as { destroy?: () => Promise<void> } | undefined)?.destroy?.()

      log.info({ operation: 'shutdown', outcome: 'ok' }, 'All servers stopped successfully')
      process.exit(0)
    } catch (error) {
      log.error({ operation: 'shutdown', outcome: 'error', err: error }, 'Error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', error => {
    log.error(
      { operation: 'uncaught_exception', outcome: 'error', err: error },
      'Uncaught Exception'
    )
    shutdown('uncaughtException')
  })
  process.on('unhandledRejection', (reason, promise) => {
    log.error(
      { operation: 'unhandled_rejection', outcome: 'error', err: reason, promise },
      'Unhandled Rejection'
    )
    shutdown('unhandledRejection')
  })
}

// Wrap startup in a span so a slow/failed boot is visible in traces.
tracer.startActiveSpan('chaintracks.bootstrap', async span => {
  const startedAt = Date.now()
  try {
    await main()
    span.setStatus({ code: SpanStatusCode.OK })
    log.info(
      { operation: 'bootstrap', outcome: 'ok', duration_ms: Date.now() - startedAt },
      'chaintracks-server started'
    )
    span.end()
  } catch (error) {
    span.recordException(error as Error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
    log.error(
      { operation: 'bootstrap', outcome: 'error', duration_ms: Date.now() - startedAt, err: error },
      'Failed to start server'
    )
    span.end()
    process.exit(1)
  }
})
