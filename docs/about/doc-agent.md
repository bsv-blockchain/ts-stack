---
id: doc-agent
title: Documentation Agent
kind: meta
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["about", "meta"]
---

# Documentation Agent

This documentation site is maintained with the help of an automated documentation agent.

## How It Works

The doc agent:

- Monitors source code in the monorepo
- Extracts API information from TypeScript definitions
- Syncs package metadata (version, npm, stability)
- Validates spec conformance
- Ensures docs stay synchronized with code

## Contributing Docs

- Edit markdown files in `/docs`
- Use frontmatter schema defined in `docs/_schemas/page.schema.json`
- Include `last_verified` date when reviewing existing docs
- Set `review_cadence_days` for review reminders

## Frontmatter Schema

All doc pages require:

```yaml
---
id: unique-slug
title: Page Title
kind: package|infra|spec|guide|conformance|reference|meta
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable|beta|deprecated|experimental
tags: [list, of, tags]
---
```

## Review Cadence

Set `review_cadence_days` to remind maintainers to verify:

- Links still work
- Code examples execute correctly
- Package versions are current
- API changes are reflected

## Next Steps

- See [Contributing](./contributing.md) for source code contribution guidelines
- See [Versioning](./versioning.md) for release information
