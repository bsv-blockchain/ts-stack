# `@bsv/chirp`

Reference implementation of BRC-167, the Chunked, Hashed, Interleaved
Resolution Protocol. CHIRP is an additive Merkle-object layer over UHRP: roots
are discovered with the existing `ls_uhrp` service and complete hosts advertise
the canonical root as an ordinary BRC-26 object.

The package supports browsers and Node.js and includes:

- canonical v1 root and branch codecs;
- deterministic profile 1 construction (4 MiB blobs, fanout 256);
- `Uint8Array`, browser `Blob`, `ReadableStream<Uint8Array>`, and Node
  `AsyncIterable<Uint8Array>` sources;
- progressive multi-host publication with resumable upload sessions;
- lazy, bounded, range-aware, interleaved download and per-object retry;
- verified-object caching and full closure validation; and
- the `chirp` publication, retrieval, and verification CLI.

## Install

```sh
npm install @bsv/chirp @bsv/sdk
```

## Build a canonical root

```ts
import { CHIRPBuilder } from '@bsv/chirp'

const result = await new CHIRPBuilder().build(new Blob([largeFile]), {
  mediaType: 'application/octet-stream',
  sink: {
    async putObject(identifier, bytes, kind) {
      // Persist or upload each verified object. Blobs arrive before EOF.
    }
  }
})

console.log(result.chirpURL)
```

## Publish to complete hosts

`CHIRPUploader` uses the same BRC-103/104 `WalletInterface` and `AuthFetch`
boundary as `StorageUploader`. Existing UHRP upload APIs are unchanged.

```ts
import { CHIRPUploader } from '@bsv/chirp'

const result = await new CHIRPUploader({
  wallet,
  storageURLs: ['https://storage-a.example', 'https://storage-b.example'],
  resilienceLevel: 2
}).publish({
  source: file.stream(),
  logicalLength: file.size,
  retentionSeconds: 2_592_000,
  mediaType: file.type || undefined
})
```

## Retrieve or stream

```ts
import { CHIRPDownloader } from '@bsv/chirp'

const downloader = new CHIRPDownloader({ concurrency: 4 })
for await (const chunk of downloader.stream(chirpURL, {
  range: { start: 8_388_608n, endExclusive: 12_582_912n }
})) {
  consume(chunk.data)
}
```

Each complete blob is hash-verified before release. A complete stream also
checks root `logicalLength` and `contentHash` at termination. Use `download()`
for an atomic bounded `Uint8Array` result.

## CLI

```sh
chirp --help
chirp publish ./large.bin \
  --host https://storage.example \
  --wallet-module ./wallet.mjs \
  --retention-seconds 2592000 \
  --resume-file .chirp-upload.json
chirp retrieve chirp://... --output ./large.bin --range 0:4194304
chirp verify chirp://...
```

The wallet module exports a default `WalletInterface` or async
`createWallet()`. Resume files contain opaque host session capabilities and
should be protected like other authenticated client state.
Storage hosts must use HTTPS unless `allowInsecureHTTP` (or the CLI's
`--allow-insecure-http`) is selected explicitly for local development.

## Compatibility and limits

- `uhrp:` and existing `StorageUploader`, `StorageDownloader`, `/upload`,
  `/put`, `/find`, `/list`, `/renew`, and `/cdn` contracts are unchanged.
- CHIRP never introduces `tm_chirp` or `ls_chirp`; root discovery remains
  `tm_uhrp` / `ls_uhrp`.
- Default atomic downloads are limited to 512 MiB. Streaming, object count,
  concurrency, retry, depth, response size, and cache sizes are bounded and
  configurable.
- Object requests and UHRP resolution have bounded timeouts. Browser clients
  inherit the browser network boundary; server-side consumers can provide a
  `urlPolicy`, and the CLI rejects DNS results outside public address space by
  default. `--allow-private-hosts` is an explicit local-development override.
- Resolution of a future chunking profile remains hash-, length-, and
  `contentHash`-verified, while `profileCanonical` reports `false` until the
  profile-specific construction is understood.
- `mediaType` is untrusted advisory metadata. CHIRP integrity is not author
  authenticity or permission to execute content.

The BRC-167 serialization is authoritative if package behavior and the
standard ever disagree.

## License

Open BSV License v6. See [LICENSE.txt](./LICENSE.txt).
