# Identity React Components

A library of reusable React components for displaying and searching identity information on the BSV Blockchain.

## Installation

```bash
npm install @bsv/identity-react
```

The consuming app supplies SDK 4.1.2 or later within SDK 4, React 18 or 19,
Material UI and Emotion 11. Identity React uses UHRP React 2 for media resolution.

## Example Usage

#### Identity Card

```ts
import React from 'react'
import { IdentityCard } from '@bsv/identity-react'

const App = () => {
  return (
    <div>
      {/* Display an identity card using a known identity key */}
      <IdentityCard
        identityKey="0240c42181068275a4f996ee570ed7c7a97c30003b174461bca5bad882fc06143f"
        themeMode="light" // optional: 'light' or 'dark'
      />
    </div>
  )
}
```

> **Note:** The `IdentityCard` component caches resolved identities in sessionStorage for 5 minutes and up to 100 identities per session, greatly reducing redundant network requests.

#### Identity Search Field

```ts
import React, { useState } from 'react'
import { IdentitySearchField } from '@bsv/identity-react'
import { DisplayableIdentity } from '@bsv/sdk'

const IdentityDisplay: React.FC = () => {
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity | null>(null)

  return (
    <div>
      {/* Add a search field */}
      <IdentitySearchField
        onIdentitySelected={(identity) => {
          setSelectedIdentity(identity)
        }}
        appName="My App" // optional: for MNC missing dialog
      />
      {selectedIdentity && (
        <div>
          <h2>Selected Identity</h2>
          <p>Name: {selectedIdentity.name}</p>
          <p>Identity Key: {selectedIdentity.identityKey}</p>
        </div>
      )}
    </div>
  )
}
```

> **Note:** The search field provides instant results for cached queries and is debounced (400ms) for new searches to optimize performance.

## Example Headless Usage (useIdentitySearch Hook)

```ts
import React from 'react'
import { useIdentitySearch } from '@bsv/identity-react'
import { DisplayableIdentity } from '@bsv/sdk'

const App = () => {
  const {
    identities,
    isLoading,
    searchError,
    contactWarning,
    retrySearch,
    inputValue,
    selectedIdentity,
    handleInputChange,
    handleSelect,
    clearCache
  } = useIdentitySearch({
    onIdentitySelected: (identity: DisplayableIdentity) => {
      console.log('Selected:', identity.name)
    }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <input
        value={inputValue}
        onChange={event => handleInputChange(event, event.target.value, 'input')}
        placeholder="Search for identities..."
      />

      {isLoading ? (
        <p>Loading identities...</p>
      ) : (
        <>
          {inputValue !== '' && (
            <div>
              {identities.map((identity) => (
                <button
                  key={identity.identityKey}
                  onClick={() => handleSelect(null, identity)}
                  style={{ margin: '4px', padding: '8px' }}
                >
                  {identity.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {selectedIdentity && (
        <div>
          <h2>Selected Identity:</h2>
          <p><strong>Name:</strong> {selectedIdentity.name}</p>
          <img src={selectedIdentity.avatarURL} alt={selectedIdentity.name} width={64} />
          <p style={{ wordWrap: 'break-word' }}>
            <strong>Identity Key:</strong> {selectedIdentity.identityKey}
          </p>
        </div>
      )}

      <button onClick={clearCache} style={{ marginTop: '16px' }}>
        Clear Search Cache
      </button>
    </div>
  )
}

export default App
```

## Identity search recovery (2.0.0)

Version 2 requires SDK 3.2.0 or later, React 18, and Node 22 or later for package
and application tooling. This is an ESM React package for bundler consumers.
The existing components, selection callback and hook fields remain available.
SDK3 removes the obsolete serial-DID token API; applications importing that
separate SDK API must follow its identity-key DID migration guidance. There is
no wallet storage or BRC-100 wire migration in this component release.

Uncached searches explicitly enable optional-contact recovery with a two-second
contact deadline. If Contacts cannot be read, public identity discovery can still
succeed and the field displays a contact warning. Public lookup failures remain
failures: the field displays an error and a **Retry identity search** button,
not a successful empty answer or a synthetic discovered identity. Error text
never includes the raw wallet error or contact details. Public certificate and
wallet permission checks are retained.

`useIdentitySearch` also returns `searchError`, `contactWarning`, and
`retrySearch`. Render those fields in a headless consumer and call `retrySearch()`
to retry the current query. A successful empty lookup has `searchError === null`.
The deadline and abort signal bound result delivery; they do not cancel an
underlying wallet operation or dismiss a wallet prompt.

Only complete successful answers are cached, per hook and wallet/routing
context. Partial answers and errors are not cached. `clearCache()` followed by a
new lookup or `retrySearch()` refreshes the Contacts basket, including contacts
edited through a different client. Pass a stable wallet instance; equivalent
routing-option objects are compared by their scalar values. Later answers from
superseded queries are discarded, including when the new query is a cache hit.

## Caching and Performance

- **Identity Search**: Complete successful results use a cache per hook/context with LRU eviction (max 100 entries) and 5-minute expiry
- **Identity Cards**: Uses sessionStorage-backed cache that persists across page reloads
- **Instant Results**: Cached queries and identities return immediately (0ms response time)
- **Debounced Search**: New searches are debounced by 400ms to prevent excessive API calls
- **Memory Management**: Automatic cache cleanup prevents unbounded memory growth

## License

The license for the code in this repository is the Apache License 2.0.

[Apache License 2.0](./LICENSE)
