# ChaintracksService Express Server Wrapper - Session 1

## Project Overview
Creating a TypeScript Express server that wraps the `ChaintracksService` class from `@bsv/wallet-toolbox`. The ChaintracksService already has built-in Express server capabilities, so this project demonstrates how to properly instantiate and use it.

## Key Findings from wallet-toolbox Analysis

### ChaintracksService Architecture
The `ChaintracksService` class (from `@bsv/wallet-toolbox/src/services/chaintracker/chaintracks/ChaintracksService.ts`) is a complete Express server implementation that:

1. **Built-in Express Server**: Already implements a full Express server with JSON-RPC style endpoints
2. **In-Memory NoDb Storage**: Supports in-memory storage via `createDefaultNoDbChaintracksOptions()`
3. **Service Integration**: Integrates with BSV network services (WhatsOnChain, etc.)
4. **CORS Support**: Built-in CORS configuration for cross-origin requests
5. **Lifecycle Management**: Proper startup/shutdown with `startJsonRpcServer()` and `stopJsonRpcServer()`

### Key ChaintracksService Methods (Already Exposed as REST Endpoints)

The ChaintracksService.startJsonRpcServer() method automatically creates these REST API endpoints:

#### GET Endpoints:
- `GET /` - Server info page
- `GET /robots.txt` - Robots exclusion
- `GET /getChain` - Returns the chain ('main' or 'test')
- `GET /getInfo` - Returns ChaintracksInfoApi (chain state, storage, ingestors, heights)
- `GET /getFiatExchangeRates` - Returns current fiat exchange rates
- `GET /getPresentHeight` - Returns latest blockchain height
- `GET /findChainTipHashHex` - Returns chain tip block hash
- `GET /findChainTipHeaderHex` - Returns chain tip header
- `GET /findHeaderHexForHeight?height=N` - Returns header for specific height
- `GET /findHeaderHexForBlockHash?hash=HASH` - Returns header for specific block hash
- `GET /getHeaders?height=N&count=M` - Returns M headers starting from height N

#### POST Endpoints:
- `POST /addHeaderHex` - Submit new block header

### Response Format
All endpoints return JSON with this structure:
```json
{
  "status": "success",
  "value": <result>
}
```
Or on error:
```json
{
  "status": "error",
  "code": "ERR_INTERNAL",
  "description": "error message"
}
```

### Initialization Sequence

1. Create ChaintracksServiceOptions with chain and storage configuration
2. Instantiate ChaintracksService
3. Call `startJsonRpcServer(port)` which:
   - Calls `chaintracks.makeAvailable()` to initialize storage
   - Sets up Express app with body-parser and CORS
   - Registers all REST endpoints
   - Starts listening on specified port
4. To shutdown: Call `stopJsonRpcServer()` which:
   - Closes the HTTP server
   - Destroys the chaintracks instance

### NoDb/In-Memory Configuration

The `createDefaultNoDbChaintracksOptions(chain)` function creates a fully configured ChaintracksOptions with:
- **ChaintracksStorageNoDb**: In-memory storage without database persistence
- **BulkIngestorCDNBabbage**: Fetches historical headers from CDN
- **BulkIngestorWhatsOnChainCdn**: Fetches headers from WhatsOnChain CDN
- **LiveIngestorWhatsOnChainPoll**: Polls WhatsOnChain for new headers

### TypeScript Types and Interfaces

Key types from wallet-toolbox:
```typescript
import { Chain } from '@bsv/wallet-toolbox/sdk/types'
import { ChaintracksService, ChaintracksServiceOptions } from '@bsv/wallet-toolbox/services/chaintracker/chaintracks/ChaintracksService'
import { createDefaultNoDbChaintracksOptions } from '@bsv/wallet-toolbox/services/chaintracker/chaintracks/createDefaultNoDbChaintracksOptions'
import { Services } from '@bsv/wallet-toolbox/services/Services'
import { ChaintracksInfoApi, HeaderListener, ReorgListener } from '@bsv/wallet-toolbox/services/chaintracker/chaintracks/Api/ChaintracksClientApi'
import { BlockHeader, BaseBlockHeader } from '@bsv/wallet-toolbox/services/chaintracker/chaintracks/Api/BlockHeaderApi'
```

### Configuration Options

ChaintracksServiceOptions interface:
- `chain`: 'main' | 'test' - Which Bitcoin SV network
- `routingPrefix`: string - Prepended to all endpoint paths (e.g., '/api/v1')
- `chaintracks?`: Chaintracks - Optional custom Chaintracks instance (defaults to NoDb)
- `services?`: Services - Optional custom Services instance
- `port?`: number - Server port (defaults to 3011)

## Implementation Status

### Completed:
- Analyzed ChaintracksService source code
- Identified all available REST endpoints
- Documented initialization sequence
- Documented NoDb configuration approach
- Created context documentation

### Next Steps:
1. Create package.json with dependencies
2. Create tsconfig.json for TypeScript configuration
3. Create example server implementation (src/server.ts)
4. Create example with custom routing prefix (src/server-with-prefix.ts)
5. Create example with custom configuration (src/server-custom.ts)
6. Create README.md with usage documentation
7. Add error handling examples
8. Add health check endpoint examples

## Dependencies Required
```json
{
  "@bsv/wallet-toolbox": "latest",
  "express": "^4.18.2",
  "body-parser": "^1.20.2"
}
```

## Best Practices Identified

1. **Initialization**: Always await `makeAvailable()` before processing requests
2. **Lifecycle**: Use proper startup/shutdown with try-catch-finally
3. **Error Handling**: All endpoints use consistent error format with WERR_* codes
4. **CORS**: Built-in CORS support for browser clients
5. **Async Operations**: All endpoint handlers are async with proper error catching
6. **Logging**: Console logging for all requests and errors
7. **Graceful Shutdown**: Close server and destroy chaintracks on SIGINT/SIGTERM
8. **Port Configuration**: Configurable via environment variables
9. **Chain Selection**: Support both 'main' and 'test' networks
10. **Routing Prefix**: Use routingPrefix for API versioning (e.g., '/api/v1')
