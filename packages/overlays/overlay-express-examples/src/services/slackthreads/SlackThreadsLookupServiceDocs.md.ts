export default `
# SlackThread Lookup Service Documentation

The **SlackThread Lookup Service** (service ID: \`ls_slackthread\`) lets clients search the on-chain *SlackThread* messages that are indexed by the **SlackThread Topic Manager**. Each record represents a Pay-to-Push-Drop output whose single field is a UTF-8 message of at least two characters.

## Example
\`\`\`typescript
import { LookupResolver } from '@bsv/sdk'

const overlay = new LookupResolver()

// find all
const response2 = await overlay.query({ 
    service: 'ls_slackthread', 
    query: {} 
}, 10000)

// find by thread hash
const response = await overlay.query({ 
    service: 'ls_slackthread', 
    query: {
        threadHash: 'some 32 byte hash of a thread'
    } 
}, 10000)

// find by txid
const response3 = await overlay.query({ 
    service: 'ls_slackthread', 
    query: {
        txid: 'some txid'
    } 
}, 10000)
\`\`\`
`
