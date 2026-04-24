# ChaintracksService REST API Documentation

Complete REST API reference for the ChaintracksService endpoints.

## Base URL

```
http://localhost:3011
```

Or with routing prefix:

```
http://localhost:3011/api/v1
```

## Response Format

All endpoints return JSON with a consistent format.

### Success Response

```json
{
  "status": "success",
  "value": <result>
}
```

### Error Response

```json
{
  "status": "error",
  "code": "ERR_CODE",
  "description": "Error message"
}
```

## CORS

All endpoints support CORS with the following headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: *
Access-Control-Allow-Methods: *
Access-Control-Expose-Headers: *
Access-Control-Allow-Private-Network: true
```

## Endpoints

### GET /

Returns server information page.

**Response:**
```
Content-Type: text/plain
Chaintracks mainNet Block Header Service
```

**Example:**
```bash
curl http://localhost:3011/
```

---

### GET /robots.txt

Returns robots exclusion standard file.

**Response:**
```
User-agent: *
Disallow: /
```

---

### GET /getChain

Returns the blockchain network the service is tracking.

**Response:**
```json
{
  "status": "success",
  "value": "main"
}
```

**Values:**
- `"main"` - Bitcoin SV mainnet
- `"test"` - Bitcoin SV testnet

**Example:**
```bash
curl http://localhost:3011/getChain
```

**Response Example:**
```json
{
  "status": "success",
  "value": "main"
}
```

---

### GET /getInfo

Returns detailed information about the service state, configuration, and current blockchain heights.

**Query Parameters:**
- `wait` (optional): Milliseconds to wait before responding (for testing)

**Response:**
```json
{
  "status": "success",
  "value": {
    "chain": "main",
    "heightBulk": 869999,
    "heightLive": 870125,
    "storage": "ChaintracksStorageNoDb",
    "bulkIngestors": [
      "BulkIngestorCDNBabbage",
      "BulkIngestorWhatsOnChainCdn"
    ],
    "liveIngestors": [
      "LiveIngestorWhatsOnChainPoll"
    ],
    "packages": []
  }
}
```

**Fields:**
- `chain`: Network name ('main' or 'test')
- `heightBulk`: Highest height in bulk storage (CDN-backed)
- `heightLive`: Highest height in live storage (in-memory)
- `storage`: Storage backend class name
- `bulkIngestors`: List of bulk ingestor class names
- `liveIngestors`: List of live ingestor class names
- `packages`: Package version information (optional)

**Example:**
```bash
curl http://localhost:3011/getInfo
```

**Notes:**
- Response is never cached (Cache-Control: no-cache)
- Use this endpoint for health checks and monitoring
- `heightBulk` should be close to `heightLive` (within ~2000 blocks)

---

### GET /getPresentHeight

Returns the latest blockchain height from configured bulk ingestors. This represents the current "real" blockchain height from external sources.

**Response:**
```json
{
  "status": "success",
  "value": 870125
}
```

**Example:**
```bash
curl http://localhost:3011/getPresentHeight
```

**Notes:**
- Response is cached for 1 minute
- Value is fetched from WhatsOnChain or other bulk ingestors
- Response is never cached (Cache-Control: no-cache)

---

### GET /findChainTipHashHex

Returns the block hash of the active chain tip.

**Response:**
```json
{
  "status": "success",
  "value": "00000000000000000123456789abcdef..."
}
```

**Example:**
```bash
curl http://localhost:3011/findChainTipHashHex
```

**Notes:**
- Response is never cached (Cache-Control: no-cache)
- Returns empty string if no headers available

---

### GET /findChainTipHeaderHex

Returns the complete block header of the active chain tip.

**Response:**
```json
{
  "status": "success",
  "value": {
    "version": 536870912,
    "previousHash": "000000000000000003a1b48cf612e8...",
    "merkleRoot": "7c5f9c5e8b8a5c3d2e1f0a9b8c7d6e...",
    "time": 1703001234,
    "bits": 403123456,
    "nonce": 2876543210,
    "height": 870125,
    "hash": "00000000000000000123456789abcd..."
  }
}
```

**Fields:**
- `version`: Block version number
- `previousHash`: Hash of previous block (hex string)
- `merkleRoot`: Merkle root of transactions (hex string)
- `time`: Block timestamp (Unix epoch seconds)
- `bits`: Difficulty target (compact format)
- `nonce`: Block nonce
- `height`: Block height
- `hash`: Block hash (hex string)

**Example:**
```bash
curl http://localhost:3011/findChainTipHeaderHex
```

**Notes:**
- Response is never cached (Cache-Control: no-cache)
- All hash fields are hex strings (lowercase)

---

### GET /findHeaderHexForHeight

Returns the block header for a specific height on the active chain.

**Query Parameters:**
- `height` (required): Block height (integer)

**Response:**
```json
{
  "status": "success",
  "value": {
    "version": 536870912,
    "previousHash": "000000000000000003a1b48cf612e8...",
    "merkleRoot": "7c5f9c5e8b8a5c3d2e1f0a9b8c7d6e...",
    "time": 1703001234,
    "bits": 403123456,
    "nonce": 2876543210,
    "height": 800000,
    "hash": "00000000000000000123456789abcd..."
  }
}
```

If height not found:
```json
{
  "status": "success",
  "value": null
}
```

**Example:**
```bash
curl "http://localhost:3011/findHeaderHexForHeight?height=800000"
```

**Notes:**
- Returns `null` if height doesn't exist
- Only returns headers on active chain
- Fast O(1) lookup

---

### GET /findHeaderHexForBlockHash

Returns the block header for a specific block hash (if in live storage).

**Query Parameters:**
- `hash` (required): Block hash (hex string)

**Response:**
```json
{
  "status": "success",
  "value": {
    "version": 536870912,
    "previousHash": "000000000000000003a1b48cf612e8...",
    "merkleRoot": "7c5f9c5e8b8a5c3d2e1f0a9b8c7d6e...",
    "time": 1703001234,
    "bits": 403123456,
    "nonce": 2876543210,
    "height": 870125,
    "hash": "00000000000000000123456789abcd..."
  }
}
```

If hash not found:
```json
{
  "status": "success",
  "value": null
}
```

**Example:**
```bash
curl "http://localhost:3011/findHeaderHexForBlockHash?hash=00000000000000000123456789abcd..."
```

**Notes:**
- Only searches live storage (recent ~2000 blocks)
- Returns `null` if hash not found or in bulk storage
- For older headers, use `findHeaderHexForHeight` instead

---

### GET /getHeaders

Returns multiple block headers in serialized format starting from a specific height.

**Query Parameters:**
- `height` (required): Starting block height (integer)
- `count` (required): Number of headers to return (integer, max recommended: 1000)

**Response:**
```json
{
  "status": "success",
  "value": "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c..."
}
```

**Format:**
- Returns hex string of concatenated 80-byte block headers
- Each header is 80 bytes (160 hex characters)
- Total length: `count × 160` characters
- Headers are in order from `height` to `height + count - 1`

**Example:**
```bash
# Get 10 headers starting from height 800000
curl "http://localhost:3011/getHeaders?height=800000&count=10"
```

**Parsing the Response:**
```javascript
const response = await fetch('http://localhost:3011/getHeaders?height=800000&count=10')
const data = await response.json()
const headersHex = data.value

// Each header is 160 hex chars (80 bytes)
const headerSize = 160
const count = headersHex.length / headerSize

for (let i = 0; i < count; i++) {
  const start = i * headerSize
  const headerHex = headersHex.substring(start, start + headerSize)
  console.log(`Header ${800000 + i}: ${headerHex}`)
}
```

**Notes:**
- Efficient for bulk header downloads
- Use for SPV client synchronization
- Recommended to request in batches (e.g., 100-1000 headers)

---

### GET /getFiatExchangeRates

Returns current fiat exchange rates for BSV from configured services.

**Response:**
```json
{
  "status": "success",
  "value": {
    "timestamp": 1703001234000,
    "base": "BSV",
    "rates": {
      "USD": 45.23,
      "EUR": 41.87,
      "GBP": 35.92,
      "JPY": 6234.56
    }
  }
}
```

**Example:**
```bash
curl http://localhost:3011/getFiatExchangeRates
```

**Notes:**
- Response is never cached (Cache-Control: no-cache)
- Rates are fetched from external services
- May return empty object if services unavailable

---

### POST /addHeaderHex

Submits a new block header for consideration and processing.

**Request Body:**
```json
{
  "version": 536870912,
  "previousHash": "000000000000000003a1b48cf612e8...",
  "merkleRoot": "7c5f9c5e8b8a5c3d2e1f0a9b8c7d6e...",
  "time": 1703001234,
  "bits": 403123456,
  "nonce": 2876543210
}
```

**Response:**
```json
{
  "status": "success"
}
```

**Fields:**
- `version`: Block version number (integer)
- `previousHash`: Hash of previous block (hex string, 64 chars)
- `merkleRoot`: Merkle root (hex string, 64 chars)
- `time`: Block timestamp (Unix epoch seconds, integer)
- `bits`: Difficulty target in compact format (integer)
- `nonce`: Block nonce (integer)

**Example:**
```bash
curl -X POST http://localhost:3011/addHeaderHex \
  -H "Content-Type: application/json" \
  -d '{
    "version": 536870912,
    "previousHash": "000000000000000003a1b48cf612e8...",
    "merkleRoot": "7c5f9c5e8b8a5c3d2e1f0a9b8c7d6e...",
    "time": 1703001234,
    "bits": 403123456,
    "nonce": 2876543210
  }'
```

**Processing:**
- Header is queued for processing (returns immediately)
- Header is validated and inserted asynchronously
- If previous header is unknown, header is ignored
- Invalid headers are rejected silently

**Notes:**
- Response does not indicate if header was accepted/added
- Use for submitting newly mined blocks
- Header must have valid proof-of-work
- Previous header must already exist in storage

---

## Error Codes

### ERR_INTERNAL

Generic internal server error.

**Example:**
```json
{
  "status": "error",
  "code": "ERR_INTERNAL",
  "description": "An internal error has occurred."
}
```

**Common Causes:**
- Storage operation failed
- Invalid data format
- Unhandled exception

---

## Rate Limiting

The server does not implement rate limiting by default. For production use, consider:

- Reverse proxy with rate limiting (nginx, caddy)
- API gateway with rate limiting
- Application-level rate limiting middleware

---

## Caching

### Client-Side Caching

Most endpoints include cache headers:

**No Cache (dynamic data):**
```
Cache-Control: no-cache, no-store, must-revalidate
Pragma: no-cache
Expires: 0
```

Applies to:
- `/getInfo`
- `/getPresentHeight`
- `/findChainTipHashHex`
- `/findChainTipHeaderHex`
- `/getFiatExchangeRates`

**Cacheable (static data):**

No explicit cache headers. Clients may cache based on:
- Block height (immutable once confirmed)
- Block hash (immutable)

Applies to:
- `/findHeaderHexForHeight?height=N` (for heights < chain tip - 100)
- `/findHeaderHexForBlockHash?hash=H` (for deep blocks)
- `/getHeaders?height=N&count=M` (for heights < chain tip - 100)

### Server-Side Caching

The service implements internal caching:

- `getPresentHeight()`: Cached for 1 minute
- Block headers: Cached in memory (NoDb storage)
- Bulk files: Cached in memory (limited by `maxRetained`)

---

## WebSocket Support

The service does not currently support WebSocket connections. For real-time updates:

1. Poll `/getInfo` endpoint (recommended interval: 30-60 seconds)
2. Subscribe to events programmatically if using the service as a library
3. Implement custom WebSocket wrapper on top of the service

---

## Health Checks

### Basic Health Check

```bash
curl http://localhost:3011/getInfo
```

Check that:
- Response status is 200
- `status` field is "success"
- `heightLive` is increasing over time

### Synchronization Health

```bash
# Get present height (external blockchain height)
PRESENT=$(curl -s http://localhost:3011/getPresentHeight | jq -r .value)

# Get service height (internal height)
SERVICE=$(curl -s http://localhost:3011/getInfo | jq -r .value.heightLive)

# Calculate lag
LAG=$((PRESENT - SERVICE))

echo "Lag: $LAG blocks"

# Alert if lag > 10 blocks
if [ $LAG -gt 10 ]; then
  echo "WARNING: Service is lagging behind blockchain"
fi
```

---

## Performance Tips

### Bulk Header Downloads

For downloading many headers:

```javascript
// Good: Request in batches
const batchSize = 1000
for (let height = 0; height < targetHeight; height += batchSize) {
  const headers = await getHeaders(height, batchSize)
  processHeaders(headers)
}

// Bad: Request one at a time
for (let height = 0; height < targetHeight; height++) {
  const header = await findHeaderForHeight(height)
  processHeader(header)
}
```

### Caching Chain Tip

If you need chain tip frequently:

```javascript
// Cache chain tip for 10 seconds
let cachedTip = null
let cacheTime = 0

async function getChainTip() {
  const now = Date.now()
  if (!cachedTip || now - cacheTime > 10000) {
    cachedTip = await fetch('http://localhost:3011/findChainTipHeaderHex')
      .then(r => r.json())
      .then(d => d.value)
    cacheTime = now
  }
  return cachedTip
}
```

### Parallel Requests

The service handles concurrent requests well:

```javascript
// Good: Request in parallel
const [chainTip, height, info] = await Promise.all([
  getChainTipHeader(),
  getPresentHeight(),
  getInfo()
])

// Bad: Request sequentially
const chainTip = await getChainTipHeader()
const height = await getPresentHeight()
const info = await getInfo()
```

---

## Examples

### Complete Client Implementation

See `src/client-example.ts` for a complete TypeScript client implementation with all endpoints.

### cURL Examples

```bash
# Get service info
curl http://localhost:3011/getInfo | jq

# Get current height
curl http://localhost:3011/getPresentHeight | jq

# Get chain tip
curl http://localhost:3011/findChainTipHeaderHex | jq

# Get header by height
curl "http://localhost:3011/findHeaderHexForHeight?height=800000" | jq

# Get 10 headers
curl "http://localhost:3011/getHeaders?height=800000&count=10" | jq -r .value

# Submit new header
curl -X POST http://localhost:3011/addHeaderHex \
  -H "Content-Type: application/json" \
  -d @new-header.json
```

### JavaScript/Node.js Examples

```javascript
// Using fetch
const response = await fetch('http://localhost:3011/getInfo')
const data = await response.json()
console.log('Height:', data.value.heightLive)

// Using axios
const axios = require('axios')
const { data } = await axios.get('http://localhost:3011/getPresentHeight')
console.log('Height:', data.value)
```

### Python Examples

```python
import requests

# Get service info
response = requests.get('http://localhost:3011/getInfo')
data = response.json()
print(f"Height: {data['value']['heightLive']}")

# Get header by height
response = requests.get('http://localhost:3011/findHeaderHexForHeight',
                       params={'height': 800000})
header = response.json()['value']
print(f"Hash: {header['hash']}")
```

---

## Troubleshooting

### "Connection refused"

- Check server is running: `curl http://localhost:3011/`
- Verify port: Check `PORT` environment variable
- Check firewall settings

### "404 Not Found"

- Verify endpoint path is correct
- Check routing prefix configuration
- Ensure server has finished starting

### "500 Internal Server Error"

- Check server logs for errors
- Verify storage is initialized
- Check bulk ingestors are accessible

### Empty or null responses

- Service may still be synchronizing
- Check `/getInfo` for current state
- Wait for `heightLive` to increase

### Slow responses

- Service may be synchronizing
- Check network connectivity to CDN/WhatsOnChain
- Consider increasing `maxRetained` for better caching
