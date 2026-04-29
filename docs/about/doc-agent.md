---
id: about-doc-agent
title: "Documentation Maintenance"
kind: meta
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [about, documentation, maintenance, automation]
---

# Documentation Maintenance

This documentation site is maintained with automated tools to keep docs synchronized with the codebase.

## Frontmatter Schema

Every doc page must have frontmatter following this schema:

```yaml
---
id: unique-slug
title: "Page Title"
kind: spec|infra|conformance|guide|reference|meta
version: "1.2.3"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [tag1, tag2]
---
```

### Required Fields

| Field | Type | Example | Purpose |
|-------|------|---------|---------|
| `id` | string | `spec-brc-100` | Unique slug for page |
| `title` | string | `"BRC-100 Wallet"` | Page title |
| `kind` | enum | `spec` | Page category |
| `version` | string | `"1.2.3"` | Latest tested version |
| `last_updated` | date | `2026-04-28` | When content was written |
| `last_verified` | date | `2026-04-28` | When last tested |
| `review_cadence_days` | number | `30` | Days until next review |
| `status` | enum | `stable` | Stability status |
| `tags` | array | `[wallet, brc-100]` | Keywords |

### Kind Values

- **spec** — Protocol specification
- **infra** — Infrastructure service
- **conformance** — Test vectors/runners
- **guide** — How-to guide
- **reference** — API reference
- **meta** — About, versioning, etc.

### Status Values

- **stable** — Production ready
- **beta** — Feature complete, testing
- **deprecated** — Marked for removal
- **experimental** — Unstable, may change

## Version Management

The `version` field tracks the latest tested version of what the page documents:

```yaml
# For package docs
version: "1.2.3"  # Latest tested npm version

# For spec docs
version: "2.0"    # Spec version

# For meta pages
version: "1.0.0"  # Documentation version
```

### Version Checking

Automated tools check if docs match the current npm version:

```bash
# Check all doc versions
pnpm docs:check-versions

# Update version in all docs
pnpm docs:update-version @bsv/sdk 1.2.3

# Compare doc version vs npm
pnpm docs:version-diff @bsv/sdk
```

## Review Cadence

The `review_cadence_days` field indicates how often a page should be reviewed:

```yaml
review_cadence_days: 30  # Review monthly
```

Suggested cadences:

- **7 days** — Actively maintained features, new packages
- **14 days** — Frequently changed APIs
- **30 days** — Stable packages, specs
- **90 days** — Rarely changed (versioning, about pages)

### Staleness Calculation

A page becomes stale after:

```
stale_date = last_verified + review_cadence_days
```

Example:
```
last_verified: "2026-04-28"
review_cadence_days: 30
stale_date: "2026-05-28"
```

Automated agents flag stale pages and create issues/PRs to update them.

## Maintenance Tasks

### Update Package Version

When a package releases a new version:

```bash
pnpm docs:update-version @bsv/sdk 2.0.0
```

This updates all doc pages that reference this package.

### Verify Documentation

Check that examples work and links are correct:

```bash
pnpm docs:verify

# Specific page
pnpm docs:verify docs/specs/brc-100-wallet.md
```

Checks:
- All links are valid (HTTP 200)
- Code examples syntactically correct
- Version matches npm
- Required frontmatter present

### Extract API Docs

For package documentation, extract TypeDoc:

```bash
pnpm docs:extract-api @bsv/sdk

# Updates docs/packages/sdk.md with latest API
```

## Automated Maintenance

### Scheduled Review

Automated agents check stale docs daily:

1. Find pages where `last_verified + review_cadence_days < today`
2. Create issue requesting verification
3. If version mismatch found, create PR with updates
4. Update `last_verified` date after verification

### GitHub Actions

Workflow: `.github/workflows/docs-check.yml`

```yaml
- name: Check doc staleness
  run: pnpm docs:check-staleness

- name: Verify links
  run: pnpm docs:verify-links

- name: Check versions
  run: pnpm docs:check-versions
```

## Contributing Documentation

### Edit a Doc Page

1. Find the file in `/docs`
2. Edit the content (below frontmatter)
3. Update `last_updated` to today
4. If you verified the content, update `last_verified`
5. Commit and create PR

Example:

```markdown
---
id: spec-brc-100
title: "BRC-100 Wallet Interface"
kind: spec
version: "1.0"
last_updated: "2026-04-28"  # ← Update to today
last_verified: "2026-04-28" # ← Update if you tested
review_cadence_days: 30
status: stable
tags: [wallet, brc-100]
---

# BRC-100 Wallet Interface

[Your content here]
```

### Create a New Page

1. Create file in appropriate directory (`docs/specs/`, `docs/guides/`, etc.)
2. Add required frontmatter
3. Write content
4. Run `pnpm docs:verify` to validate
5. Commit and create PR

Template:

```markdown
---
id: unique-identifier
title: "Page Title"
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [tag1, tag2]
---

# Page Title

[Content]
```

## Frontmatter Validation

All pages are validated on commit:

```bash
# Validate specific file
pnpm docs:validate docs/specs/brc-100-wallet.md

# Validate all docs
pnpm docs:validate
```

Checks:
- Required fields present
- Valid enum values (kind, status)
- Date format (ISO 8601)
- ID is unique
- Version format is valid

## Examples

### Spec Page

```yaml
---
id: spec-brc-100
title: "BRC-100 Wallet Interface"
kind: spec
version: "1.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [wallet, brc-100, rpc]
---
```

### Package Page

```yaml
---
id: pkg-sdk
title: "@bsv/sdk"
kind: reference
version: "1.2.3"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 14
status: stable
tags: [sdk, bitcoin, crypto]
---
```

### Guide Page

```yaml
---
id: guide-wallet-aware
title: "Build a Wallet-Aware App"
kind: guide
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [guide, wallet, tutorial]
---
```

## Next Steps

- [Contributing Guide](./contributing.md) — Source code contributions
- [Versioning Policy](./versioning.md) — Version management
- [GitHub Releases](https://github.com/bsv-blockchain/ts-stack/releases) — See all updates
