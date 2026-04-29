---
id: about-contributing
title: "Contributing"
kind: meta
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 90
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
  packages/          # 27 npm packages
  conformance/       # Test vectors and runners
  docs/              # MkDocs documentation
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
# Unit tests
pnpm test

# Specific package
pnpm test --filter=@bsv/sdk

# Watch mode
pnpm test --watch

# Coverage
pnpm test --coverage
```

### Lint Code

```bash
# Check linting
pnpm lint

# Fix linting issues
pnpm lint --fix
```

Uses **ts-standard** for consistent code style.

### Build Packages

```bash
# Build all packages
pnpm build

# Build specific package
pnpm build --filter=@bsv/sdk
```

## Adding Conformance Vectors

Required for all bug fixes. See [Contributing Vectors](../conformance/contributing-vectors/) for details.

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
import { PrivateKey, Hash } from '@bsv/sdk';
import { Transaction } from '@bsv/sdk/transaction';

// Bad — avoid wildcard imports
import * as sdk from '@bsv/sdk';
```

### Naming

```typescript
// Good
interface WalletConfig {
  publicKey: string;
  maxTransactionSize: number;
}

// Bad
interface WalletConfigObj {
  pubkey: string;
  maxTxSize: number;
}
```

### Error Handling

```typescript
// Good
if (!isValid(input)) {
  throw new Error('Invalid input: expected hex string');
}

// Bad
if (!isValid(input)) {
  console.error('Invalid input');
  return null;
}
```

## Testing Requirements

All pull requests must include:

- **Unit tests** — Test the change in isolation
- **Integration tests** — Test interaction with other parts
- **Conformance vectors** — For protocol compliance

Run before submitting:

```bash
pnpm test
pnpm conformance
pnpm lint
```

## Reporting Issues

When reporting a bug, include:

- **Node.js version** — `node --version`
- **Package versions** — `pnpm list @bsv/...`
- **Reproduction** — Minimal code to reproduce
- **Expected vs actual** — What should happen vs what did
- **Environment** — OS, TypeScript version, etc.

Template:

```markdown
## Bug Report

### Environment
- Node: v18.0.0
- @bsv/sdk: 1.2.3
- OS: macOS 13.0

### Reproduction
```typescript
// Minimal code to reproduce
```

### Expected
[Expected behavior]

### Actual
[Actual behavior]
```

## Documentation

Help improve docs:

1. Find unclear sections in `/docs`
2. Make the content clearer
3. Test code examples
4. Submit a PR to `docs/` directory

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
4. **Conformance** — TS and Go must pass
5. **Build** — All packages must build

If any check fails, fix the issue and push again.

## Licensing

By contributing, you agree that your contributions are licensed under the same license as ts-stack (typically MIT or BSL-1.1).

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
