---
id: infra-message-box-server
title: "Message-box Server"
kind: infra
version: "1.1.5"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [messaging, overlay, store-and-forward, service]
---

# Message-box Server

## Overview

The Message-box Server hosts the MessageBox overlay, providing authenticated, store-and-forward messaging. It accepts messages from senders, stores them temporarily, and delivers them to recipients when they come online.

Built with `@bsv/messagebox-server@1.1.5`, this service implements the Message-box HTTP API.

## What It Does

- **Receives messages** from authenticated senders
- **Verifies signatures** using BRC-31 authentication
- **Encrypts and stores** messages in a database
- **Delivers messages** to recipients on request
- **Handles retries** for failed deliveries
- **Publishes overlay topics** for message availability

## Running with Docker

```bash
docker run -d \
  -e MONGODB_URI=mongodb://mongo:27017/messagebox \
  -e WALLET_ID=<your-wallet-id> \
  -e PRIVATE_KEY=<your-private-key> \
  -p 3000:3000 \
  bsv/messagebox-server:1.1.5
```

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `MONGODB_URI` | Yes | — | Connection string to MongoDB |
| `WALLET_ID` | Yes | — | Wallet identifier for this server |
| `PRIVATE_KEY` | Yes | — | Server's private key for signing |
| `PORT` | No | 3000 | HTTP server port |
| `LOG_LEVEL` | No | info | Logging level (debug, info, warn, error) |
| `MESSAGE_TTL` | No | 604800 | Message lifetime in seconds (7 days) |
| `OVERLAY_TOPIC` | No | messagebox | Overlay topic for announcements |

## Database Schema

MongoDB collections:

```
messagebox/messages
  {
    _id: ObjectId,
    messageId: string,
    senderId: string,
    recipientId: string,
    subject: string,
    body: string (encrypted),
    signature: string,
    delivered: boolean,
    createdAt: Date,
    expiresAt: Date
  }

messagebox/recipients
  {
    _id: ObjectId,
    walletId: string,
    inbox: [messageId],
    read: [messageId]
  }
```

## Docker Compose Example

```yaml
version: '3.8'
services:
  mongo:
    image: mongo:5.0
    environment:
      MONGO_INITDB_DATABASE: messagebox
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db

  messagebox:
    image: bsv/messagebox-server:1.1.5
    environment:
      MONGODB_URI: mongodb://mongo:27017/messagebox
      WALLET_ID: wallet-001
      PRIVATE_KEY: ${MESSAGEBOX_PRIVATE_KEY}
      PORT: 3000
    ports:
      - "3000:3000"
    depends_on:
      - mongo
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  mongo_data:
```

## Endpoints

The server exposes the Message-box HTTP API:

- `POST /messages/send` — Send a message
- `GET /messages/inbox` — Retrieve messages
- `POST /messages/{id}/read` — Mark as read
- `GET /health` — Health check

For full API details, see [Message-box HTTP Spec](/docs/specs/message-box-http/).

## Monitoring

Health endpoint returns service status:

```bash
curl http://localhost:3000/health
{
  "status": "healthy",
  "uptime": 3600,
  "connections": 5,
  "messages_stored": 1250
}
```

## Performance Tuning

- **Connection pooling** — Increase MongoDB pool size for high message volume
- **Caching** — Enable Redis caching for frequently accessed messages
- **Sharding** — Shard by recipientId for very large deployments
- **Archival** — Move old messages to archive collection after TTL

## Security Considerations

- **HTTPS required** in production
- **Private key rotation** — Regularly rotate server private key
- **Database access** — Restrict MongoDB to internal network only
- **Rate limiting** — Configure per-client send limits
- **Message encryption** — Ensure TLS for message content

## Upgrading

Backup your MongoDB before upgrading:

```bash
mongodump --uri $MONGODB_URI --out ./backup_$(date +%s)
```

Then pull the new image and restart:

```bash
docker pull bsv/messagebox-server:1.1.5
docker compose up -d messagebox
```

## Troubleshooting

**Messages not delivered**: Check MongoDB connectivity and recipient availability in overlay.

**High CPU usage**: Enable query optimization in MongoDB, check for slow queries.

**Memory leaks**: Restart service weekly, check Node.js heap usage.

## References

- [Message-box Client Package](/docs/packages/message-box-client/)
- [Message-box HTTP Spec](/docs/specs/message-box-http/)
- [BRC-31 Authentication](/docs/specs/brc-31-auth/)
