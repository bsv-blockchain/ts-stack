# ChaintracksService Architecture

## Overview

This document provides a deep dive into the ChaintracksService architecture, initialization flow, and internal workings based on the `@bsv/wallet-toolbox` implementation.

## Component Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    ChaintracksService                          │
│                   (Express HTTP Server)                        │
│                                                                │
│  - Express app with body-parser & CORS                        │
│  - REST API endpoint handlers                                 │
│  - Request validation & error handling                        │
│  - Response formatting                                        │
└────────────────┬───────────────────────────────────────────────┘
                 │
                 │ uses
                 │
┌────────────────▼───────────────────────────────────────────────┐
│                      Chaintracks                               │
│                   (Core Header Manager)                        │
│                                                                │
│  Components:                                                   │
│  - Main thread (header processing loop)                       │
│  - Base headers queue (client-submitted headers)              │
│  - Live headers queue (ingestor-supplied headers)             │
│  - Subscriber callbacks (header & reorg events)               │
│  - Single writer/multi-reader lock                            │
│  - Startup/shutdown state management                          │
│                                                                │
│  Key Methods:                                                  │
│  - makeAvailable(): Initialize and sync storage               │
│  - addHeader(): Queue header for processing                   │
│  - findHeaderForHeight(): Query by height                     │
│  - findHeaderForBlockHash(): Query by hash                    │
│  - subscribeHeaders(): Register new header callback           │
│  - subscribeReorgs(): Register reorg callback                 │
│  - destroy(): Graceful shutdown                               │
└────────────────┬───────────────────────────────────────────────┘
                 │
                 │ uses
                 │
┌────────────────▼───────────────────────────────────────────────┐
│                ChaintracksStorageNoDb                          │
│                  (In-Memory Storage)                           │
│                                                                │
│  Components:                                                   │
│  - BulkFileDataManager: Manages bulk header files             │
│  - Live headers map: Recent headers by hash                   │
│  - Active chain: Headers by height                            │
│  - Reorg handling: Deactivate/activate headers                │
│                                                                │
│  Data Structures:                                              │
│  - Bulk files: Map<fileNumber, Uint8Array>                    │
│  - Live headers: Map<hash, LiveBlockHeader>                   │
│  - Active by height: Map<height, hash>                        │
│  - Height ranges: {bulk: Range, live: Range}                  │
│                                                                │
│  Key Operations:                                               │
│  - insertHeader(): Add header, handle reorgs                  │
│  - findHeaderForHeight(): O(1) height lookup                  │
│  - findLiveHeaderForBlockHash(): O(1) hash lookup             │
│  - getHeadersUint8Array(): Bulk header retrieval              │
│  - bulkMigration(): Move live → bulk storage                  │
└────────────────┬───────────────────────────────────────────────┘
                 │
                 │ coordinates
                 │
┌────────────────▼───────────────────────────────────────────────┐
│                  Bulk & Live Ingestors                         │
│                                                                │
│  Bulk Ingestors (Historical Headers):                         │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  BulkIngestorCDNBabbage                                  │ │
│  │  - Fetches from cdn.projectbabbage.com                   │ │
│  │  - JSON format: {chain}NetBlockHeaders.json              │ │
│  │  - Returns bulk files with 100k headers each             │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  BulkIngestorWhatsOnChainCdn                             │ │
│  │  - Fetches from WhatsOnChain CDN                         │ │
│  │  - Fallback if Babbage CDN unavailable                   │ │
│  │  - Uses WoC API key if configured                        │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  Live Ingestors (Real-time Headers):                          │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  LiveIngestorWhatsOnChainPoll                            │ │
│  │  - Polls WoC /chain/info endpoint                        │ │
│  │  - Detects new blocks via height change                  │ │
│  │  - Fetches new headers via /block/height/{n}/header      │ │
│  │  - Pushes to liveHeaders queue                           │ │
│  │  - Idle wait: 100 seconds between polls                  │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

## Initialization Flow

### 1. ChaintracksService Constructor

```typescript
constructor(options: ChaintracksServiceOptions) {
  this.chain = options.chain
  this.port = options.port

  // Create Chaintracks with NoDb storage if not provided
  this.chaintracks = options.chaintracks ||
    new Chaintracks(createDefaultNoDbChaintracksOptions(this.chain))

  // Create Services instance if not provided
  this.services = options.services || new Services(this.chain)

  // Validate all components are on same chain
  if (this.chaintracks.chain !== this.chain ||
      this.services.chain !== this.chain) {
    throw new Error('Chain mismatch')
  }
}
```

### 2. startJsonRpcServer() Flow

```
startJsonRpcServer(port)
  │
  ├─► await chaintracks.makeAvailable()
  │     │
  │     ├─► await storage.migrateLatest()
  │     │     └─► Create in-memory data structures
  │     │
  │     ├─► Initialize bulk ingestors
  │     │     ├─► setStorage(storage)
  │     │     └─► Configure CDN URLs
  │     │
  │     ├─► Initialize live ingestors
  │     │     ├─► setStorage(storage)
  │     │     └─► Configure polling
  │     │
  │     ├─► Start live ingestors
  │     │     └─► startListening(liveHeaders queue)
  │     │           └─► Background polling begins
  │     │
  │     ├─► Start main thread
  │     │     └─► mainThreadShiftLiveHeaders()
  │     │           │
  │     │           ├─► syncBulkStorage()
  │     │           │     │
  │     │           │     ├─► Get presentHeight from bulk ingestors
  │     │           │     ├─► Get available height ranges
  │     │           │     ├─► Call bulk.synchronize() for each ingestor
  │     │           │     │     ├─► Download bulk files from CDN
  │     │           │     │     ├─► Insert headers into storage
  │     │           │     │     └─► Return live headers for processing
  │     │           │     └─► Set available = true
  │     │           │
  │     │           └─► Process headers loop
  │     │                 ├─► Shift header from liveHeaders queue
  │     │                 ├─► Insert with storage.insertHeader()
  │     │                 │     ├─► Validate header format
  │     │                 │     ├─► Check previous header exists
  │     │                 │     ├─► Calculate chainWork
  │     │                 │     ├─► Handle reorg if needed
  │     │                 │     └─► Update active chain
  │     │                 ├─► If previous missing, fetch recursively
  │     │                 ├─► Notify subscribers if added
  │     │                 └─► Repeat every 1 second
  │     │
  │     └─► Wait for available = true
  │
  ├─► Create Express app
  │     ├─► app.use(bodyParser.json())
  │     └─► app.use(CORS middleware)
  │
  ├─► Register endpoints
  │     ├─► GET / (info page)
  │     ├─► GET /robots.txt
  │     ├─► GET /getChain
  │     ├─► GET /getInfo
  │     ├─► GET /getPresentHeight
  │     ├─► GET /findChainTipHashHex
  │     ├─► GET /findChainTipHeaderHex
  │     ├─► GET /findHeaderHexForHeight
  │     ├─► GET /findHeaderHexForBlockHash
  │     ├─► GET /getHeaders
  │     ├─► GET /getFiatExchangeRates
  │     └─► POST /addHeaderHex
  │
  └─► app.listen(port)
        └─► Server ready
```

## Main Thread Processing Loop

The main thread continuously processes headers from two queues:

### Header Queues

1. **liveHeaders** - Headers pushed by live ingestors (high priority)
2. **baseHeaders** - Headers submitted via `/addHeaderHex` endpoint (low priority)

### Processing Algorithm

```
while (!stopMainThread) {
  // Check if bulk sync needed (every 30 minutes or on startup)
  if (shouldSyncBulk()) {
    presentHeight = getPresentHeight()
    await syncBulkStorage(presentHeight)
  }

  // Process live headers (from ingestors)
  while (header = liveHeaders.shift()) {
    result = await addLiveHeader(header)

    if (result.noPrev) {
      // Previous header missing, try to fetch it
      if (recursions < addLiveRecursionLimit) {
        prevHeader = await getMissingBlockHeader(header.previousHash)
        if (prevHeader) {
          liveHeaders.unshift(header)  // Put back current
          header = prevHeader           // Process previous first
          continue
        }
      }
      // Skip header if can't resolve previous
    }

    if (result.added && result.isActiveTip) {
      // Notify header subscribers
      for (listener of headerListeners) {
        listener(header)
      }

      if (result.reorgDepth > 0) {
        // Notify reorg subscribers
        for (listener of reorgListeners) {
          listener(depth, oldTip, newTip, deactivated)
        }
      }
    }
  }

  // Process base headers (from API)
  while (header = baseHeaders.shift()) {
    prev = await storage.findLiveHeaderForBlockHash(header.previousHash)
    if (prev) {
      fullHeader = { ...header, height: prev.height + 1, hash: blockHash(header) }
      await addLiveHeader(fullHeader)
    }
  }

  // No headers to process, wait before checking again
  await wait(1000)
}
```

## Storage Operations

### Header Insertion (insertHeader)

```
insertHeader(header)
  │
  ├─► Validate header format
  │     ├─► Check version, previousHash, merkleRoot, etc.
  │     └─► Validate against dirty hashes (known invalid)
  │
  ├─► Check if header already exists (dupe check)
  │
  ├─► Find previous header
  │     ├─► If not found: return {noPrev: true}
  │     └─► Validate previous.height = header.height - 1
  │
  ├─► Calculate chainWork
  │     └─► chainWork = prev.chainWork + blockWork(header.bits)
  │
  ├─► Add to live headers map
  │     └─► liveHeaders.set(header.hash, {header, chainWork})
  │
  ├─► Check if extends active chain
  │     │
  │     ├─► If chainWork > activeTip.chainWork:
  │     │     │
  │     │     ├─► REORG DETECTED
  │     │     │     │
  │     │     │     ├─► Walk back from activeTip to common ancestor
  │     │     │     ├─► Deactivate headers on old chain
  │     │     │     ├─► Activate headers on new chain
  │     │     │     └─► Calculate reorgDepth
  │     │     │
  │     │     └─► Update active chain
  │     │           └─► activeByHeight.set(height, hash)
  │     │
  │     └─► If chainWork <= activeTip.chainWork:
  │           └─► Store as orphan/side chain
  │
  └─► Return InsertHeaderResult
        ├─► added: boolean
        ├─► dupe: boolean
        ├─► isActiveTip: boolean
        ├─► reorgDepth: number
        ├─► deactivatedHeaders: BlockHeader[]
        └─► priorTip: BlockHeader
```

### Chain Reorganization Handling

```
handleReorg(newTip, oldTip)
  │
  ├─► Find common ancestor
  │     │
  │     └─► Walk back from both tips until hashes match
  │           ├─► newChain = [newTip, newTip.prev, ...]
  │           └─► oldChain = [oldTip, oldTip.prev, ...]
  │
  ├─► Deactivate old chain
  │     │
  │     └─► For each header in oldChain:
  │           └─► Remove from activeByHeight map
  │
  ├─► Activate new chain
  │     │
  │     └─► For each header in newChain:
  │           └─► Set in activeByHeight map
  │
  └─► Calculate reorg depth
        └─► depth = oldChain.length
```

## Storage Data Structures

### ChaintracksStorageNoDb

```typescript
class ChaintracksStorageNoDb {
  // Bulk storage (historical headers)
  private bulkManager: BulkFileDataManager
  // Map of file numbers to bulk header files
  // Each file: Uint8Array of 80-byte headers

  // Live storage (recent headers)
  private liveHeaders: Map<string, LiveBlockHeader>
  // Key: block hash (hex string)
  // Value: {header, chainWork, isActive}

  // Active chain index
  private activeByHeight: Map<number, string>
  // Key: block height
  // Value: block hash (hex string)

  // Height ranges
  private ranges: {
    bulk: HeightRange,  // {minHeight, maxHeight}
    live: HeightRange   // {minHeight, maxHeight}
  }

  // Configuration
  liveHeightThreshold: number = 2000  // Headers within this are "live"
  reorgHeightThreshold: number = 400  // Max reorg depth to handle
}
```

### BulkFileDataManager

```typescript
class BulkFileDataManager {
  private files: Map<number, Uint8Array>
  // Key: file number (height / maxPerFile)
  // Value: Uint8Array of serialized headers

  private maxPerFile: number = 100000
  private maxRetained: number = 2

  // CDN configuration
  private cdnUrl: string
  private fetch: ChaintracksFetchApi

  // Operations
  async loadFile(fileNumber: number): Promise<Uint8Array>
  async getHeader(height: number): Promise<BlockHeader>
  async getHeaders(height: number, count: number): Promise<Uint8Array>
}
```

## Event Subscriptions

### Header Subscription

```typescript
// Subscribe to new headers
const subscriptionId = await chaintracks.subscribeHeaders(
  (header: BlockHeader) => {
    console.log('New block:', header.height, header.hash)
  }
)

// Called when:
// - Header is added (inserted successfully)
// - Header becomes active chain tip
// - Only after initial sync completes
```

### Reorg Subscription

```typescript
// Subscribe to reorganizations
const subscriptionId = await chaintracks.subscribeReorgs(
  (depth: number, oldTip: BlockHeader, newTip: BlockHeader, deactivated?: BlockHeader[]) => {
    console.log(`Reorg: ${depth} blocks`)
    console.log('Old tip:', oldTip.hash)
    console.log('New tip:', newTip.hash)
    console.log('Deactivated:', deactivated?.map(h => h.hash))
  }
)

// Called when:
// - New header has higher chainWork than current tip
// - Causes deactivation of previous active headers
```

## Performance Characteristics

### Memory Usage

- **Bulk files**: `maxPerFile × 80 bytes × maxRetained`
  - Default: 100,000 × 80 × 2 = 16 MB

- **Live headers**: `liveHeightThreshold × ~200 bytes`
  - Default: 2,000 × 200 = 400 KB

- **Total**: ~16-20 MB for default configuration

### Query Performance

- **findHeaderForHeight()**:
  - Active chain: O(1) map lookup
  - Bulk storage: O(1) array index
  - Response time: < 1ms

- **findHeaderForBlockHash()**:
  - Live headers: O(1) map lookup
  - Bulk storage: O(n) scan through file
  - Response time: < 1ms for live, < 10ms for bulk

- **getHeaders(height, count)**:
  - Array slice operation
  - Response time: < 1ms for small counts

### Network Performance

- **Initial sync**: Downloads bulk files from CDN
  - File size: ~8 MB per 100k headers
  - Time: 1-5 seconds per file (network dependent)

- **Live updates**: Polls WhatsOnChain every 100 seconds
  - Bandwidth: < 1 KB per poll
  - New block latency: 0-100 seconds

## Concurrency Control

### Single Writer / Multi Reader Lock

```typescript
class SingleWriterMultiReaderLock {
  // Allows:
  // - One writer at a time
  // - Multiple readers simultaneously
  // - Writers wait for all readers to finish
  // - Readers wait if writer is active

  async withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  async withReadLock<T>(fn: () => Promise<T>): Promise<T>
}
```

### Lock Usage

- **Write locks** (exclusive):
  - `makeAvailable()` - Initial sync
  - `syncBulkStorage()` - Periodic bulk sync
  - `insertHeader()` - When processing headers

- **Read locks** (shared):
  - `findHeaderForHeight()`
  - `findHeaderForBlockHash()`
  - `getInfo()`
  - `findChainTipHeader()`
  - All query operations

## Error Handling

### Startup Errors

```typescript
try {
  await service.startJsonRpcServer(port)
} catch (error) {
  // Possible errors:
  // - Port already in use
  // - Network timeout downloading bulk files
  // - Invalid bulk file format
  // - Storage initialization failure
}
```

### Runtime Errors

```typescript
// Main thread catches all errors and:
// - Logs error
// - If not yet available: Sets startupError and stops
// - If available: Logs error and continues

// Ingestor errors:
// - Logged but don't stop main thread
// - Falls back to other ingestors
```

### Request Errors

```typescript
// All endpoints wrapped with error handler:
try {
  const result = await operation()
  res.json({ status: 'success', value: result })
} catch (err) {
  res.status(500).json({
    status: 'error',
    code: 'ERR_INTERNAL',
    description: err.message
  })
}
```

## Shutdown Sequence

```
stopJsonRpcServer()
  │
  ├─► Close HTTP server
  │     └─► Stop accepting new connections
  │
  └─► await chaintracks.destroy()
        │
        ├─► Set stopMainThread = true
        │
        ├─► Stop all live ingestors
        │     └─► await liveIngestor.shutdown()
        │
        ├─► Stop all bulk ingestors
        │     └─► await bulkIngestor.shutdown()
        │
        ├─► Wait for all promises to complete
        │     └─► await Promise.all(promises)
        │
        ├─► Destroy storage
        │     └─► await storage.destroy()
        │           └─► Clear all maps and data
        │
        └─► Set available = false
```

## Best Practices

### 1. Initialization

- Always await `startJsonRpcServer()` before using
- Handle startup errors gracefully
- Wait for initial sync to complete

### 2. Queries

- Use `findHeaderForHeight()` for active chain queries
- Use `findHeaderForBlockHash()` for recent headers
- Cache frequently accessed data (chain tip, present height)

### 3. Events

- Subscribe after service is available
- Keep event handlers fast (use queues for heavy work)
- Unsubscribe before shutdown

### 4. Shutdown

- Always call `stopJsonRpcServer()` before exit
- Wait for shutdown to complete
- Handle SIGINT/SIGTERM for graceful shutdown

### 5. Error Handling

- Implement retry logic for transient errors
- Monitor for repeated errors (may indicate service issues)
- Log all errors for debugging
