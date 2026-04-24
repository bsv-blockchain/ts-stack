# @bsv/identity-services

Thin re-export wrapper for BSV identity overlay services.

This package re-exports `IdentityTopicManager` and `createIdentityLookupService` from [`@bsv/overlay-topics`](../topics/), which is the canonical implementation.

## Usage

```typescript
import { IdentityTopicManager, createIdentityLookupService } from '@bsv/identity-services'
```

## Canonical implementation

All implementation lives in `packages/overlays/topics/src/identity/`.

## License

[Open BSV License](./LICENSE.txt)
