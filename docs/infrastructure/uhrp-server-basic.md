---
id: infra-uhrp-basic
title: "UHRP Server (Basic)"
kind: infra
version: "0.1.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: beta
tags: [uhrp, storage, file-server, development]
---

# UHRP Server (Basic)

## Overview

A lightweight UHRP implementation for development and testing. Uses local filesystem storage, making it quick to deploy for development environments.

Built with `@bsv/uhrp-lite@0.1.0`.

## What It Does

- **Stores files** on local disk by content hash
- **Serves files** by hash via HTTP GET
- **Verifies integrity** by checking hash on retrieval
- **Simple metadata** without database
- **Quick deployment** for testing

## When to Use

- Local development
- Testing UHRP client code
- Proof-of-concept deployments
- Single-server setups

## Not Recommended For

- Production use
- Large file volumes
- Multiple-server deployments
- Long-term storage

## Running with Docker

```bash
docker run -d \
  -v uhrp_data:/data \
  -p 3002:3002 \
  bsv/uhrp-lite:0.1.0
```

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PORT` | No | 3002 | HTTP server port |
| `STORAGE_PATH` | No | /data | Directory for file storage |
| `LOG_LEVEL` | No | info | Logging level |
| `MAX_FILE_SIZE` | No | 1GB | Maximum file size |

## Docker Compose Example

```yaml
version: '3.8'
services:
  uhrp:
    image: bsv/uhrp-lite:0.1.0
    environment:
      PORT: 3002
      STORAGE_PATH: /data
    ports:
      - "3002:3002"
    volumes:
      - uhrp_data:/data

volumes:
  uhrp_data:
```

## Endpoints

- `POST /store` — Upload file
- `GET /{hash}` — Download file
- `HEAD /{hash}` — Check availability
- `GET /health` — Health check

For full API details, see [UHRP Spec](/docs/specs/uhrp/).

## Storage Structure

Files stored in the filesystem:

```
/data/
  sha256/
    abc123.../
      metadata.json
      file
    def456.../
      metadata.json
      file
```

## Performance

- **Throughput** — Limited by disk I/O (50-200 MB/s depending on hardware)
- **Concurrent uploads** — No built-in limit, limited by available disk space
- **File discovery** — O(1) for known hashes, no directory listing

## Upgrading to Production

When you outgrow this server, switch to the cloud-bucket version:

1. Export file list from basic server
2. Migrate files to cloud storage
3. Deploy cloud-bucket version
4. Update client URLs to point to new server

## Troubleshooting

**Disk full**: Monitor available space, implement archival policy.

**Slow transfers**: Check disk speed and network bandwidth.

**File corruption**: The server doesn't recover corrupted files; restore from backup.

## References

- [UHRP Cloud Bucket Server](/docs/infrastructure/uhrp-server-cloud-bucket/)
- [UHRP Specification](/docs/specs/uhrp/)
