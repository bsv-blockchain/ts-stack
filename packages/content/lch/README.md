# @bsv/lch

Reference implementation of the draft BRC-170 Licensed Content Header protocol. It provides deterministic CBOR and object identifiers, `.lch` framing, segmented AES-256-GCM, BRC-77 signatures, BRC-78 key delivery, UHRP/CHIRP-aware content adapters, policy/profile checks, multilateral output matching, authority revocation validation, license storage, and whole-placement composition.

The package keeps acquisition explicit. Inspecting or opening a header never spends money. Applications call preflight, quote, wallet payment, delivery, and recovery as separate steps.

## Install

```bash
npm install @bsv/lch @bsv/sdk
# Optional for chirp: ciphertext locators:
npm install @bsv/chirp
```

## Getting started

```ts
import { LCHPublisher, LCHReader, MemoryContentSink, WalletBRC77Signer } from '@bsv/lch'

const signer = await WalletBRC77Signer.create({ wallet })
const storage = new MemoryContentSink()
const publisher = new LCHPublisher(signer)
const protectedAsset = await publisher.protect(bytes, {
  mediaType: 'audio/wav',
  name: 'loop.wav',
  rights: [
    { interest: 'sound-recording', holder: { name: 'Creator' }, controller: signer.identityKey }
  ],
  sink: storage
})

// An Offer is created after the Asset ID is known, then included in acquisition.
const published = await publisher.publish(protectedAsset, [{ mode: 'inline', offer }], false)
const reader = new LCHReader(storage)
const inspected = await reader.inspect(published.bytes)
const plaintext = await reader.decrypt(inspected, protectedAsset.keys)
```

Application-specific catalogue, streaming index, royalty weighting, waveform, timeline, and social metadata belong in non-critical application data or separately registered profiles. The v1 composition resolver intentionally standardizes only whole placement; an unknown edit mapping fails closed.

Server-side HTTPS resolution must provide an endpoint policy with a
public-address DNS resolver and an address-pinning connector. Browser
applications should use an equivalently constrained authenticated gateway
rather than treating a preflight DNS lookup as protection against rebinding.

See BRC-170 for the normative protocol. If this implementation and the BRC differ, the BRC is authoritative.

## License

This package is licensed under the [Open BSV License Version 6](./LICENSE.txt).
