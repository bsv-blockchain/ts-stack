# ts-stack — repo guidance

## Releasing infra/wab to AWS Marketplace

The Marketplace version is driven by `infra/wab/package.json` `version` — the same source of
truth `infra-release.yaml` uses for GHCR. To release: bump that version, then push an `infra/v*` tag.

- Workflow: `.github/workflows/wab-marketplace-release.yml` (must be at repo root — GitHub does not
  run workflows under `infra/wab/.github/workflows/`).
- The published version name is **always** derived from `infra/wab/package.json`; the `infra/v*` git
  tag (date-based) is **only the trigger** and is never parsed for a version. Marketplace version
  titles are `v`-prefixed (`v1.4.7`) to match the existing listing; the ECR image tag is bare
  (`wab:1.4.7`).
- Marketplace product ID: `prod-67ziqtkrihz34` (ContainerProduct@1.0).
- Image goes to the Marketplace ECR `709825985650.dkr.ecr.us-east-1.amazonaws.com/bsv-blockchain/wab:<version>`,
  NOT GHCR or Docker Hub.
- Publishing = push image to Marketplace ECR THEN register the version via Catalog API
  `StartChangeSet` / `AddDeliveryOptions`. Pushing the image alone does nothing buyers can see.
- Version names on the listing are immutable and must be unique; never reuse one.
- New versions are scanned (minutes–hours) before going live.
