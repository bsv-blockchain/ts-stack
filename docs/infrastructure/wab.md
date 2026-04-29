---
id: infra-wab
title: "Wallet Abstraction Backend (WAB)"
kind: infra
version: "1.4.1"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [wallet, http, abstraction, brc-100, service]
---

# Wallet Abstraction Backend (WAB)

## Overview

Wallet Abstraction Backend is a server-side HTTP wallet that implements the BRC-100 WalletInterface. Instead of embedding wallet logic in your application, WAB provides wallet functionality as a microservice accessible via HTTP.

Built with `@bsv/wab-server@1.4.1`.

## What It Does

- **Implements BRC-100** — Full WalletInterface over HTTP
- **Manages keys** — Store, derive, and rotate keys
- **Creates actions** — Build transactions with UTXO management
- **Signs transactions** — BIP-32 deterministic signing
- **Encrypts data** — AES encryption using derived keys
- **Computes HMAC** — Message authentication codes
- **Manages UTXOs** — Automatic UTXO tracking and spending

## When to Use

- Shared wallet service across multiple applications
- Key management as a service
- Wallet backup and recovery
- Compliance and audit requirements
- Mobile app backend

## Running with Docker

```bash
docker run -d \
  -e DATABASE_URL=postgresql://user:pass@postgres:5432/wab \
  -e MASTER_KEY_ENCRYPTED=<encrypted-key> \
  -e JWT_SECRET=<your-jwt-secret> \
  -p 3003:3003 \
  bsv/wab-server:1.4.1
```

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `MASTER_KEY_ENCRYPTED` | Yes | — | Encrypted master key (see key setup below) |
| `JWT_SECRET` | Yes | — | Secret for signing JWT tokens |
| `PORT` | No | 3003 | HTTP server port |
| `LOG_LEVEL` | No | info | Logging level |
| `KEY_DERIVATION_PATH` | No | m/44'/0'/0' | Default BIP-32 path |
| `MAX_ACTIVE_WALLETS` | No | 1000 | Maximum concurrent wallets |

## Master Key Setup

Generate and encrypt your master key:

```bash
# Generate new key
openssl rand -hex 32

# Encrypt it (WAB will ask for password)
wab-encrypt --key <your-random-key>
# Output: eyJjdHkiOiJhZXMtMjU2LWdjbSIsIml2IjoiLi4uIn0=

export MASTER_KEY_ENCRYPTED="eyJjdHkiOiJhZXMtMjU2LWdjbSIsIml2IjoiLi4uIn0="
```

## Docker Compose Example

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_DB: wab
      POSTGRES_PASSWORD: wabpass
    volumes:
      - postgres_data:/var/lib/postgresql/data

  wab:
    image: bsv/wab-server:1.4.1
    environment:
      DATABASE_URL: postgresql://postgres:wabpass@postgres:5432/wab
      MASTER_KEY_ENCRYPTED: ${MASTER_KEY_ENCRYPTED}
      JWT_SECRET: ${JWT_SECRET}
      PORT: 3003
    ports:
      - "3003:3003"
    depends_on:
      - postgres
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3003/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  postgres_data:
```

## Database Schema

PostgreSQL tables for wallet state:

```
wallets
  id UUID PRIMARY KEY,
  user_id VARCHAR(255),
  name VARCHAR(255),
  created_at TIMESTAMP,
  last_accessed TIMESTAMP

keys
  id UUID PRIMARY KEY,
  wallet_id UUID REFERENCES wallets,
  key_path VARCHAR(255),
  public_key CHAR(66),
  derived BOOLEAN,
  created_at TIMESTAMP,
  INDEX (wallet_id)

actions
  id UUID PRIMARY KEY,
  wallet_id UUID REFERENCES wallets,
  description TEXT,
  outputs JSONB,
  signed BOOLEAN,
  broadcast BOOLEAN,
  created_at TIMESTAMP,
  INDEX (wallet_id)

utxos
  id UUID PRIMARY KEY,
  wallet_id UUID REFERENCES wallets,
  txid CHAR(64),
  vout INT,
  satoshis BIGINT,
  script BYTEA,
  spent BOOLEAN,
  spent_at TIMESTAMP,
  UNIQUE (txid, vout)
```

## API Endpoints

### Wallet Management
- `POST /wallets` — Create wallet
- `GET /wallets/{walletId}` — Get wallet info
- `DELETE /wallets/{walletId}` — Delete wallet

### Key Operations (BRC-100)
- `GET /wallets/{walletId}/keys` — List keys
- `POST /wallets/{walletId}/keys/public` — Get public key
- `POST /wallets/{walletId}/keys/derive` — Derive new key

### Transaction Operations (BRC-100)
- `POST /wallets/{walletId}/actions/create` — Create action
- `POST /wallets/{walletId}/actions/{actionId}/sign` — Sign action
- `POST /wallets/{walletId}/actions/{actionId}/broadcast` — Broadcast

### Cryptography (BRC-100)
- `POST /wallets/{walletId}/encrypt` — Encrypt data
- `POST /wallets/{walletId}/decrypt` — Decrypt data
- `POST /wallets/{walletId}/hmac` — Generate HMAC
- `POST /wallets/{walletId}/signature` — Sign message

For full API details, see [BRC-100 Spec](/docs/specs/brc-100-wallet/).

## Authentication

All endpoints require JWT bearer token:

```bash
curl -H "Authorization: Bearer <jwt-token>" \
  http://localhost:3003/wallets
```

Obtain token via:

```bash
curl -X POST http://localhost:3003/auth \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user123", "password": "password"}'
```

## UTXO Management

WAB automatically tracks UTXOs:

```bash
# Get available UTXOs
curl http://localhost:3003/wallets/{id}/utxos

# Manually add UTXO
curl -X POST http://localhost:3003/wallets/{id}/utxos \
  -d '{"txid": "...", "vout": 0, "satoshis": 1000, "script": "..."}'

# Mark UTXO as spent
curl -X DELETE http://localhost:3003/wallets/{id}/utxos/{txid}/{vout}
```

## Monitoring

Health endpoint returns wallet statistics:

```bash
curl http://localhost:3003/health
{
  "status": "healthy",
  "uptime": 86400,
  "active_wallets": 42,
  "total_keys": 156,
  "total_utxos": 8934,
  "total_satoshis": 50000000,
  "db_latency_ms": 5
}
```

## Security Considerations

- **HTTPS required** in production
- **Master key rotation** — Implement key rotation policy
- **Database encryption** — PostgreSQL encryption at rest
- **JWT expiry** — Short-lived tokens (5-15 minutes)
- **Rate limiting** — Per-user request limits
- **Audit logging** — Log all key operations

## Upgrading

1. Backup PostgreSQL database
2. Pull new image
3. Run migrations: `docker compose run wab npm run migrate`
4. Restart service

## Troubleshooting

**JWT token errors**: Verify JWT_SECRET matches across instances.

**Database connection issues**: Check DATABASE_URL and PostgreSQL credentials.

**Slow signing**: Monitor database performance, increase connection pool.

**Out of memory**: Reduce MAX_ACTIVE_WALLETS, enable garbage collection.

## References

- [BRC-100 Wallet Interface](/docs/specs/brc-100-wallet/)
- [Wallet Infrastructure](/docs/infrastructure/wallet-infra/)
- [Building Wallet-Aware Apps](/docs/guides/wallet-aware-app/)
