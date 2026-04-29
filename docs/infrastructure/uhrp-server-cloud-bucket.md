---
id: infra-uhrp-cloud
title: "UHRP Server (Cloud Bucket)"
kind: infra
version: "0.2.1"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [uhrp, storage, cloud, s3, production]
---

# UHRP Server (Cloud Bucket)

## Overview

Production-grade UHRP storage backed by cloud object storage (S3-compatible). Scales to petabytes of data with automatic replication and disaster recovery.

Built with `@bsv/uhrp-storage-server@0.2.1`.

## What It Does

- **Stores files** in cloud object storage (S3, GCS, Minio, etc.)
- **Serves files** by hash via HTTP
- **Handles geo-replication** across regions
- **Provides audit logs** of all operations
- **Supports access control** and fine-grained permissions
- **Scales automatically** with demand

## Supported Backends

- **Amazon S3** — Primary production storage
- **Google Cloud Storage** — GCS buckets
- **Azure Blob Storage** — Azure's object store
- **Minio** — Self-hosted S3-compatible storage
- **DigitalOcean Spaces** — DO's object storage
- **Wasabi** — High-performance S3 alternative

## Running with Docker

```bash
docker run -d \
  -e S3_BUCKET=my-uhrp-bucket \
  -e S3_REGION=us-west-2 \
  -e AWS_ACCESS_KEY_ID=<key> \
  -e AWS_SECRET_ACCESS_KEY=<secret> \
  -p 3002:3002 \
  bsv/uhrp-storage-server:0.2.1
```

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `S3_BUCKET` | Yes | — | Cloud bucket name |
| `S3_REGION` | Yes | — | Bucket region |
| `S3_ENDPOINT` | No | aws | S3 endpoint (aws, gcs, azure, minio) |
| `AWS_ACCESS_KEY_ID` | Yes | — | Cloud provider API key |
| `AWS_SECRET_ACCESS_KEY` | Yes | — | Cloud provider secret |
| `PORT` | No | 3002 | HTTP server port |
| `LOG_LEVEL` | No | info | Logging level |
| `CACHE_SIZE` | No | 10GB | Local cache size for hot files |
| `MAX_FILE_SIZE` | No | 5TB | Maximum file size |
| `METADATA_DB` | No | postgresql | Metadata store (postgresql, dynamodb) |

## Docker Compose with S3

```yaml
version: '3.8'
services:
  uhrp:
    image: bsv/uhrp-storage-server:0.2.1
    environment:
      S3_BUCKET: my-uhrp-bucket
      S3_REGION: us-west-2
      S3_ENDPOINT: aws
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      PORT: 3002
      CACHE_SIZE: 50GB
    ports:
      - "3002:3002"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3002/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Metadata Database

Store file metadata separately for fast queries:

### PostgreSQL Setup

```yaml
postgres:
  image: postgres:14
  environment:
    POSTGRES_DB: uhrp_metadata
    POSTGRES_PASSWORD: uhrppass
  volumes:
    - postgres_data:/var/lib/postgresql/data

# Add to uhrp service:
# METADATA_DB: postgresql://postgres:uhrppass@postgres:5432/uhrp_metadata
```

### DynamoDB Setup

```
METADATA_DB: dynamodb://uhrp-metadata
AWS_REGION: us-west-2
```

## Database Schema

PostgreSQL table for file metadata:

```
files
  id UUID PRIMARY KEY,
  hash CHAR(64) UNIQUE,
  size BIGINT,
  uploaded_by VARCHAR(255),
  created_at TIMESTAMP,
  expires_at TIMESTAMP,
  is_public BOOLEAN,
  metadata JSONB,
  INDEX (hash),
  INDEX (created_at DESC)
```

## Endpoints

- `POST /store` — Upload file
- `GET /{hash}` — Download file (cached locally)
- `HEAD /{hash}` — Check availability
- `DELETE /{hash}` — Delete file (with auth)
- `GET /health` — Health check
- `GET /stats` — Storage statistics

For full API details, see [UHRP Spec](/docs/specs/uhrp/).

## Geo-replication

Enable multi-region replication:

```yaml
replication:
  enabled: true
  regions:
    - us-west-2    # Primary
    - eu-west-1    # Europe
    - ap-south-1   # Asia
  policy: "replicate-all"
```

## Monitoring

Health endpoint includes storage stats:

```bash
curl http://localhost:3002/health
{
  "status": "healthy",
  "uptime": 172800,
  "files_stored": 1250000,
  "total_size_bytes": 5368709120000,
  "cache_hit_ratio": 0.85,
  "s3_latency_ms": 45
}
```

## Performance Tuning

- **Local cache** — Increase cache size for hot files
- **Concurrent uploads** — Configure upload concurrency
- **Compression** — Enable for text/metadata files
- **CDN** — Use CloudFront or Cloudflare for distribution

## Cost Optimization

- **S3 storage class** — Use Glacier for cold files
- **Intelligent tiering** — AWS moves files automatically
- **Compression** — Reduces storage costs
- **Deduplication** — Share identical files (by hash)

## Security

- **Bucket encryption** — Enable AES-256 at rest
- **IAM policies** — Restrict access to specific buckets
- **Signed URLs** — Time-limited download links
- **Audit logging** — S3 access logs to separate bucket
- **Private bucket** — Disable public access

## Upgrading

1. Update image version
2. Deploy new service alongside existing
3. Run migration script to sync bucket
4. Update DNS to point to new service
5. Monitor for issues, roll back if needed

## Troubleshooting

**Slow downloads**: Check cache hit ratio, enable local caching.

**S3 access errors**: Verify AWS credentials and bucket permissions.

**Metadata sync failures**: Check database connectivity and disk space.

**High storage costs**: Analyze usage, transition old files to cheaper tier.

## References

- [UHRP Basic Server](/docs/infrastructure/uhrp-server-basic/)
- [UHRP Specification](/docs/specs/uhrp/)
- [AWS S3 Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/)
