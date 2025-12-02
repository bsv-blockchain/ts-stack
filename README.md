# ChaintracksService with Bulk Headers CDN

A production-ready TypeScript Express server wrapping `ChaintracksService` from `@bsv/wallet-toolbox`, featuring a built-in **Bulk Headers CDN** for hosting and serving blockchain headers to other servers.

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
- **In-memory NoDb storage** - no database required
- **REST API endpoints** for querying headers
- **Automatic sync** with BSV blockchain
- **Event subscriptions** for headers and reorgs

### 2. Bulk Headers CDN (Port 3012)
- **Hosts bulk header files** for download by other servers
- **Automatic export** at 100k block boundaries
- **Self-hosting CDN** - becomes a headers source for others
- **Persistent storage** with Docker volumes
- **CORS enabled** for cross-origin access

## ✨ Key Features

### 🌐 Self-Hosting CDN Network
Your server can become a CDN node:
1. Downloads headers from remote CDN (if local files don't exist)
2. Exports headers to filesystem
3. Serves headers to other servers via HTTP
4. Creates a distributed network of header sources

### 📦 Automatic Header Management
- Downloads from `SOURCE_CDN_URL` on first startup
- Exports to filesystem automatically
- Serves via CDN on port 3012
- Updates every 67 hours (400 blocks)
- Triggers export at 100k boundaries

### 🔄 Zero-Config Synchronization
- First run: Downloads from remote CDN
- Subsequent runs: Uses local filesystem
- Automatically exports new headers
- Other servers can use you as a source

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
│  SOURCE_CDN_URL=https://cdn.babbage.com  │
└──────────────────────────────────────────┘
```

## 📡 API Endpoints

### ChaintracksService API (Port 3011)

All endpoints return JSON with `{ status: "success", value: <data> }` or `{ status: "error", code: "...", description: "..." }`

#### Chain Information
- `GET /getChain` - Get blockchain network ('main' or 'test')
- `GET /getInfo` - Detailed service information
- `GET /getPresentHeight` - Latest available height

#### Header Queries
- `GET /findChainTipHeaderHex` - Get chain tip header as hex
- `GET /findChainTipHashHex` - Get chain tip hash as hex
- `GET /findHeaderHexForHeight?height=N` - Get header at height N as hex
- `GET /findHeaderHexForBlockHash?hash=HASH` - Get header by hash as hex
- `GET /getHeaders?height=N&count=M` - Get M headers from height N (returns hex string)
- `POST /addHeaderHex` - Submit a new block header (JSON body with version, previousHash, merkleRoot, time, bits, nonce)

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
CHAIN=main  # or 'test'

# Server port (ChaintracksService)
PORT=3011

# WhatsOnChain API Key (recommended for production)
WHATSONCHAIN_API_KEY=your_api_key_here

# SOURCE_CDN_URL - Where to download headers FROM (if local files don't exist)
SOURCE_CDN_URL=https://cdn.projectbabbage.com/blockheaders/

# ENABLE_BULK_HEADERS_CDN - Enable CDN hosting
ENABLE_BULK_HEADERS_CDN=true

# CDN_HOST_URL - Public URL where YOUR CDN is accessible
# This is written to JSON rootFolder field
CDN_HOST_URL=https://headers.yourdomain.com

# BULK_HEADERS_PATH - Where to store/serve header files
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
WHATSONCHAIN_API_KEY=your_api_key
ENABLE_BULK_HEADERS_CDN=true
CDN_HOST_URL=https://headers.yourdomain.com
SOURCE_CDN_URL=https://cdn.projectbabbage.com/blockheaders/
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
1. Server starts and checks `./public/headers` for existing files
2. No files found, downloads from `SOURCE_CDN_URL`
3. Syncs blockchain headers to current height
4. Exports all headers to `./public/headers`
5. CDN server starts serving files on port 3012

### Subsequent Startups
1. Server starts and checks `./public/headers`
2. Finds existing files, loads them directly (no download!)
3. Continues syncing from last height
4. Automatically exports new headers at 100k boundaries

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
│   └── client-example.ts      # Example client
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
- Add `WHATSONCHAIN_API_KEY` for better rate limits
- Check `SOURCE_CDN_URL` is reachable
- Verify network connectivity

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

MIT License - see LICENSE file for details

## 🔗 Resources

- [@bsv/wallet-toolbox](https://www.npmjs.com/package/@bsv/wallet-toolbox)
- [BSV Documentation](https://docs.bsvblockchain.org/)
- [WhatsOnChain API](https://developers.whatsonchain.com/)

## 🎉 Acknowledgments

Built with [@bsv/wallet-toolbox](https://www.npmjs.com/package/@bsv/wallet-toolbox) by the BSV team.
