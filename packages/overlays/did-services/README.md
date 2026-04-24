# @bsv/did-services

Thin re-export wrapper for BSV DID overlay services.

This package re-exports `DIDTopicManager` and `createDIDLookupService` from [`@bsv/overlay-topics`](../topics/), which is the canonical implementation.

## Usage

```typescript
import { DIDTopicManager, createDIDLookupService } from '@bsv/did-services'
```

## Canonical implementation

All implementation lives in `packages/overlays/topics/src/did/`.

## License

Open BSV License
