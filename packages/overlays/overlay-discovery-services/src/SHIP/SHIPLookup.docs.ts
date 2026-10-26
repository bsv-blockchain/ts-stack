export default `# SHIP Lookup Service

**Protocol Name**: SHIP (Service Host Interconnect Protocol)  
**Lookup Service Name**: \`SHIPLookupService\`  

---

## Overview

The SHIP Lookup Service is used to **query** the known SHIP tokens in your overlay database. It allows you to discover nodes that have published SHIP outputs, indicating they host or participate in certain topics (prefixed \`tm_\`).

This lookup service is typically invoked by sending a [LookupQuestion](https://www.npmjs.com/package/@bsv/overlay#lookupservice) with:
- \`question.service = 'ls_ship'\`
- \`question.query\` containing parameters for searching.

---

## Purpose

- **Discovery**: Find all hosts that declared themselves via SHIP tokens.
- **Filtering**: Narrow results by domain, by topic, or both.

---

## Querying the SHIP Lookup Service

When you call \`lookup(question)\` on the SHIP Lookup Service, you must include:

1. **\`question.service\`** set to \`"ls_ship"\`.
2. **\`question.query\`**: Can be one of the following:
   - \`"findAll"\` (string literal): Returns up to 1,000 known SHIP records.
   - An object of type:
     \`\`\`ts
     interface SHIPQuery {
       findAll?: boolean
       domain?: string
       topics?: string[]
       identityKey?: string
       limit?: number
       skip?: number
       sortOrder?: 'asc' | 'desc'
     }
     \`\`\`
     where:
     - \`domain\` is an optional string. If provided, results will match that domain/advertisedURI.
     - \`topics\` is an optional string array. If provided, results will match any of those \`tm_\` topics.
     - \`identityKey\` is an optional compressed secp256k1 public key.
     - \`limit\` is an integer from 0 through 1,000 and defaults to 1,000. Zero returns no rows.
     - \`skip\` is an integer from 0 through 1,000,000.
     - \`sortOrder\` is \`asc\` or \`desc\` by creation time and defaults to \`desc\`.

### Examples

1. **Find all SHIP records**:
   \`\`\`js
   const question = {
     service: 'ls_ship',
     query: 'findAll'
   }
   const results = await overlayClient.lookup(question)
   \`\`\`

2. **Find by domain**:
   \`\`\`js
   const question = {
     service: 'ls_ship',
     query: { domain: 'https://myexample.com' }
   }
   const results = await overlayClient.lookup(question)
   \`\`\`

3. **Find by topics**:
   \`\`\`js
   const question = {
     service: 'ls_ship',
     query: { topics: ['tm_bridge', 'tm_sync'] }
   }
   const results = await overlayClient.lookup(question)
   \`\`\`

4. **Find by domain AND topics**:
   \`\`\`js
   const question = {
     service: 'ls_ship',
     query: {
       domain: 'https://myexample.com',
       topics: ['tm_bridge']
     }
   }
   const results = await overlayClient.lookup(question)
   \`\`\`

---

## Gotchas and Tips

- **Topic Prefix**: The SHIP manager expects topics to start with \`tm_\`. If you see no results, ensure you used the correct prefix.
- **Strict Matching**: Domain matching requires an exact string match. If you have a different protocol (https vs https+bsvauth vs https+bsvauth+smf), be sure to store/lookup accordingly.
- **Partial Queries**: If you only provide \`topics\`, domain-based filtering is not applied, and vice versa.
- **Multiple Topics**: Since \`topics\` is an array, the storage will return records matching **any** listed topic. The array must contain 1–100 unique valid \`tm_\` names.
- **Bounded Results**: Both the legacy \`"findAll"\` form and object queries return at most 1,000 rows. Use \`limit\` and \`skip\` for explicit pagination.

---

## Further Reading

- **SHIPTopicManager**: For how the outputs are admitted.
- **BRC-101 Overlays**: The general pattern for these sorts of services.
- **SLAP**: The complementary protocol for service lookup availability ads.
`
