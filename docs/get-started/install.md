---
id: install
title: Install
kind: meta
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["installation", "setup"]
---

# Install

## Prerequisites

- **Node.js ≥ 20** — Check with `node --version`
- **npm, yarn, or pnpm** — We recommend pnpm for monorepo projects

Install Node from [nodejs.org](https://nodejs.org).

## Install the SDK

The [SDK](../packages/sdk/index.md) is the starting point for all projects:

```bash
npm install @bsv/sdk
```

Or with pnpm:

```bash
pnpm add @bsv/sdk
```

Or yarn:

```bash
yarn add @bsv/sdk
```

## Verify Installation

Create a file called `test.ts`:

```typescript
import { PrivateKey } from '@bsv/sdk';

const key = PrivateKey.fromRandom();
console.log('Private Key:', key.toString());
console.log('Public Key:', key.publicKey.toString());

const message = 'hello bsv';
const signature = key.sign(message);
console.log('Signature:', signature.toString());

const isValid = key.publicKey.verify(message, signature);
console.log('Signature valid:', isValid);
```

Run it with:

```bash
npx ts-node test.ts
```

You should see your randomly generated key, its public key, and a valid signature.

## Using ts-stack in a Monorepo

If you're building a monorepo with multiple packages that all use ts-stack, use pnpm workspaces:

```bash
pnpm init --workspace
```

Create a `pnpm-workspace.yaml` at the root:

```yaml
packages:
  - 'packages/*'
```

Then install all ts-stack packages once at the root and they'll be available in all workspace packages:

```bash
pnpm add -w @bsv/sdk @bsv/wallet-toolbox @bsv/overlay
```

All your workspace packages can now import from these shared dependencies:

```typescript
// In any workspace package
import { PrivateKey } from '@bsv/sdk';
```

## Next Steps

- **[Key Concepts](./concepts.md)** — Understand BEEF, overlays, identity keys
- **[Choose Your Stack](./choose-your-stack.md)** — See which other packages you need
- **[Guides](../guides/index.md)** — Build your first app
