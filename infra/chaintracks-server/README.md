# ChaintracksService with Bulk Headers CDN

A production-ready TypeScript Express server wrapping `ChaintracksService` from `@bsv/wallet-toolbox`, featuring a built-in **Bulk Headers CDN** for hosting and serving blockchain headers to other servers.

ChainTracks supports mainnet, testnet, STN, TerraTestNet (`ttn`), and Terra
Scaling TestNet (`tstn`). Mainnet, testnet, and TTN use public credential-free
Arcade/go-chaintracks v2 sources by default. STN and TSTN require an explicit
operator endpoint and are never silently mapped to testnet.

Resource profiles, limits, memory evidence, and scaling guidance are documented
in [Service Resource Profiles](../../docs/reference/service-resource-profiles.md).

## 🚀 Quick Start

### Docker (Recommended)

```bash
# Clone and start
git clone <repository-url>
cd chaintracks-server
docker compose up -d

# That's it! Services are now running:
# - ChaintracksService API: http://localhost:3011
# - Bulk Headers CDN: http://localhost:3012
```

See [DOCKER.md](DOCKER.md) for complete Docker documentation.

### Manual Setup

```bash
# Install dependencies
npm install

# Build
npm run build

# Configure
cp .env.example .env
nano .env

# Start
npm start
```

## 📋 Overview

This server provides two main services:

### 1. ChaintracksService (Port 3011)

- **Tracks BSV blockchain headers** in real-time
- **Validated local header storage** - no database service required
- **REST API endpoints** for querying headers
- **Automatic sync** with BSV blockchain
- **Event subscriptions** for headers and reorgs

### 2. Bulk Headers CDN (Port 3012)

- **Hosts bulk header files** for download by other servers
- **Automatic export** at 100k block boundaries
- **Self-hosting CDN** - becomes a headers source for others
- **Persistent storage** with Docker volumes
- **Public browser access** by default, with opt-in exact origin restriction

## ✨ Key Features

### 🌐 Self-Hosting CDN Network

Your server can become a CDN node:

1. Reads and validates retained immutable header objects before the network
2. Coalesces a missing object's callers into one bounded remote download
3. Writes only validated objects to persistent storage using atomic replacement
4. Serves headers to other servers via HTTP
5. Creates a distributed network of header sources

### 📦 Automatic Header Management

- Reads retained objects before `SOURCE_CDN_URL` and downloads only a miss
- Validates object digest, genesis, linkage, chain work, and proof of work in a
  bounded worker pool
- Caps response bodies and retries, and durably reserves every physical
  attempt before network I/O
- Stores verified objects by digest, quarantines rejected bytes, and retains
  last-good objects until later garbage collection
- Exports to filesystem automatically
- Serves via CDN on port 3012
- Updates every 67 hours (400 blocks)
- Triggers export at 100k boundaries

### 🔄 Zero-Config Synchronization

- Mainnet/testnet: uses the CDN plus public Arcade binary and SSE APIs
- TTN: uses the public Arcade binary and SSE APIs
- Subsequent runs reuse the verified persistent cache
- Automatically exports new headers
- Other servers can use you as a source
- WhatsOnChain is a mainnet/testnet fallback and does not require a key

Remote headers pass through local serialization, hash, continuity, genesis,
chain-work, and proof-of-work checks before storage. Source failures fall
through in priority order, SSE
reconnects with bounded backoff, and a synchronized process keeps serving
last-good checked data while reporting degraded sources from `/getInfo` and
`/readyz`.

Arcade is the HTTPS/SSE gateway suitable for Node.js, browsers, mobile clients,
and local services. It may be backed by Teranode P2P. Direct Teranode P2P is not
bundled into this TypeScript/browser distribution.

## 🎯 Architecture

```
┌──────────────────────────────────────────┐
│  Other Servers (your clients)            │
│  SOURCE_CDN_URL=http://yourserver:3012   │
└────────────┬─────────────────────────────┘
             │ Download headers
             ↓
┌──────────────────────────────────────────┐
│  YOUR Server                              │
│  ┌────────────────────────────────────┐  │
│  │ ChaintracksService (Port 3011)     │  │
│  │ - API endpoints                    │  │
│  │ - Header queries                   │  │
│  │ - Real-time sync                   │  │
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │ CDN Server (Port 3012)             │  │
│  │ - Serves bulk header files         │  │
│  │ - mainNetBlockHeaders.json         │  │
│  │ - mainNet_0.headers, etc.          │  │
│  └────────────────────────────────────┘  │
│                                           │
│  Downloads from (if needed):              │
│  SOURCE_CDN_URL=https://headers.example │
└──────────────────────────────────────────┘
```

## 📡 API Endpoints

### ChaintracksService API (Port 3011)

All endpoints return JSON with `{ status: "success", value: <data> }` or `{ status: "error", code: "...", description: "..." }`

#### Chain Information

- `GET /getChain` - Get blockchain network (`main`, `test`, `stn`, `ttn`, or `tstn`)
- `GET /getInfo` - Detailed service information
- `GET /getPresentHeight` - Latest available height
- `GET /readyz` - Readiness, height, and source-health state

#### Header Queries

- `GET /findChainTipHeaderHex` - Get chain tip header as hex
- `GET /findChainTipHashHex` - Get chain tip hash as hex
- `GET /findHeaderHexForHeight?height=N` - Get header at height N as hex
- `GET /findHeaderHexForBlockHash?hash=HASH` - Get header by hash as hex (⚠️ **Limited to recent/retained headers in memory**)
- `GET /getHeaders?height=N&count=M` - Get M headers from height N (returns hex string)
- `POST /addHeaderHex` - Submit a new block header (JSON body with version, previousHash, merkleRoot, time, bits, nonce)

**Note:** The `findHeaderHexForBlockHash` endpoint only works for headers currently retained in memory:

- Recent headers within ~2,000 blocks of chain tip ("live" headers)
- Headers in the most recently retained bulk files (~200k headers with default `maxRetained: 2`)
- For querying arbitrary historical headers, use `findHeaderHexForHeight?height=N` instead

### Bulk Headers CDN (Port 3012)

Static file server for bulk headers:

- `GET /mainNetBlockHeaders.json` - Metadata file with file list
- `GET /mainNet_0.headers` - First 100k headers (heights 0-99,999)
- `GET /mainNet_1.headers` - Next 100k headers (heights 100,000-199,999)
- `GET /mainNet_N.headers` - N-th 100k header file

Each `.headers` file contains 100,000 consecutive 80-byte block headers.

## ⚙️ Configuration

### Environment Variables

Create `.env` file (copy from `.env.example`):

```bash
# Chain selection
CHAIN=main  # main | test | stn | ttn | tstn

# Server port (ChaintracksService)
PORT=3011

# Optional. Anonymous fallback is capped below the documented 3 requests/sec.
WHATSONCHAIN_API_KEY=

# Optional go-chaintracks v2 override. Public defaults exist for main/test/ttn.
# Required for stn/tstn unless the matching Arcade/ChainTracks URL is set.
CHAINTRACKS_UPSTREAM_URL=
CHAINTRACKS_UPSTREAM_API_PREFIX=
CHAINTRACKS_UPSTREAM_MAX_HEADERS=1000
CHAINTRACKS_DISABLE_WHATSONCHAIN=false
STN_ARCADE_URL=
STN_CHAINTRACKS_URL=
TSTN_ARCADE_URL=
TSTN_CHAINTRACKS_URL=

# SOURCE_CDN_URL - Where to download headers FROM (if local files don't exist)
SOURCE_CDN_URL=https://cdn.projectbabbage.com/blockheaders/
CHAINTRACKS_BULK_FILE_CACHE=true
CHAINTRACKS_UPSTREAM_DOWNLOAD_MAX_BYTES_PER_HOUR=536870912
CHAINTRACKS_VALIDATION_WORKERS=1
CHAINTRACKS_VALIDATION_QUEUE_MAX=8
CHAINTRACKS_HISTORICAL_RATE_LIMIT_WINDOW_MS=60000
CHAINTRACKS_HISTORICAL_RATE_LIMIT_MAX=600
CHAINTRACKS_HISTORICAL_MAX_CONCURRENT_REQUESTS=8
# Set only for a deployment whose direct peers are trusted proxies.
TRUST_PROXY_HOPS=

# ENABLE_BULK_HEADERS_CDN - Enable CDN hosting
ENABLE_BULK_HEADERS_CDN=true

# CDN_HOST_URL - Public URL where YOUR CDN is accessible
# This is written to JSON rootFolder field
CDN_HOST_URL=https://headers.yourdomain.com

# BULK_HEADERS_PATH - Durable cache, ledger, quarantine, and CDN snapshot root
# Default: ./public/headers
BULK_HEADERS_PATH=

# Auto-export interval (default: 240000000ms = 67 hours)
BULK_HEADERS_AUTO_EXPORT_INTERVAL=240000000
```

### Production Configuration

**For production with a domain:**

```bash
CHAIN=main
PORT=3011
WHATSONCHAIN_API_KEY=
ENABLE_BULK_HEADERS_CDN=true
CDN_HOST_URL=https://headers.yourdomain.com
SOURCE_CDN_URL=https://cdn.projectbabbage.com/blockheaders/
CHAINTRACKS_BULK_FILE_CACHE=true
CHAINTRACKS_UPSTREAM_DOWNLOAD_MAX_BYTES_PER_HOUR=536870912
CHAINTRACKS_VALIDATION_WORKERS=1
CHAINTRACKS_VALIDATION_QUEUE_MAX=8
CHAINTRACKS_HISTORICAL_RATE_LIMIT_MAX=600
CHAINTRACKS_HISTORICAL_MAX_CONCURRENT_REQUESTS=8
```

**Setup nginx reverse proxy:**

```nginx
# CDN Server
server {
    listen 443 ssl;
    server_name headers.yourdomain.com;

    location / {
        proxy_pass http://localhost:3012;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

# API Server
server {
    listen 443 ssl;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:3011;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 🐳 Docker Deployment

Complete Docker setup with persistent volumes and auto-restart:

```bash
# Start with docker-compose
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down

# Update
git pull && docker compose up -d --build
```

See [DOCKER.md](DOCKER.md) for comprehensive Docker documentation.

## 📚 How It Works

### First Startup

1. The server opens `BULK_HEADERS_PATH` and constructs the persistent cache.
2. Each required object is loaded from retained storage before the network.
3. A cache miss durably reserves each physical attempt, performs one coalesced
   bounded download, and validates the complete object in a worker before an
   atomic content-addressed cache write.
4. ChainTracks synchronizes validated headers to the current height.
5. The optional CDN publishes and serves a complete immutable generation on
   port 3012; a crash before the atomic pointer swap leaves the previous
   generation active.

### Subsequent Startups

1. The server reopens `BULK_HEADERS_PATH`.
2. Retained objects are digest-, linkage-, and proof-of-work-validated on first
   use and do not generate a remote bulk download.
3. Synchronization resumes from the last durable height.
4. New immutable objects are exported at 100k boundaries.

### Release sequencing

The resilient server path requires `@bsv/wallet-toolbox` 2.9.0 or later. The
standalone image lock is reconciled only after that protected npm candidate is
published. Until the lock contains that version, the server can start in an
explicit compatibility mode for CI and release sequencing, but it uses the
older in-process validator and process-local budget. Do not publish or deploy
the Chaintracks Server 1.1.10 image until `package-lock.json` resolves the
resilient Wallet Toolbox release and startup logs
`resilient_bulk_runtime_active: true`.

### Becoming a CDN Source

Other servers can now point to YOUR server:

```bash
# On other servers
SOURCE_CDN_URL=https://headers.yourdomain.com
```

This creates a **distributed CDN network** where servers help each other!

## 📦 File Structure

### Bulk Headers Directory

```
public/headers/
├── mainNetBlockHeaders.json       # Metadata with file list
├── mainNet_0.headers              # Heights 0-99,999 (7.6 MB)
├── mainNet_1.headers              # Heights 100,000-199,999 (7.6 MB)
├── mainNet_2.headers              # Heights 200,000-299,999 (7.6 MB)
└── ...                            # More files as blockchain grows
```

### JSON Metadata Format

```json
{
  "rootFolder": "https://headers.yourdomain.com",
  "jsonFilename": "mainNetBlockHeaders.json",
  "headersPerFile": 100000,
  "files": [
    {
      "fileName": "mainNet_0.headers",
      "firstHeight": 0,
      "count": 100000,
      "prevHash": "000...000",
      "lastHash": "000...250",
      "fileHash": "DMX...",
      "sourceUrl": "https://headers.yourdomain.com"
    }
  ]
}
```

## 🔧 Development

### Build

```bash
npm run build
```

### Run Different Configurations

```bash
# Standard server (port 3011)
npm start

# Test network
npm run start:test

# Development with auto-reload
npm run dev
```

### Project Structure

```
├── src/
│   ├── server.ts              # Main server with CDN
│   ├── v1-routes.ts           # Legacy RPC-style routes
│   └── v2-routes.ts           # RESTful + binary v2 routes
├── dist/                      # Compiled JavaScript
├── public/
│   └── headers/              # Exported bulk headers
├── Dockerfile                # Docker build
├── docker-compose.yml        # Docker services
├── .env.example              # Configuration template
├── .env.docker               # Docker-specific template
├── DOCKER.md                 # Docker documentation
└── README.md                 # This file
```

## 🌐 Network Setup

### Using This Server as a CDN Source

Other servers can use your server by setting:

```bash
SOURCE_CDN_URL=http://yourserver:3012
# or
SOURCE_CDN_URL=https://headers.yourdomain.com
```

### Distributed Network Example

**Server A (Public CDN):**

```bash
ENABLE_BULK_HEADERS_CDN=true
CDN_HOST_URL=https://cdn.example.com
SOURCE_CDN_URL=https://cdn.projectbabbage.com/blockheaders/
```

**Server B (Uses Server A):**

```bash
ENABLE_BULK_HEADERS_CDN=true
CDN_HOST_URL=https://headers-b.example.com
SOURCE_CDN_URL=https://cdn.example.com  # Points to Server A
```

**Server C (Uses Server B):**

```bash
ENABLE_BULK_HEADERS_CDN=true
CDN_HOST_URL=https://headers-c.example.com
SOURCE_CDN_URL=https://headers-b.example.com  # Points to Server B
```

Creates a **self-healing, distributed CDN network**! 🌍

## 📊 Resource Requirements

### Minimum

- **CPU:** 1 core
- **RAM:** 2 GB
- **Disk:** 5 GB (for headers)

### Recommended

- **CPU:** 2 cores
- **RAM:** 4 GB
- **Disk:** 10 GB (with growth room)

### Storage Growth

- ~7.6 MB per 100k blocks
- Current blockchain: ~920k blocks = ~70 MB
- Growth: ~7.6 MB per ~67 days (at 10 min blocks)

## 🔍 Monitoring

### Check Service Status

```bash
# API health
curl http://localhost:3011/getInfo

# Cache/download counters and readiness source state
curl http://localhost:3011/readyz

# CDN health
curl http://localhost:3012/mainNetBlockHeaders.json
```

### View Logs (Docker)

```bash
docker compose logs -f
```

### View Exported Files

```bash
ls -lh public/headers/
```

## 🆘 Troubleshooting

### Headers Not Exporting

- Check `ENABLE_BULK_HEADERS_CDN=true` in `.env`
- Check logs for export messages
- Verify disk space available
- Restart server to trigger export

### CDN Files Not Accessible

- Verify CDN server running on port 3012
- Check firewall rules
- Test locally: `curl http://localhost:3012/mainNetBlockHeaders.json`

### Slow Sync

- Check the configured Arcade/go-chaintracks source and `/readyz` source states
- Check `SOURCE_CDN_URL` is reachable
- Check `bulkData.persistentCacheRejects` and the upstream byte budget before
  raising either limit
- Verify network connectivity

The service does not need a WhatsOnChain key. If one is configured and rejected,
ChainTracks retries anonymously; remove stale keys unless higher paid limits are
actually needed.

### Docker Issues

See [DOCKER.md](DOCKER.md) troubleshooting section.

## 📖 Additional Documentation

- [DOCKER.md](DOCKER.md) - Complete Docker deployment guide
- [API.md](API.md) - Detailed API documentation
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture details

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📄 License

[Open BSV License Version 6](./LICENSE.txt)

## 🔗 Resources

- [@bsv/wallet-toolbox](https://www.npmjs.com/package/@bsv/wallet-toolbox)
- [BSV Documentation](https://docs.bsvblockchain.org/)
- [WhatsOnChain API](https://developers.whatsonchain.com/)

## 🎉 Acknowledgments

Built with [@bsv/wallet-toolbox](https://www.npmjs.com/package/@bsv/wallet-toolbox) by the BSV team.
