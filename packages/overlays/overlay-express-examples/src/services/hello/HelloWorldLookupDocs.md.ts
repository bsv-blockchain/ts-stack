export default `
# HelloWorld Lookup Service Documentation

## Overview
The **HelloWorld Lookup Service** (service ID: \`ls_helloworld\`) lets clients search the on-chain *Hello-World* messages that are indexed by the **HelloWorld Topic Manager**. Each record represents a Pay-to-Push-Drop output whose single field is a UTF-8 message of at least two characters.

## Example
\`\`\`typescript
import { LookupResolver } from '@bsv/sdk'

const overlay = new LookupResolver()

const response = await overlay.query({ 
    service: 'ls_helloworld', 
    query: {
        limit: 3,
        skip: 0,
        sortOrder: 'desc',
        message: 'Hello Overlay'
    } 
}, 10000)
\`\`\`
`
