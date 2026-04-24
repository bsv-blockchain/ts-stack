# @bsv/kvstore-overlay-services

Thin re-export wrapper for BSV KVStore overlay services.

This package re-exports `KVStoreTopicManager` and `createKVStoreLookupService` from [`@bsv/overlay-topics`](../topics/), which is the canonical implementation.

## Usage

```typescript
import { KVStoreTopicManager, createKVStoreLookupService, kvProtocol } from '@bsv/kvstore-overlay-services'
```

## Canonical implementation

All implementation lives in `packages/overlays/topics/src/kvstore/`.

## License

See [LICENSE.txt](LICENSE.txt) for license details.
