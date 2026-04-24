# @bsv/uhrp-services

Thin re-export wrapper for BSV UHRP (Universal Hash Resolution Protocol) overlay services.

This package re-exports `UHRPTopicManager` and `createUHRPLookupService` from [`@bsv/overlay-topics`](../topics/), which is the canonical implementation.

## Usage

```typescript
import { UHRPTopicManager, createUHRPLookupService } from '@bsv/uhrp-services'
```

## Canonical implementation

All implementation lives in `packages/overlays/topics/src/uhrp/`.

## Further Reading

- [BRC-26 — Universal Hash Resolution Protocol](https://github.com/bitcoin-sv/BRCs/blob/master/overlays/0026.md)

## License

[Open BSV License](./LICENSE.txt)
