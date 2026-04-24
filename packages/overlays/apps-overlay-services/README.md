# @bsv/apps-overlay-services

Thin re-export wrapper for BSV apps overlay services (Metanet App Catalog).

This package re-exports `AppsTopicManager` and `createAppsLookupService` from [`@bsv/overlay-topics`](../topics/), which is the canonical implementation.

## Usage

```typescript
import { AppsTopicManager, createAppsLookupService } from '@bsv/apps-overlay-services'
```

## Canonical implementation

All implementation lives in `packages/overlays/topics/src/apps/`.
