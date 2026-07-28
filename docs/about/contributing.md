---
id: about-contributing
title: 'Contributing'
kind: meta
version: '1.0.0'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
status: stable
tags: [about, contributing, development, community]
---

# Contributing to ts-stack

We welcome contributions from the community! This guide explains how to contribute.

## Ways to Contribute

- **Report bugs** — Open an issue with a minimal reproduction
- **Suggest features** — Discuss before starting major work
- **Submit PRs** — Fork, branch, commit, push, create PR
- **Improve docs** — Help clarify or expand documentation
- **Add conformance vectors** — Test cases for protocols
- **Fix failing tests** — Contribute bug fix vectors

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/bsv-blockchain/ts-stack
cd ts-stack
```

### 2. Install Dependencies

```bash
pnpm install
```

The project uses **pnpm workspaces** for multi-package management.

### 3. Explore the Structure

```
ts-stack/
  packages/          # 30 public npm packages plus private workspaces
  conformance/       # Test vectors and runners
  docs/              # Documentation source (Markdown)
  docs-site/         # Vite+React+MDX docs site
  .github/workflows/ # CI/CD pipelines
```

## Development Workflow

### Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
```

Branch naming conventions:

- `feature/...` — New features
- `fix/...` — Bug fixes
- `docs/...` — Documentation
- `chore/...` — Maintenance
- `test/...` — Test additions

### Make Changes

Follow code style guidelines:

- **TypeScript** with strict mode enabled
- **2 spaces** for indentation
- **Meaningful names** for variables/functions
- **JSDoc comments** for public APIs
- **No console.log** in production code

Example:

```typescript
/**
 * Sign a message using the private key.
 *
 * @param message - The message to sign
 * @returns The signature hex string
 * @throws {Error} If signing fails
 */
export function sign(message: string): string {
  // Implementation
}
```

### Run Tests

```bash
# Build declarations, then run all package tests
pnpm build
pnpm test

# Specific package
pnpm --filter @bsv/sdk test

# Package coverage
pnpm --filter @bsv/sdk test:coverage
```

Required tests must not be empty or anonymously skipped. Manual, live-network,
resource-intensive, and intended conformance gaps follow the
[test-quality governance contract](../reference/test-quality-governance/).
Run `pnpm test:governance` before submitting test-classification changes. New
untrusted parsers, codecs, serializers, signature framing, or network
destination logic should include a registered property suite; use
`pnpm test:property` to run the complete reproducible campaign. Every property
suite also owns a focused mutation target so its assertions are proven capable
of detecting semantic defects:

```bash
# List the governed targets
pnpm test:mutation --list

# Run the target for the boundary being changed
pnpm test:mutation --target p2p-messages
```

When a mutant survives, add the missing observable assertion or correlated
input case when it represents a real behavior gap. Do not add broad mutation
exclusions or weaken the ratchet to make a pull request pass.

### Lint Code

```bash
# Check linting
pnpm lint

# Fix linting issues in a package
pnpm --filter @bsv/sdk exec oxlint --fix src
```

Uses **Oxlint** for fast, consistent TypeScript checks. Errors and warnings fail
CI for every affected package. The root `.oxlintrc.json` is the shared baseline:
it enables the correctness profile, rejects non-`node:` built-in imports, and
defines Node, browser, and test environments for their repository paths.
Package scripts may narrow the files they own, but must not weaken the shared
rules or the zero-warning gate. Legacy ESLint files are not part of the lint
contract.

### Check Formatting

```bash
pnpm format:check
```

The formatting check is read-only. Run the relevant package's Prettier command
with `--write` before submitting when it reports a mismatch.

### Build Packages

```bash
# Build all packages
pnpm build

# Build specific package
pnpm build --filter=@bsv/sdk
```

## Adding Conformance Vectors

Add or update a conformance vector when a change fixes or modifies a portable
protocol behavior. See
[Contributing Vectors](../conformance/contributing-vectors.md) for details.

Example:

```bash
# Create vector file
cat > conformance/vectors/wallet/brc100/createAction-negative-satoshis.json <<EOF
{
  "name": "createAction rejects negative satoshis",
  "domain": "wallet/brc100",
  "inputs": {
    "satoshis": -1000
  },
  "expectedOutput": {
    "error": "ValidationError"
  }
}
EOF

# Run conformance tests
pnpm conformance
```

## Submitting a Pull Request

### 1. Push Your Branch

```bash
git push origin feature/your-feature-name
```

### 2. Create PR on GitHub

Include:

- **Title** — Clear, descriptive (e.g., "fix: validate BRC-100 output satoshis")
- **Description** — What changed and why
- **Tests** — Link to related tests
- **Vectors** — If fixing a bug, include conformance vector
- **Documentation** — If API changed, update docs

Template:

```markdown
## Description

Briefly describe the change.

## Related Issue

Fixes #123

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing

- [ ] Added unit tests
- [ ] Added conformance vectors
- [ ] All tests pass locally
- [ ] Ran linter

## Documentation

- [ ] Updated relevant doc pages
- [ ] Updated CHANGELOG
```

### 3. Respond to Review

Review feedback is normal. We aim to be constructive and helpful.

## Code Style

### Imports

```typescript
// Good — import specific exports from the top-level or subpath
import { PrivateKey, Hash } from '@bsv/sdk'
import { Transaction } from '@bsv/sdk/transaction'

// Bad — avoid wildcard imports
import * as sdk from '@bsv/sdk'
```

### Naming

```typescript
// Good
interface WalletConfig {
  publicKey: string
  maxTransactionSize: number
}

// Bad
interface WalletConfigObj {
  pubkey: string
  maxTxSize: number
}
```

### Error Handling

```typescript
// Good
if (!isValid(input)) {
  throw new Error('Invalid input: expected hex string')
}

// Bad
if (!isValid(input)) {
  console.error('Invalid input')
  return null
}
```

## Testing Requirements

Pull requests must include the evidence appropriate to their change:

- **Unit tests** for changed behavior
- **Integration tests** for cross-component behavior
- **Conformance vectors** for portable protocol behavior
- **Consumer or browser/mobile checks** for package-boundary changes
- **Migration and rollback notes** for breaking or deployed behavior

Run before submitting:

```bash
pnpm test
pnpm test:property
pnpm conformance
pnpm lint
pnpm format:check
pnpm health:check
pnpm typecheck
```

Run the affected mutation target while iterating. Root toolchain, SDK,
governance, and CI changes require the complete `pnpm test:mutation --all`
campaign; CI selects this automatically.

## Reporting Issues

When reporting a bug, include:

- **Node.js version** — `node --version`
- **Package versions** — `pnpm list @bsv/...`
- **Reproduction** — Minimal code to reproduce
- **Expected vs actual** — What should happen vs what did
- **Environment** — OS, TypeScript version, etc.

Template:

````markdown
## Bug Report

### Environment

- Node: v24.18.0
- @bsv/sdk: <installed version>
- OS: macOS 15.6

### Reproduction

```typescript
// Minimal code to reproduce
```

### Expected

[Expected behavior]

### Actual

[Actual behavior]
````

## Documentation

Help improve docs:

1. Find unclear sections in `docs/`
2. Edit the relevant `.md` file
3. Preview locally: `pnpm docs:dev` → `http://localhost:5173`
4. Run `pnpm docs:facts:check` when package, runtime, release, README, or
   conformance facts changed.
5. Submit a PR — the docs site build (`pnpm docs:build`) validates frontmatter
   and links (run `pnpm --filter docs-site validate` locally first).

**Do not delete the `gh-pages` branch** — it hosts the TypeDoc `/api/` tree that
the deploy workflow merges into the artifact before publishing.

See [Versioning Policy](./versioning.md) for documentation maintenance.

## Commit Message Format

Use conventional commits:

```
type(scope): subject

body
footer
```

Types:

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation
- `style:` — Code style (no behavior change)
- `refactor:` — Code refactoring
- `perf:` — Performance improvements
- `test:` — Test additions/changes
- `chore:` — Build, CI, dependencies

Examples:

```
feat(brc100): add getBalance method
fix: prevent double-spend in UTXO selection
docs: clarify BRC-31 authentication flow
test: add vectors for negative satoshis
```

## Continuous Integration

All PRs run through GitHub Actions:

1. **Unit tests** — Must pass
2. **Linting** — Must pass
3. **Type checking** — Must pass
4. **Conformance** — structural and TypeScript behavior runners must pass
5. **Build** — All packages must build

If any check fails, fix the issue and push again.

## Licensing

By contributing, you agree that your contributions are licensed under the
[Open BSV License Version 6](https://github.com/bsv-blockchain/ts-stack/blob/main/LICENSE.txt),
the same license used uniformly throughout ts-stack. See the
[licensing policy](../reference/licensing.md) for the package and release
controls that keep every first-party project on the current canonical text.

## Code of Conduct

Be respectful and constructive. We're here to help each other build better software.

## Questions?

- Open an issue with your question
- Join our community chat
- Reach out to maintainers

## Next Steps

- [Conformance Contributing Guide](../conformance/contributing-vectors.md)
- [Versioning Policy](./versioning.md)
- [Doc Agent Guide](./doc-agent.md)
