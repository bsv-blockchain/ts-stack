---
id: pkg-verifast
title: '@bsv/verifast'
kind: package
domain: sdk
version: '0.3.3'
last_updated: '2026-07-29'
last_verified: '2026-07-29'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/verifast'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/verifast'
status: beta
tags: [sdk, verification, wasm, browser, worker]
---

# @bsv/verifast

`@bsv/verifast` is the optional BSV BDK WebAssembly verification backend for
`@bsv/sdk`. It supports Node ESM and CommonJS, browser and worker ESM, and a
classic-script/UMD integration.

## Install

```bash
npm install @bsv/verifast @bsv/sdk
```

The validated WASM assets ship inside the package. Consumers do not run a
native compiler or post-install build.

## Use

```ts
import { Transaction } from '@bsv/sdk'
import { BdkVerifier } from '@bsv/verifast'

const verifier = new BdkVerifier()
await verifier.preload()

const transaction = Transaction.fromEF(extendedFormatBytes)
const valid = await transaction.verify('scripts only', undefined, undefined, verifier)
```

The default adaptive mode uses the SDK interpreter while a cold WASM module
warms and routes eligible verification work to WASM afterward. Use explicit
consensus or policy context when establishing transaction validity. Batch and
worker APIs are bounded and can be preloaded for latency-sensitive workloads.

Build and package checks install exact tarballs and exercise real WASM
verification in Node, browser bundlers, workers, CommonJS, strict-CSP browser
pages, streaming fallback, and the classic browser payload. Raw, gzip, and
Brotli budgets guard both browser bundles and the complete UMD loaders-plus-WASM
composition. See the
[package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/verifast#readme)
for routing, network, batch, resource, and UMD details.

## License

Open BSV License Version 6. See the
[package license](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/verifast/LICENSE.txt).
