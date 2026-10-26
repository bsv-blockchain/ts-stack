export default `# SLAP Lookup Service

**Protocol Name**: SLAP (Service Lookup Availability Protocol)  
**Lookup Service Name**: \`SLAPLookupService\`

---

## Overview

The SLAP Lookup Service is an overlay component that answers queries about SLAP advertisements. A SLAP advertisement states that an identity key offers a service (prefixed \`ls_\`) at a given URI. By querying this service, you can find all known SLAP records that match your criteria.

---

## Purpose

- **Discovery**: Find all services that have been advertised with the \`SLAP\` protocol.
- **Filtering**: Narrow results by domain or by the \`ls_\` service name.

---

## How to Query the SLAP Lookup Service

You will typically provide a [LookupQuestion](https://www.npmjs.com/package/@bsv/overlay#lookupservice) object to the \`lookup\` method with:
- \`question.service = 'ls_slap'\`
- \`question.query\` describing the domain and/or service name you want.

### \`question.query\` Options

1. **\`"findAll"\`** (string literal): Returns up to 1,000 SLAP records.
2. **\`SLAPQuery\` object**:
   \`\`\`ts
   interface SLAPQuery {
     findAll?: boolean
     domain?: string
     service?: string
     identityKey?: string
     limit?: number
     skip?: number
     sortOrder?: 'asc' | 'desc'
   }
   \`\`\`
   - \`domain\`: Optional. If provided, only returns records whose \`advertisedURI\` matches this domain.
   - \`service\`: Optional. Must be a string starting with \`ls_\`.
   - \`identityKey\`: Optional compressed secp256k1 public key.
   - \`limit\`: Integer from 0 through 1,000; defaults to 1,000 and zero returns no rows.
   - \`skip\`: Integer from 0 through 1,000,000.
   - \`sortOrder\`: \`asc\` or \`desc\` by creation time; defaults to \`desc\`.

### Example Usages

1. **Find all**:
   \`\`\`js
   const question = {
     service: 'ls_slap',
     query: 'findAll'
   }
   const answers = await overlayClient.lookup(question)
   \`\`\`

2. **Find by domain**:
   \`\`\`js
   const question = {
     service: 'ls_slap',
     query: { domain: 'https://mylookup.example' }
   }
   const answers = await overlayClient.lookup(question)
   \`\`\`

3. **Find by service (most common)**:
   \`\`\`js
   const question = {
     service: 'ls_slap',
     query: { service: 'ls_treasury' }
   }
   const answers = await overlayClient.lookup(question)
   \`\`\`

4. **Find by domain & service**:
   \`\`\`js
   const question = {
     service: 'ls_slap',
     query: {
       domain: 'https://mylookup.example',
       service: 'ls_treasury'
     }
   }
   const answers = await overlayClient.lookup(question)
   \`\`\`

---

## Gotchas

- **Strict Matching**: Domain matching requires an exact string match. If you have a different protocol (https vs https+bsvauth vs https+bsvauth+smf), be sure to store/lookup accordingly.
- **Must Start with \`ls_\`**: The \`service\` field in the original SLAP advertisement must begin with \`ls_\`. If you query for something that doesn’t match exactly, you may get zero results.
- **Bounded Results**: Both the legacy \`"findAll"\` form and object queries return at most 1,000 rows. Use bounded \`limit\` and \`skip\` values to paginate.

---

## Further Reading

- **SLAPTopicManager**: Learn how SLAP outputs are detected and admitted.
- **BRC-101 Overlays**: The higher-level specification for modular overlay availability schemes.
`
