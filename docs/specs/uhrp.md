---
id: spec-uhrp
title: "UHRP (Universal Hash Resolution Protocol)"
kind: spec
version: "1.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [uhrp, storage, content-addressed, protocol]
---

# UHRP (Universal Hash Resolution Protocol)

## Overview

UHRP enables content-addressed file storage and retrieval on BSV. Files are identified by their cryptographic hash, allowing any client to verify integrity and find the file across a distributed network of UHRP servers.

## Key Concepts

### Content Addressing

Files are referenced by their hash rather than by path or URL:

```
uhrp://sha256(file_contents)
```

The hash serves as:
- **Identity** — The file's permanent identifier
- **Verification** — Proof the retrieved file is correct
- **Deduplication** — Identical files share one hash

### Storage Network

Multiple UHRP servers store files and respond to retrieval requests. A file stored on any server is discoverable by any client querying the network.

### Overlay Indexing

UHRP servers publish availability information to overlay topics, enabling discovery:

```
topic: uhrp.hashes
event: {
  "hash": "<sha256>",
  "size": 1024,
  "servers": ["https://server1.com", "https://server2.com"]
}
```

## Key Endpoints

### Store File

**`POST /store`**

Upload a file to the UHRP server.

```
Request:
Content-Type: application/octet-stream
<binary file data>

Response:
{
  "hash": "<sha256>",
  "size": 1024,
  "timestamp": 1234567890
}
```

### Retrieve File

**`GET /{hash}`**

Download a file by its hash.

```
Response:
Content-Type: application/octet-stream
Content-Hash: <sha256>
<binary file data>
```

### Check Availability

**`HEAD /{hash}`**

Check if a file is available on this server.

```
Response:
HTTP/1.1 200 OK
Content-Length: 1024
Content-Hash: <sha256>
```

## Verification

Clients verify retrieved files by:
1. Computing the SHA256 hash of received data
2. Comparing to the requested hash
3. Rejecting the file if hashes don't match

## Use Cases

- Wallet backups — Store encrypted backup files
- Transaction data — Archive transaction details
- Contract metadata — Store smart contract artifacts
- Media — Host images, documents, videos
- Software — Distribute application code and resources

## Specification

The complete UHRP protocol is defined in OpenAPI 3.1:

```
specs/storage/uhrp-http.yaml
```

## References

- [UHRP Lite Server](/docs/infrastructure/uhrp-server-basic/)
- [UHRP Cloud Server](/docs/infrastructure/uhrp-server-cloud-bucket/)
- [Overlay Topics](/docs/packages/overlay-topics/)
