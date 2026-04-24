export default `
# DesktopIntegrity Lookup Service Documentation

The **DesktopIntegrity Lookup Service** (service ID: \`ls_desktopintegrity\`) lets clients search the on-chain *DesktopIntegrity* messages that are indexed by the **DesktopIntegrity Topic Manager**. Each record represents a Pay-to-Push-Drop output whose single field is a UTF-8 message of at least two characters.

## Example
\`\`\`typescript
import { LookupResolver } from '@bsv/sdk'

const overlay = new LookupResolver()

// find all
const response2 = await overlay.query({ 
    service: 'ls_desktopintegrity', 
    query: {} 
}, 10000)

// find by file hash
const response = await overlay.query({ 
    service: 'ls_desktopintegrity', 
    query: {
        fileHash: 'some 32 byte hash of a file'
    } 
}, 10000)

// find by txid
const response3 = await overlay.query({ 
    service: 'ls_desktopintegrity', 
    query: {
        txid: 'some txid'
    } 
}, 10000)
\`\`\`
`
