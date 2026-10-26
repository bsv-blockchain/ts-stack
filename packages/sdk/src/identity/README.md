# IdentityClient

**Resolve who others are and let the world know who you are.**

## Overview

`IdentityClient` provides a straightforward interface for resolving and revealing identity certificates. It allows applications to verify user identities through certificates issued by trusted certifiers, reveal identity attributes publicly on the blockchain, and resolving identities associated with given attributes or identity keys.

## Features

- **Selective Attribute Revelation**: Create identity tokens which publicly reveal selective identity attributes and are tracked by overlay services.
- **Identity Resolution**: Easily resolve identity certificates based on identity keys or specific attributes.
- **Displayable Identities**: Parse identity certificates into user-friendly, displayable identities.

## Local contact authority

`ContactsManager` stores identity-key associations that the wallet user or
application has independently validated and deliberately accepted. A saved
contact is authoritative inside that wallet in the same policy sense as a
locally installed trust anchor or accepted self-signed certificate: when
contact lookup is enabled, the saved association may override or short-circuit
third-party overlay discovery.

That authority is intentionally local. Authenticating a contact output proves
that this wallet stored the record; it does not create a certifier signature or
prove the real-world identity to anyone else. Applications should therefore:

- save contacts only after user confirmation or another independent validation
  channel;
- label contact-sourced identity as a local contact, not as externally
  certified;
- never feed unauthenticated network discovery directly into the contacts
  basket; and
- use a fresh overlay query when third-party certificate evidence is required.

Identity resolution does not consult contacts by default. Pass
`{ useContacts: true }` to `resolveByIdentityKey` or `resolveByAttributes` when
the application intends to honor this local authority. With the default
contacts-first mode, a match skips the overlay; `{ parallel: true }` still lets
the contact win while also obtaining a fresh overlay answer.

## Installation

```bash
npm install @bsv/sdk
```

## Usage

### Initialization

```typescript
import { IdentityClient } from '@bsv/sdk'

const identityClient = new IdentityClient()
```

### Publicly Reveal Attributes

```typescript
const broadcastResult = await identityClient.publiclyRevealAttributes(certificate, ['name', 'email'])
```

### Resolve Identity by Key

```typescript
const identities = await identityClient.resolveByIdentityKey({
  identityKey: '<identity-key-here>'
})
```

### Resolve Identity by Attributes

```typescript
const identities = await identityClient.resolveByAttributes({
  attributes: { email: 'user@example.com' }
})
```

## React Example

```ts
import React, { useEffect, useState } from 'react'
import { IdentityClient } from '@bsv/sdk'

const identityClient = new IdentityClient()

function IdentityDisplay({ identityKey }) {
  const [identities, setIdentities] = useState([])

  useEffect(() => {
    async function fetchIdentities() {
      const results = await identityClient.resolveByIdentityKey({ identityKey })
      setIdentities(results)
    }

    fetchIdentities()
  }, [identityKey])

  return (
    <div>
      {identities.map((identity, index) => (
        <div key={index} style={{ border: '1px solid #ccc', padding: '10px', marginBottom: '10px', borderRadius: '5px' }}>
          <img src={identity.avatarURL} alt="Avatar" style={{ width: '50px', height: '50px', borderRadius: '25px' }} />
          <h3>{identity.name}</h3>
          <p>{identity.badgeLabel}</p>
          <a href={identity.badgeClickURL}>Learn More</a>
        </div>
      ))}
    </div>
  )
}

export default IdentityDisplay
```

## License

Open BSV License
