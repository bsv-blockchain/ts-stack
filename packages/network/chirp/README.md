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

Direct byte arrays and build options are snapshotted before asynchronous work.
Every object passed to a sink is an owned copy, so a sink cannot mutate the
verified result. Pass an `AbortSignal` as `signal` when a stream or asynchronous
iterator must remain cancellable. A custom sink is still a local authority: it
decides where verified bytes are persisted and must provide its own durability
and access-control policy.

## Publish to complete hosts

`CHIRPUploader` uses the same BRC-103/104 `WalletInterface` and `AuthFetch`
boundary as `StorageUploader`. Existing UHRP upload APIs are unchanged.

Object uploads sign their `Content-Type` and send the verified bytes unchanged.
The HTTP transport supplies `Content-Length` from the byte body; omitting
`Content-Encoding` means identity encoding. These transport headers are not
passed through `AuthFetch` as signed application headers. Custom authenticated
transports must retain the exact bytes and ordinary HTTP framing.

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

To customize DNS pinning or HTTP transport while retaining `AuthFetch`, provide
`fetchClient`. The legacy `fetch` option replaces the complete request path,
including `AuthFetch`, and is appropriate only for tests or a caller-supplied
authenticated client. Both callbacks are local trust boundaries; CHIRP cannot
make an unrestricted custom transport safe.

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
for an atomic bounded `Uint8Array` result. Object responses may stream without
`Content-Length`; when the header is present it must match the verified
reference. Readers always enforce the referenced blob length and a finite node
or future-profile object bound.

Custom cache entries are never trusted for integrity: reads are copied and
hash-verified before use, writes receive owned copies, and `MemoryCHIRPCache`
verifies the identifier before insertion. Configuration, per-call ranges, and
callbacks are captured before network awaits so later caller mutation cannot
change an in-flight operation.

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
should be protected like other authenticated client state. The built-in CLI
reads at most 1 MiB from a regular non-symlink checkpoint and replaces
checkpoints atomically with mode `0600`. Retrieved output is first written to a
private same-directory temporary and linked into its final name without
following or overwriting an existing path.
Storage hosts must use HTTPS unless `allowInsecureHTTP` (or the CLI's
`--allow-insecure-http`) is selected explicitly for local development. Private
hosts additionally require `allowPrivateHosts` or `--allow-private-hosts`.

## Compatibility and limits

- `uhrp:` and existing `StorageUploader`, `StorageDownloader`, `/upload`,
  `/put`, `/find`, `/list`, `/renew`, and `/cdn` contracts are unchanged.
- CHIRP never introduces `tm_chirp` or `ls_chirp`; root discovery remains
  `tm_uhrp` / `ls_uhrp`.
- Default atomic downloads are limited to 512 MiB. Streaming, object count,
  concurrency, retry, depth, response size, and cache sizes are bounded and
  configurable; object/reference traversal defaults to 100,000 and depth
  cannot exceed the v1 limit of 16. Profile 1 blobs are always capped at 4 MiB;
  `maxObjectBytes` sets the absolute local ceiling for blobs from unknown future
  profiles.
- Object requests and UHRP resolution have bounded timeouts. Browser clients
  inherit the browser network boundary; server-side consumers can provide a
  `urlPolicy`, and the CLI rejects DNS results outside public address space by
  default. Timeout races also bound custom asynchronous adapters that ignore an
  abort signal, although their own abandoned work remains their responsibility.
  `--allow-private-hosts` is an explicit local-development override.
- Resolution of a future chunking profile remains hash-, length-, and
  `contentHash`-verified, while `profileCanonical` reports `false` until the
  profile-specific construction is understood. Profile 1 reports canonical
  only after a complete traversal validates its chunk boundaries and tree
  shape; partial-range downloads conservatively report `false`.
- `mediaType` is untrusted advisory metadata. CHIRP integrity is not author
  authenticity or permission to execute content.

## Production integration

Set `resilienceLevel` to the number of complete hosts required for a successful
publication, retain resumable checkpoints until every intended host commits,
and monitor root retention and renewal. A root advertisement means the host
validated and retains the complete transitive closure; do not describe a
partial cache as a complete host. Readers should bound logical bytes, object
bytes and count, depth, retries, concurrency, redirects, and cache use, and
server-side readers should enforce a connection-pinned public-address policy.

For licensed media, publish LCH ciphertext through `CHIRPContentSink` and put
the returned `chirp:` locator in the LCH Asset representation. CHIRP then owns
verified availability while LCH independently owns encryption, rights,
payment, keys, and composition. See the
[production CHIRP and LCH guide](https://github.com/bsv-blockchain/ts-stack/blob/main/docs/guides/chirp-lch-production.md)
for the complete topology, persistence model, failure matrix, deployment gate,
and agent implementation contract.

See [BRC-167](https://bsv.brc.dev/overlays/0167) for the normative protocol. If
package behavior and the standard differ, the standard is authoritative.

## License

Open BSV License v6. See [LICENSE.txt](./LICENSE.txt).
