# @bsv/ump-services

Thin re-export wrapper for BSV UMP overlay services.

This package re-exports `UMPTopicManager` and `createUMPLookupService` from [`@bsv/overlay-topics`](../topics/), which is the canonical implementation.

## Usage

```typescript
import { UMPTopicManager, createUMPLookupService } from '@bsv/ump-services'
```

## Canonical implementation

All implementation lives in `packages/overlays/topics/src/ump/`.

## License

[Open BSV License](./LICENSE.txt)
