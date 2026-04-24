# @bsv/registry-services

Thin re-export wrapper for BSV registry overlay services (BasketMap, CertMap, ProtoMap).

This package re-exports topic managers and lookup service factories from [`@bsv/overlay-topics`](../topics/), which is the canonical implementation.

## Usage

```typescript
import {
  BasketMapTopicManager, createBasketMapLookupService,
  CertMapTopicManager, createCertMapLookupService,
  ProtoMapTopicManager, createProtoMapLookupService
} from '@bsv/registry-services'
```

## Canonical implementation

All implementation lives in `packages/overlays/topics/src/` (basketmap/, certmap/, protomap/).

## License

[Open BSV License](./LICENSE.txt)
