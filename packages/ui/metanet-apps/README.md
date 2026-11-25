# Metanet App Catalog

A TypeScript library for publishing and discovering applications on the Metanet.

## Overview

Metanet Apps allows developers to:

- Publish application metadata to the Bitcoin SV blockchain using PushDrop tokens
- Update existing app listings with new metadata
- Discover apps using various search criteria like domain, category, tags, and more
- Build a decentralized app catalog

## Installation

Requires Node.js 22 or later for Node consumers. Publishing, updating, and removing listings require an authorized BRC-100 wallet. Public discovery through explicit overlay hosts does not need wallet access.

```bash
npm install metanet-apps
```

## Basic Usage

### Initializing the App Catalog

```typescript
import {
  AppCatalog,
  DEFAULT_APP_LOOKUP_HOSTS,
  requireAppCatalogBroadcastSuccess,
  type PublishedAppMetadata
} from 'metanet-apps'

const catalog = new AppCatalog({
  // Optional parameters:
  // overlayTopic: 'custom_topic',  // Defaults to 'tm_apps'
  // overlayService: 'custom_service', // Defaults to 'ls_apps'
  // networkPreset: 'mainnet', // or 'testnet', 'local'
  // acceptDelayedBroadcast: false
})
```

### Publishing a New App

```typescript
const appMetadata: PublishedAppMetadata = {
  version: '0.1.0',
  name: 'My Awesome App',
  description: 'This app does amazing things on Metanet',
  icon: 'https://example.com/icon.png',
  httpURL: 'https://myapp.example.com/',
  domain: 'myapp.example.com',
  category: 'utility',
  tags: ['tools', 'productivity'],
  release_date: new Date().toISOString()
}

const result = requireAppCatalogBroadcastSuccess(
  await catalog.publishApp(appMetadata)
)
console.log('Published app:', result)
```

### Finding Apps

```typescript
// Find by domain
const appsByDomain = await catalog.findApps({ domain: 'myapp.example.com' })

// Find one listing directly by immutable outpoint
const [appByOutpoint] = await catalog.findApps({ outpoint: '<txid>.0' })

// Find by category
const utilityApps = await catalog.findApps({ category: 'utility' })

// Find by tags
const productivityApps = await catalog.findApps({ tags: ['productivity'] })

// Find by publisher
const myApps = await catalog.findApps({ publisher: '03abcdef...' })

// Fuzzy search by name
const searchResults = await catalog.findApps({ name: 'awesome' })
```

### Finding Apps Across Overlay Regions

For frontends that need consistent catalog results across regions, query the
known overlay hosts directly and merge valid results. This keeps the standard
`findApps()` path available for existing integrations.

```typescript
const { apps, diagnostics } = await catalog.findAppsAcrossHosts(
  { limit: 500, sortOrder: 'desc' },
  { hosts: DEFAULT_APP_LOOKUP_HOSTS, timeout: 10000 }
)

console.log(apps.length)
console.table(diagnostics.hosts)
```

### Update or remove a listing

Request the current token at its exact outpoint and keep the BEEF required to
spend it. After an update succeeds, look up the replacement token independently
once it has been indexed. Removal spends that current token.

```typescript
const [listing] = await catalog.findApps(
  { outpoint: currentOutpoint },
  { includeBeef: true }
)
if (!listing) throw new Error('The current listing is not available yet.')

const updated = requireAppCatalogBroadcastSuccess(
  await catalog.updateApp(listing, {
    ...listing.metadata,
    description: 'Updated description'
  })
)
console.log('Update accepted:', updated.txid)

// Run after the replacement has been indexed and you intend to remove it.
const [replacement] = await catalog.findApps(
  { outpoint: replacementOutpoint },
  { includeBeef: true }
)
if (!replacement) throw new Error('The replacement listing is not available yet.')
requireAppCatalogBroadcastSuccess(await catalog.removeApp(replacement))
```

`currentOutpoint` and `replacementOutpoint` are the exact `txid.outputIndex`
strings returned by your indexer. Check a resolved broadcast failure with
`requireAppCatalogBroadcastSuccess` and reconcile the outpoint before trying
another wallet action. See the [offline lifecycle fixture](./src/lifecycle.test.ts)
for a runnable example that uses the SDK to sign, serialize, look up, update
and spend a listing without submitting live transactions.

## API Reference

### `AppCatalog`

The main class for interacting with the Metanet Apps ecosystem.

#### Constructor

```typescript
new AppCatalog(options: AppCatalogOptions)
```

- `options.overlayTopic?`: Optional custom overlay topic (defaults to "tm_apps")
- `options.overlayService?`: Optional custom overlay service (defaults to "ls_apps")
- `options.wallet?`: Optional pre-configured wallet
- `options.networkPreset?`: Optional network preset ("mainnet" | "testnet" | "local")
- `options.acceptDelayedBroadcast?`: Optional broadcast options (defaults to false)

#### Methods

- `publishApp(metadata: PublishedAppMetadata, opts?: { wallet?: WalletInterface }): Promise<BroadcastResponse | BroadcastFailure>`: Publishes an app to the overlay network. Pass the result to `requireAppCatalogBroadcastSuccess` before displaying success.
- `updateApp(prev: PublishedApp, newMetadata: PublishedAppMetadata): Promise<BroadcastResponse | BroadcastFailure>`: Updates an existing app listing
- `removeApp(prev: PublishedApp): Promise<BroadcastResponse | BroadcastFailure>`: Removes an app listing from the overlay network
- `findApps(query?: AppCatalogQuery, opts?: AppCatalogFindOptions): Promise<PublishedApp[]>`: Searches for apps based on the provided query with support for pagination and sorting. If `opts.hosts` is supplied, it queries and merges those hosts directly.
- `findAppsAcrossHosts(query?: AppCatalogQuery, opts?: AppCatalogFindOptions): Promise<AppCatalogFindAcrossHostsResult>`: Queries explicit overlay hosts, merges valid apps, deduplicates them, and returns per-host diagnostics.

## Types

### `AppCatalogQuery`

Query options for finding apps:

```typescript
interface AppCatalogQuery {
  outpoint?: string
  domain?: string
  publisher?: string // PubKeyHex
  name?: string
  category?: string
  tags?: string[]
  limit?: number
  skip?: number
  sortOrder?: 'asc' | 'desc'
  startDate?: string
  endDate?: string
}
```

### `PublishedAppMetadata`

Metadata for a published app:

```typescript
interface PublishedAppMetadata {
  version: '0.1.0'
  name: string
  description: string
  icon: string // URL or UHRP
  httpURL?: string
  uhrpURL?: string
  domain: string
  publisher?: string // Automatically set by the library from wallet's identity key
  short_name?: string
  category?: string
  tags?: string[]
  release_date: string // ISO‑8601
  changelog?: string
  banner_image_url?: string
  screenshot_urls?: string[]
}
```

The v0.1 shape is the canonical Apps metadata contract. Publisher names and
profiles are resolved from the `publisher` identity key through BRC-100
identity discovery and selectively disclosed certificates; they are not copied
into app metadata. The protocol and canonical signing derivation are exported
as `METANET_APPS_PROTOCOL` and `METANET_APPS_KEY_ID`; Apps overlays verify key
ID `"1"`.

### `PublishedApp`

A published app with its metadata and token information:

```typescript
interface PublishedApp {
  metadata: PublishedAppMetadata
  token: {
    txid: string
    outputIndex: number
    lockingScript: string
    satoshis: number
    beef?: number[]
  }
}
```

## License

This project is licensed under the [Apache License 2.0](LICENSE).

## Author

Peer-to-peer Privacy Systems Research, LLC
