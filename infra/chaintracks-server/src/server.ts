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

import { BlockHeader, Chaintracks, createDefaultNoDbChaintracksOptions, Services, Chain, ChaintracksFs } from '@bsv/wallet-toolbox'
import * as path from 'node:path'
import * as express from 'express'
import * as bodyParser from 'body-parser'
import { createV1Routes } from './v1-routes'
import { createV2Routes } from './v2-routes'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { log } from './logger'

const tracer = trace.getTracer('chaintracks-server')

function resolveBulkHeadersPath(): string {
  const raw = process.env.BULK_HEADERS_PATH || path.join(process.cwd(), 'public', 'headers')
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw)
}

async function ensureBulkHeadersDir(bulkHeadersPath: string): Promise<void> {
  try {
    const fs = await import('node:fs/promises')
    await fs.mkdir(bulkHeadersPath, { recursive: true })
    log.info({ operation: 'bulk_headers.dir_ensure', outcome: 'ok', bulk_headers_path: bulkHeadersPath }, 'Bulk headers directory ready')
  } catch (error) {
    log.error({ operation: 'bulk_headers.dir_ensure', outcome: 'error', bulk_headers_path: bulkHeadersPath, err: error }, 'Failed to create bulk headers directory')
    throw error
  }
}

async function main() {
  const chain: Chain = (process.env.CHAIN as Chain) || 'main'
  const port = Number.parseInt(process.env.PORT || '3013', 10)
  const cdnPort = port + 1 // CDN runs on next port
  const whatsonchainApiKey = process.env.WHATSONCHAIN_API_KEY || ''

  // SOURCE_CDN_URL: Remote CDN to download headers FROM (if local files don't exist)
  const sourceCdnUrl = process.env.SOURCE_CDN_URL || ''

  const enableBulkHeadersCDN = process.env.ENABLE_BULK_HEADERS_CDN === 'true'

  // CDN_HOST_URL: Public URL where THIS server's CDN is accessible (written to JSON rootFolder)
  const cdnHostUrl = process.env.CDN_HOST_URL || `http://localhost:${cdnPort}`

  const bulkHeadersPath = resolveBulkHeadersPath()

  // The source URL is where clients can download headers from (the CDN HTTP endpoint)
  const bulkHeadersSourceUrl = enableBulkHeadersCDN ? cdnHostUrl : undefined

  const bulkHeadersAutoExportInterval = Number.parseInt(process.env.BULK_HEADERS_AUTO_EXPORT_INTERVAL || '240000000', 10) // Default: 400 blocks around 67 hours

  log.info(
    {
      operation: 'config.summary',
      chain: `${chain}Net`,
      port,
      whatsonchain_api_key_configured: Boolean(whatsonchainApiKey),
      bulk_headers_cdn_enabled: enableBulkHeadersCDN,
    },
    'Starting ChaintracksService with custom configuration'
  )
  if (enableBulkHeadersCDN) {
    log.info(
      {
        operation: 'config.cdn',
        cdn_port: cdnPort,
        cdn_host_url: cdnHostUrl,
        bulk_headers_path: bulkHeadersPath,
      },
      'Bulk headers CDN configuration'
    )
    await ensureBulkHeadersDir(bulkHeadersPath)
  }

  // Create custom Chaintracks options
  // This allows fine-tuning of storage, ingestors, and sync behavior
  // When bulk headers CDN is enabled, configure the CDN ingestor to use the local filesystem first
  const chaintracksOptions = createDefaultNoDbChaintracksOptions(
    chain,
    whatsonchainApiKey, // WhatsOnChain API key for better rate limits
    100000, // maxPerFile: Headers per bulk file (100k)
    2, // maxRetained: Number of bulk files to retain in memory
    undefined, // fetch: Use default ChaintracksFetch
    sourceCdnUrl, // SOURCE_CDN_URL: Remote CDN to download headers FROM (fallback if local files don't exist)
    2000, // liveHeightThreshold: Headers within this distance are "live"
    400, // reorgHeightThreshold: Max reorg depth to handle
    500, // bulkMigrationChunkSize: Batch size for migrations
    400, // batchInsertLimit: Max headers to insert in one batch
    36 // addLiveRecursionLimit: Max depth to recursively fetch missing headers
  )

  // If bulk headers CDN is enabled, configure the CDN ingestor to use our local path
  // This makes the ingestor check the local filesystem FIRST before fetching from remote CDN
  //
  // How it works:
  // 1. On first startup: Ingestor checks bulkHeadersPath, finds no files, downloads from remote CDN (if configured)
  // 2. exportBulkHeaders() exports all headers from in-memory storage to bulkHeadersPath filesystem
  // 3. On subsequent restarts: Ingestor checks bulkHeadersPath, finds exported files, loads them WITHOUT downloading
  //
  // This creates a "self-hosting" CDN: once headers are downloaded and exported, the server serves them to others
  if (enableBulkHeadersCDN && chaintracksOptions.bulkIngestors.length > 0) {
    const cdnIngestor = chaintracksOptions.bulkIngestors[0] as any
    if (cdnIngestor?.localCachePath !== undefined) {
      // Override the local cache path to use our bulk headers export directory
      cdnIngestor.localCachePath = bulkHeadersPath
      log.info({ operation: 'cdn.ingestor_configure', outcome: 'ok', local_cache_path: bulkHeadersPath }, 'Configured CDN ingestor to use local path; filesystem checked first, then remote CDN')
    }
  }

  // Create Chaintracks instance with custom options
  const chaintracks = new Chaintracks(chaintracksOptions)

  // Track last exported height to trigger exports at 100k marks
  let lastExportedHeight = 0
  let isExporting = false

  // Function to export bulk headers
  const exportBulkHeaders = async () => {
    if (!enableBulkHeadersCDN) {
      log.info({ operation: 'headers.export', outcome: 'skipped', reason: 'cdn_disabled' }, 'Bulk headers CDN is disabled, skipping export')
      return
    }

    if (isExporting) {
      log.info({ operation: 'headers.export', outcome: 'skipped', reason: 'in_progress' }, 'Export already in progress, skipping')
      return
    }

    try {
      isExporting = true
      log.info({ operation: 'headers.export' }, 'Checking if export is needed')

      const currentHeight = await chaintracks.currentHeight()

      // Check if we've crossed a 100k boundary
      const currentMilestone = Math.floor(currentHeight / 100000)
      const lastMilestone = Math.floor(lastExportedHeight / 100000)

      const shouldExport = currentMilestone > lastMilestone || lastExportedHeight === 0
      log.info(
        {
          operation: 'headers.export',
          current_height: currentHeight,
          last_exported_height: lastExportedHeight,
          current_milestone: currentMilestone,
          last_milestone: lastMilestone,
          should_export: shouldExport,
        },
        'Evaluated export need'
      )

      if (shouldExport) {
        log.info(
          {
            operation: 'headers.export',
            bulk_headers_path: bulkHeadersPath,
            source_url: bulkHeadersSourceUrl,
          },
          'Exporting bulk headers'
        )

        await chaintracks.exportBulkHeaders(
          bulkHeadersPath,
          ChaintracksFs,
          bulkHeadersSourceUrl, // sourceUrl - sets rootFolder in the JSON metadata file
          100000,               // headersPerFile
          undefined             // maxHeight (export all available)
        )

        lastExportedHeight = currentHeight
        log.info(
          {
            operation: 'headers.export',
            outcome: 'ok',
            bulk_headers_path: bulkHeadersPath,
            download_url: `${bulkHeadersSourceUrl}/${chain}NetBlockHeaders.json`,
          },
          'Bulk headers exported successfully'
        )

        // List files to verify
        const fs = await import('node:fs/promises')
        try {
          const files = await fs.readdir(bulkHeadersPath)
          log.info({ operation: 'headers.export', file_count: files.length, files }, 'Listed exported files')
        } catch (e) {
          log.warn({ operation: 'headers.export', outcome: 'error', err: e }, 'Could not list files')
        }
      } else {
        log.info({ operation: 'headers.export', outcome: 'skipped', reason: 'no_boundary_crossed' }, 'No export needed')
      }
    } catch (error) {
      log.error({ operation: 'headers.export', outcome: 'error', err: error }, 'Error exporting bulk headers')
    } finally {
      isExporting = false
    }
  }

  // Subscribe to new block header events
  // This allows you to react to new blocks in real-time
  const headerSubscriptionId = await chaintracks.subscribeHeaders(
    async (header: BlockHeader) => {
      log.info(
        {
          operation: 'header.received',
          height: header.height,
          hash: header.hash,
          timestamp: new Date(header.time * 1000).toISOString(),
        },
        'New block header received'
      )

      // Check if we should export headers (non-blocking)
      if (enableBulkHeadersCDN) {
        exportBulkHeaders().catch(err =>
          log.error({ operation: 'headers.export', outcome: 'error', context: 'background', err }, 'Background export error')
        )
      }
    }
  )

  // Subscribe to blockchain reorganization events
  // Important for handling chain reorgs properly
  const reorgSubscriptionId = await chaintracks.subscribeReorgs(
    async (depth: number, oldTip: BlockHeader, newTip: BlockHeader, deactivated?: BlockHeader[]) => {
      log.info(
        {
          operation: 'reorg.detected',
          reorg_depth: depth,
          old_tip_hash: oldTip.hash,
          old_tip_height: oldTip.height,
          new_tip_hash: newTip.hash,
          new_tip_height: newTip.height,
          deactivated_hashes: deactivated && deactivated.length > 0 ? deactivated.map(h => h.hash) : [],
        },
        'Blockchain reorganization detected'
      )
    }
  )

  log.info({ operation: 'subscribe.headers', outcome: 'ok', subscription_id: headerSubscriptionId }, 'Subscribed to header events')
  log.info({ operation: 'subscribe.reorgs', outcome: 'ok', subscription_id: reorgSubscriptionId }, 'Subscribed to reorg events')

  // Create custom Services instance
  // This allows configuring which BSV network services to use
  // Note: Services uses the chain parameter to configure network services
  const services = new Services(chain)

  // Create Express app with both v1 and v2 routes
  const app = express.default()

  // CORS middleware
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    next()
  })

  // Body parser for POST requests
  app.use(bodyParser.json())

  // Root endpoint
  app.get('/', (_req: express.Request, res: express.Response) => {
    res.json({ status: 'success', value: 'chaintracks-server' })
  })

  // Robots.txt
  app.get('/robots.txt', (_req: express.Request, res: express.Response) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n')
  })

  // Mount v1 routes (RPC-style, original API)
  const v1Routes = createV1Routes({ chaintracks, services, chain })
  app.use('/', v1Routes)

  // Mount v2 routes (RESTful, go-chaintracks compatible)
  const v2Routes = createV2Routes(chaintracks)
  app.use('/v2', v2Routes)

  // Start the API server
  const apiServer = app.listen(port, () => {
    log.info({ operation: 'listen', outcome: 'ok', port, chain: `${chain}Net` }, 'API server running')
  })

  // Start a separate CDN server for bulk headers if enabled
  let cdnServer: any
  if (enableBulkHeadersCDN) {
    const cdnPort = port + 1 // Use next port for CDN
    const cdnApp = express.default()

    // CORS headers for CDN
    cdnApp.use((_req: any, res: any, next: any) => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Headers', '*')
      res.header('Access-Control-Allow-Methods', '*')
      next()
    })

    // Serve static files from the bulk headers directory
    cdnApp.use('/', express.static(bulkHeadersPath, {
      setHeaders: (res: any, filePath: string) => {
        // Set appropriate headers for bulk header files
        if (filePath.endsWith('.headers')) {
          res.setHeader('Content-Type', 'application/octet-stream')
        } else if (filePath.endsWith('.json')) {
          res.setHeader('Content-Type', 'application/json')
        }
        res.setHeader('Cache-Control', 'public, max-age=3600')
      }
    }))

    cdnServer = cdnApp.listen(cdnPort, () => {
      log.info(
        {
          operation: 'cdn.listen',
          outcome: 'ok',
          cdn_port: cdnPort,
          access_url: `http://localhost:${cdnPort}/mainNetBlockHeaders.json`,
        },
        'Bulk Headers CDN server running'
      )
    })
  }

  // Perform initial export if CDN is enabled
  if (enableBulkHeadersCDN) {
    log.info({ operation: 'headers.export', context: 'initial' }, 'Performing initial bulk headers export')
    await exportBulkHeaders()
  }

  // Set up periodic export check (every 10 minutes by default)
  let exportInterval: NodeJS.Timeout | undefined
  if (enableBulkHeadersCDN) {
    exportInterval = setInterval(() => {
      exportBulkHeaders().catch(err =>
        log.error({ operation: 'headers.export', outcome: 'error', context: 'periodic', err }, 'Periodic export error')
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
      v1_endpoints: [
        'GET /getChain',
        'GET /getInfo',
        'GET /getPresentHeight',
        'GET /findChainTipHashHex',
        'GET /findChainTipHeaderHex',
        'GET /findHeaderHexForHeight?height=N',
        'GET /findHeaderHexForBlockHash?hash=X',
        'GET /getHeaders?height=N&count=M',
        'POST /addHeaderHex',
      ],
      v2_endpoints: [
        'GET /v2/network',
        'GET /v2/tip',
        'GET /v2/header/height/:height',
        'GET /v2/header/hash/:hash',
        'GET /v2/headers?height=N&count=M',
      ],
      cdn_endpoints: enableBulkHeadersCDN
        ? [`GET /${chain}NetBlockHeaders.json`, 'GET /*.headers']
        : undefined,
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
        log.info({ operation: 'shutdown.export_timer', outcome: 'ok' }, 'Stopped periodic export timer')
      }

      // Stop CDN server if running
      if (cdnServer) {
        log.info({ operation: 'shutdown.cdn_server' }, 'Stopping CDN server')
        await new Promise<void>((resolve) => {
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
      await new Promise<void>((resolve) => {
        apiServer.close(() => {
          log.info({ operation: 'shutdown.api_server', outcome: 'ok' }, 'API server stopped')
          resolve()
        })
      })

      // Stop chaintracks
      log.info({ operation: 'shutdown.chaintracks' }, 'Stopping chaintracks')
      await chaintracks.destroy()

      log.info({ operation: 'shutdown', outcome: 'ok' }, 'All servers stopped successfully')
      process.exit(0)
    } catch (error) {
      log.error({ operation: 'shutdown', outcome: 'error', err: error }, 'Error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (error) => {
    log.error({ operation: 'uncaught_exception', outcome: 'error', err: error }, 'Uncaught Exception')
    shutdown('uncaughtException')
  })
  process.on('unhandledRejection', (reason, promise) => {
    log.error({ operation: 'unhandled_rejection', outcome: 'error', err: reason, promise }, 'Unhandled Rejection')
    shutdown('unhandledRejection')
  })
}

// Wrap startup in a span so a slow/failed boot is visible in traces.
tracer.startActiveSpan('chaintracks.bootstrap', async (span) => {
  const startedAt = Date.now()
  try {
    await main()
    span.setStatus({ code: SpanStatusCode.OK })
    log.info({ operation: 'bootstrap', outcome: 'ok', duration_ms: Date.now() - startedAt }, 'chaintracks-server started')
    span.end()
  } catch (error) {
    span.recordException(error as Error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
    log.error({ operation: 'bootstrap', outcome: 'error', duration_ms: Date.now() - startedAt, err: error }, 'Failed to start server')
    span.end()
    process.exit(1)
  }
})
