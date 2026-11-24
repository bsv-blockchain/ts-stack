---
release:
  "@bsv/sdk": minor
---
StorageDownloader.download now throws StorageDownloadError, which keeps the existing messages and adds attempts: each advertised host tried, with a reason (http with its status, timeout, size, integrity, empty or network); an empty list means no host advertises the file. Adds the opt-in DownloaderConfig.timeoutMs per-host deadline (1 to 2147483647) covering the request and the body; a host that misses it has its request aborted and its body read cancelled, and the next host is tried. There is still no deadline by default. StorageDownloader reads a response with no WHATWG body stream (such as React Native fetch) through arrayBuffer() when the host declares a Content-Length within maxDownloadBytes, with the same size and hash checks; without one the host is recorded as a size failure and the next host is tried. StorageUploader reads such provider replies through arrayBuffer() too. Native fetch responses keep the streamed path. Additive only.

## Migration

No consumer migration is required.
