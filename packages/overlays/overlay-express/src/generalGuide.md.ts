export default `\`
# General Guide

## Topic Managers  

A Topic Manager controls addition and removal of transaction outputs to an Overlay Topic. It processes transaction by exposing a /submit endpoint, request should looks something like:

### [POST] /submit

#### Request Headers
\\\`\\\`\\\`json
{
  "x-topics": "["tm_messagebox"]", // array of topic identifiers as stringified JSON
  "x-includes-off-chain-values": "false" // string "true" or "false"
}
\\\`\\\`\\\`

#### Request Body
\\\`\\\`\\\`json
[1,1,1,1... ], // transaction in atomic BEEF format as Uint8Array
\\\`\\\`\\\`

The engine processes this TaggedBEEF and generates a STEAK (Submitted Transaction Execution AcKnowledgment), which is returned to the client.

#### Response Body
\\\`\\\`\\\`json
{
  "tm_messagebox": {
    "outputsToAdmit": [0], // which of the outputs in the BEEF to admit
    "coinsToRetain": [], // which of the inputs in the BEEF to mark spent but keep within the Topic
    "coinsRemoved": [], // which of the inputs in the BEEF to remove from the Topic
  },
  ... // per topic
}
\\\`\\\`\\\`

<br />

## Lookup Services

A Lookup Service is a component that enables data retrieval from the Overlay Services ecosystem. It allows clients to search and retrieve transactions that were previously submitted to Topic Managers, using specific criteria or identifiers.

### [POST] /lookup

#### Request Body
\\\`\\\`\\\`json
{
  "service": "ls_messagebox", // Lookup Service identifier as string,
  "query": "findAll" // query must be a string, JSON queries should be stringified
}
\\\`\\\`\\\`

#### Response Body
\\\`\\\`\\\`json
{
    "type": "output-list",
    "outputs": [{
        "beef": [1, 1, 1...], // number[]
        "outputIndex": 0, // number
        "context"?: [1, 1, 1...], // number[]
    }>]
}
\\\`\\\`\\\`

<br />

## Summary

Usually Topic Managers and Lookup Services are paired, but they can be separated for greater flexibility. Together, they form a complete system for data submission, organization, and retrieval within the Overlay Services framework.

<br />
<br />
\`
`
