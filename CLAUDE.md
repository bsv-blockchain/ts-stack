# ts-stack — repo guidance

## Releasing infra images (general + Marketplace)

Infra components under `infra/*` publish **two independent channels** when you push an
`infra/v*` tag (or run the workflows manually). Marketplace does **not** replace the general
image path.

### 1. General OCI image → GHCR (primary for self-hosters)

- Workflow: `.github/workflows/infra-release.yaml`
- For every `infra/<name>` with a Dockerfile + `package.json` version not yet in GHCR, builds and
  pushes `ghcr.io/<owner>/<name>:v<version>` (e.g. `ghcr.io/bsv-blockchain/wab:v1.4.7`).
- Version source of truth: each component’s `package.json` `version`. The git tag is only the
  trigger (date-based); it is never parsed for a version.
- Use this image in your own Kubernetes, Compose, or other systems.

### 2. AWS Marketplace listing → Marketplace ECR + Catalog (WAB only)

- Workflow: `.github/workflows/wab-marketplace-release.yml` (must be at repo root — GitHub does
  not run workflows under `infra/wab/.github/workflows/`).
- Same trigger and same `infra/wab/package.json` version source of truth as GHCR.
- Marketplace version titles are `v`-prefixed (`v1.4.7`) to match the existing listing; the
  Marketplace ECR image tag is bare (`wab:1.4.7`).
- Product ID: `prod-67ziqtkrihz34` (ContainerProduct@1.0).
- Image for the listing goes to Marketplace ECR
  `709825985650.dkr.ecr.us-east-1.amazonaws.com/bsv-blockchain/wab:<version>` **in addition to**
  GHCR — not instead of it. Docker Hub (`bsvb/wab`) is legacy and no longer published.
- Publishing = push image to Marketplace ECR **then** register via Catalog API
  `StartChangeSet` / `AddDeliveryOptions`. Pushing the image alone does nothing buyers can see.
- Version names on the listing are immutable and must be unique; never reuse one.
- New versions are scanned (minutes–hours) before going live.
- Required repo variable: `WAB_MP_ROLE_ARN` (OIDC role in the seller account with Marketplace ECR
  push + Catalog permissions). See workflow header comments for details.

### How to release

1. Bump `infra/<component>/package.json` `version` as needed.
2. Push an `infra/v*` tag (or `workflow_dispatch` the relevant workflow(s)).
3. Confirm GHCR tags on GitHub Packages; for WAB Marketplace, confirm the listing version after
   the change set reaches `SUCCEEDED`.
